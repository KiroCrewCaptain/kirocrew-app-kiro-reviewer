// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Chat card for Kiro Crew (MCP Apps): pure functions from a tool result to an HTML string. Every value that
// comes from a tool result, and so ultimately from the model, goes through esc() before it reaches the markup.
import {
  buildFixPrompt,
  buildHandoff,
  groupCounts,
  iterationDelta,
  severityRank,
  SEVERITIES,
  shortId,
} from '../ui/lib.mjs';

export const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const TERMINAL = ['COMPLETED', 'PARTIAL', 'FAILED'];
const SHOWN_FINDINGS = 6;

const isReview = (d) => d && typeof d === 'object' && d.reviewId && d.iteration && Array.isArray(d.findings);
const isPrepared = (d) => d && typeof d === 'object' && d.preparedId && d.payloadDigest && d.summaryMarkdown;

/** Which card a structured tool result gets, or null when it has none. */
export function cardKind(d) {
  if (isReview(d)) return 'review';
  if (isPrepared(d)) return Array.isArray(d.decisions) ? 'context' : 'prepare';
  return null;
}

function tone(it) {
  if (it.status === 'FAILED') return 'bad';
  if (it.status === 'PARTIAL' || it.outcome === 'INCOMPLETE') return 'warn';
  if (it.status === 'COMPLETED') return it.outcome === 'FINDINGS' ? 'warn' : 'ok';
  return 'run';
}

function banner(d) {
  const it = d.iteration;
  const terminal = TERMINAL.includes(it.status);
  if (d.needsContext) {
    return [
      'run',
      'Waiting for context the reviewer requested',
      'The agent is sending it now. After the deadline the review continues without it.',
    ];
  }
  if (!terminal)
    return [
      'run',
      it.status === 'QUEUED' ? 'Review queued' : 'Review running',
      'Ask for the result again in a moment.',
    ];
  if (it.outcome === 'INCOMPLETE') {
    const why = it.error ? `${it.error.code}${it.error.stage ? ` in ${it.error.stage}` : ''}` : `status ${it.status}`;
    return ['warn', `Incomplete (${it.status})`, `${why}. These results are not a clean review.`];
  }
  if (it.outcome === 'NO_FINDINGS') {
    return ['ok', 'Completed with no findings', 'A review with no findings does not mean the code is defect-free.'];
  }
  const k = it.counts;
  return [
    'warn',
    `${k.active} active finding${k.active === 1 ? '' : 's'}`,
    k.blocking
      ? `Fix the ${k.blocking} blocking finding${k.blocking === 1 ? '' : 's'} before you open a CR or PR.`
      : 'None are blocking.',
  ];
}

const open = (f) => f.state !== 'RESOLVED' && !f.suppressed;
const range = (f) => (f.endLine > f.startLine ? `${f.startLine}-${f.endLine}` : `${f.startLine}`);
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', nit: 'Nit' };
const sevCell = (s) =>
  `<span class="sev t-${esc(s)}"><span class="dot c-${esc(s)}"></span>${esc(SEV_LABEL[s] || s)}</span>`;
const shortPath = (f) => {
  const parts = String(f.file).split('/');
  return `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}:${range(f)}`;
};

function findingHtml(f) {
  if (f.suppressed) {
    return `<details class="row sup"><summary title="${esc(f.file)}:${esc(range(f))}">${sevCell(f.severity)}<div class="grow"><div class="ft">${esc(f.title)}</div><div class="why">${esc(f.suppressionReason ? `Suppressed: ${f.suppressionReason}` : 'Suppressed, no reason given')}</div></div><span class="where">${esc(shortPath(f))}</span></summary></details>`;
  }
  const tags = [
    f.blocking ? '<span class="tag block">blocking</span>' : '',
    f.state === 'NEW' ? '<span class="tag new">new</span>' : '',
  ].join('');
  const body = [
    `<div class="loc">${esc(f.file)}:${esc(range(f))}</div>`,
    `<div class="prose">${esc(f.explanation)}</div>`,
    f.suggestion ? `<div class="h">Suggestion</div><div class="code">${esc(f.suggestion)}</div>` : '',
    f.dismissedByAuthor
      ? `<div class="note">Blocking, dismissed by author (${esc(f.dismissalDisposition || 'dismissed')}). Still counted as blocking.</div>`
      : '',
    f.claimedFixedStillPresent ? '<div class="note">Claimed fixed, but the finding is still present.</div>' : '',
    `<div class="tags"><span class="tag mono">${esc(f.findingId)}</span>${f.category ? `<span class="tag">${esc(f.category)}</span>` : ''}${f.state === 'PERSISTING' ? '<span class="tag">still open</span>' : ''}${f.confidence != null ? `<span class="tag">${Math.round(f.confidence * 100)}% confidence</span>` : ''}</div>`,
  ].join('');
  return `<details class="row"><summary>${sevCell(f.severity)}<span class="grow ft">${esc(f.title)}</span>${tags}<span class="where">${esc(shortPath(f))}</span><span class="chev">▶</span></summary><div class="fb">${body}</div></details>`;
}

function reviewHtml(d) {
  const it = d.iteration;
  const [t, title, text] = banner(d);
  const k = it.counts;
  const terminal = TERMINAL.includes(it.status);
  const delta = terminal ? iterationDelta({ ...d, terminal }) : null;
  const active = d.findings.filter(open);
  const bySev = groupCounts(active, (f) => f.severity);
  const total = active.length || 1;
  const sorted = [...d.findings]
    .filter((f) => f.state !== 'RESOLVED')
    .sort(
      (a, b) =>
        Number(a.suppressed) - Number(b.suppressed) ||
        Number(b.blocking) - Number(a.blocking) ||
        severityRank(a.severity) - severityRank(b.severity) ||
        a.file.localeCompare(b.file) ||
        a.startLine - b.startLine,
    );
  const shown = sorted.slice(0, SHOWN_FINDINGS);
  const more = sorted.length - shown.length;
  const blocking = active.filter((f) => f.blocking);
  const stat = (n, label, cls) =>
    `<span class="stat${n && cls ? ` ${cls}` : ''}"><b>${esc(n)}</b><span>${label}</span></span>`;
  return `
<div class="top"><span class="dot ${t}"></span><span class="title">${esc(title)}</span><span class="grow"></span><span class="meta mono">${esc(shortId(d.reviewId))}</span><span class="meta">· iteration ${esc(it.number)} of ${esc(d.iterationBudget)} · ${esc(d.level)}</span></div>
<div class="sub">${esc(text)}</div>
${terminal && it.outcome !== 'INCOMPLETE' ? `<div class="stats">${stat(k.blocking, 'blocking', 'crit')}${stat(k.active, 'active')}${stat(k.suppressed, 'suppressed')}${stat(k.resolved, 'resolved', 'okc')}</div>` : ''}
${
  active.length
    ? `<div class="bar">${SEVERITIES.filter((s) => bySev[s])
        .map((s) => `<i class="c-${s}" style="width:${(bySev[s] / total) * 100}%" title="${s}: ${bySev[s]}"></i>`)
        .join('')}</div>`
    : ''
}
${delta ? `<div class="delta">Since iteration ${delta.since}: <b>${delta.fresh}</b> new · <b>${delta.persisting}</b> still open · <b>${delta.resolved}</b> resolved</div>` : ''}
${shown.length ? `<div class="list">${shown.map(findingHtml).join('')}</div>${more > 0 ? `<div class="more">${more} more in the Kiro Reviewer page.</div>` : ''}` : ''}
${terminal ? `<div class="actions">${blocking.length ? `<button class="primary" data-act="fix">Copy fix prompt (${blocking.length})</button>` : ''}<button data-act="handoff">Copy for CR/PR</button><span class="grow"></span><span class="meta">Full review: Apps › Kiro Reviewer</span></div>` : ''}`;
}

function preparedHtml(d, context) {
  const s = d.summary || null;
  const rows = [];
  if (s) {
    rows.push(
      ['Repository', s.repo],
      ['Base', `${s.base} @ ${String(s.baseSha).slice(0, 12)}`],
      ['Head', `${s.head} @ ${String(s.headSha).slice(0, 12)}${s.includeUncommitted ? ' (working tree)' : ''}`],
    );
    rows.push([
      'Diff',
      `${s.files.length} file${s.files.length === 1 ? '' : 's'}, ${s.changedLines} changed lines, ${s.diffBytes} bytes`,
    ]);
    rows.push(['REVIEW.md', s.rules.reviewMd ? 'from the merge-base' : 'none']);
    if (s.contextFiles.length) rows.push(['Context files', s.contextFiles.map((c) => c.path).join(', ')]);
    if (s.level)
      rows.push(['Level', `${s.level}${s.iterationBudget ? `, up to ${s.iterationBudget} iterations` : ''}`]);
    if (s.reviewId) rows.push(['Resubmit', s.reviewId]);
  }
  if (context) rows.push(['Deadline', d.expiresAt || 'about 2 minutes']);
  const red = s ? s.redactions.length : 0;
  const decisions = context
    ? `<div class="list">${d.decisions
        .map(
          (x) =>
            `<details class="row sup"><summary><span class="sev">${esc(x.decision)}</span><div class="grow"><div class="ft mono">${esc(x.requestId)}</div>${x.localReason ? `<div class="why">${esc(x.localReason)}</div>` : ''}</div><span class="where">${esc(x.bytes)} B</span></summary></details>`,
        )
        .join('')}</div>`
    : '';
  const files =
    s && s.files.length
      ? `<div class="list" style="margin-top:10px"><details class="row"><summary><span class="grow ft">Files in this payload</span><span class="tag">${s.files.length}</span><span class="chev">▶</span></summary><div class="fb" style="padding-left:12px">${s.files
          .slice(0, 50)
          .map(
            (f) =>
              `<div class="loc">${esc(f.status)} ${esc(f.path)} <span class="t-low">+${esc(f.added)}</span> <span class="t-critical">−${esc(f.removed)}</span></div>`,
          )
          .join('')}</div></details></div>`
      : '';
  return `
<div class="top"><span class="dot warn"></span><span class="title">${context ? 'Context the reviewer requested' : 'Code review payload'}</span><span class="grow"></span><span class="meta">not sent yet · digest <span class="mono">${esc(String(d.payloadDigest).slice(0, 12))}</span></span></div>
<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<div class="meta">${red ? `${red} possible secret${red === 1 ? '' : 's'} redacted before sending.` : 'No secrets were detected by the redaction check.'}</div>
${decisions}${files}
<div class="callout"><span><b>Nothing has been sent.</b> Reply <b>yes</b> in the chat to send exactly this.</span></div>`;
}

/** The inner HTML of the card for a structured tool result, or null when there is no card for it. */
export function renderCard(d) {
  const kind = cardKind(d);
  if (kind === 'review') return reviewHtml(d);
  if (kind === 'prepare') return preparedHtml(d, false);
  if (kind === 'context') return preparedHtml(d, true);
  return null;
}

/** The text a copy button puts on the clipboard. */
export function copyText(d, action) {
  if (!isReview(d)) return '';
  const terminal = TERMINAL.includes(d.iteration.status);
  if (action === 'fix') {
    return buildFixPrompt(
      d.findings.filter((f) => open(f) && f.blocking),
      d,
    );
  }
  return buildHandoff({ ...d, terminal }, null);
}
