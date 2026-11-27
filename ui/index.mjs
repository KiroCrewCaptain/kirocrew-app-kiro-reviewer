// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Kiro Reviewer page for Kiro Crew. Plain ESM, no build step: React and the app SDK come from the host.
// All review text (titles, explanations, reasons) is untrusted model output and is only ever rendered as React text.
import {
  bandCounts,
  buildFixPrompt,
  buildHandoff,
  gateSummary,
  filePath,
  formatDuration,
  iterationDelta,
  groupCounts,
  apiErrorCode,
  needsKiroSignIn,
  parseApiError,
  parseUnifiedDiff,
  placeFindings,
  relTime,
  reviewBand,
  severityRank,
  shortId,
  SEVERITIES,
} from './lib.mjs';

const React = window.__kirocrew_modules.react;
const { useAppApi, useChatLauncher, useNavigate } = window.__kirocrew_modules['@kirocrew/app-sdk'];
const { useState, useEffect, useCallback, useMemo, useRef, createElement: h } = React;

const API = '/apps/kiro-code-reviewer/api';
const POLL_MS = 5000;
const LIST_STATUS_MAX = 10;
const REASON_MAX = 500;

const CSS = `
.kcr{--kcr-accent:#9046ff;--kcr-accent-soft:#9046ff26;--kcr-accent-text:#c2a0fd;
  --sev-critical:#ff8080;--sev-high:#ffcf99;--sev-medium:#fff2b3;--sev-low:#8dc8fb;--sev-nit:#a1a1aa;
  color:var(--text,#e4e4e7);font:14px/1.5 -apple-system,"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column;height:100%;min-height:0}
.kcr *{box-sizing:border-box}
.kcr button{font:inherit;color:inherit}
.kcr-head{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid var(--border,#27272a)}
.kcr-region{width:auto;cursor:pointer}
.kcr-title{font-size:18px;font-weight:600;color:var(--text-strong,#fafafa);letter-spacing:-.2px}
.kcr-sub{color:var(--muted,#7f7f88);font-size:12px}
.kcr-spacer{flex:1}
.kcr-main{overflow-y:auto;padding:20px 24px 40px;min-width:0;flex:1}
.kcr-input,.kcr-textarea{background:var(--bg,#12141a);color:var(--text,#e4e4e7);border:1px solid var(--border,#27272a);border-radius:8px;padding:7px 10px;font:inherit;font-size:12px;min-width:0;width:100%}
.kcr-input:focus,.kcr-textarea:focus{outline:none;border-color:var(--kcr-accent);box-shadow:0 0 0 3px var(--kcr-accent-soft)}
.kcr-btn{background:var(--bg-elevated,#1a1d25);border:1px solid var(--border,#27272a);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;white-space:nowrap;transition:border-color .15s,background .15s}
.kcr-btn:hover:not(:disabled){border-color:var(--border-hover,#52525b);background:var(--bg-hover,#262a35)}
.kcr-btn:disabled{opacity:.5;cursor:default}
.kcr-btn.primary{background:var(--kcr-accent);border-color:var(--kcr-accent);color:#fff;font-weight:600}
.kcr-btn.primary:hover:not(:disabled){background:#a265ff;border-color:#a265ff}
.kcr-btn.danger{border-color:#ef444466;color:#ff8080}
.kcr-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--muted,#7f7f88)}
.kcr-dot.ok{background:var(--ok,#22c55e)}.kcr-dot.bad{background:var(--danger,#ef4444)}.kcr-dot.warn{background:var(--warn,#eab308)}
.kcr-dot.run{background:var(--kcr-accent);animation:kcrpulse 1.4s ease-in-out infinite}
@keyframes kcrpulse{50%{opacity:.35}}
.kcr-card{background:var(--card,#181b22);border:1px solid var(--border,#27272a);border-radius:14px}
.kcr-banner{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-radius:12px;border:1px solid var(--border,#27272a);background:var(--card,#181b22);margin-bottom:16px}
.kcr-banner.ok{border-color:#22c55e55;background:#22c55e12}.kcr-banner.bad{border-color:#ef444466;background:#ef44441a}
.kcr-banner.warn{border-color:#eab30866;background:#eab3081a}.kcr-banner.run{border-color:#9046ff66;background:var(--kcr-accent-soft)}
.kcr-banner b{display:block;color:var(--text-strong,#fafafa)}
.kcr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px}
.kcr-stat{padding:12px 16px}
.kcr-stat-l{color:var(--muted,#7f7f88);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.kcr-stat-v{font-size:26px;font-weight:700;line-height:1.2;color:var(--text-strong,#fafafa)}
.kcr-sevbar{display:flex;height:8px;border-radius:99px;overflow:hidden;background:var(--bg-hover,#262a35);margin:8px 0 6px}
.kcr-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--muted,#7f7f88)}
.kcr-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.kcr-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 16px}
.kcr-tab{display:flex;align-items:center;gap:7px;padding:5px 12px;border-radius:99px;border:1px solid var(--border,#27272a);background:transparent;cursor:pointer;font-size:12px}
.kcr-tab.sel{background:var(--kcr-accent-soft);border-color:#9046ff88;color:var(--kcr-accent-text)}
.kcr-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;border:1px solid var(--border,#27272a);color:var(--muted,#7f7f88);white-space:nowrap}
.kcr-filter{padding:4px 11px;border-radius:99px;border:1px solid var(--border,#27272a);background:transparent;cursor:pointer;font-size:12px;color:var(--muted,#7f7f88)}
.kcr-filter.sel{background:var(--kcr-accent);border-color:var(--kcr-accent);color:#fff}
.kcr-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:20px 0 12px}
.kcr-finding{margin-bottom:10px;overflow:hidden}
.kcr-finding.sup{opacity:.6;background:transparent;border-style:dashed}
.kcr-sup-row{display:flex;gap:8px;align-items:center;padding:6px 12px;width:100%;background:transparent;border:0;cursor:pointer;text-align:left}
.kcr-sup-row:hover{background:var(--card-hl,#ffffff0d)}
.kcr-finding.sup .kcr-fbody{opacity:.9}
.kcr-sup-why{color:var(--muted,#7f7f88);font-size:12px;overflow-wrap:anywhere}
.kcr-finding.sup .kcr-sev{min-width:0;padding:1px 6px;font-size:10px;background:var(--bg-hover,#262a35)!important;color:var(--muted,#7f7f88)}
.kcr-finding.sup .kcr-ftitle{font-weight:400;font-size:12px;color:var(--muted,#7f7f88);text-decoration:line-through;text-decoration-color:var(--muted-strong,#52525b)}
.kcr-sup-tag{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted,#7f7f88);border:1px solid var(--border-strong,#3f3f46);border-radius:6px;padding:1px 6px;white-space:nowrap}
.kcr-fhead{display:flex;gap:10px;align-items:center;width:100%;padding:12px 16px;background:transparent;border:0;cursor:pointer;text-align:left}
.kcr-fhead:hover{background:var(--card-hl,#ffffff0d)}
.kcr-sev{flex-shrink:0;min-width:64px;text-align:center;padding:2px 8px;border-radius:7px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#18181b}
.kcr-ftitle{font-weight:600;color:var(--text-strong,#fafafa);overflow-wrap:anywhere}
.kcr-floc{color:var(--muted,#7f7f88);font:11px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.kcr-fbody{padding:4px 16px 16px;border-top:1px solid var(--border,#27272a)}
.kcr-prose{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}
.kcr-code{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg,#12141a);border:1px solid var(--border,#27272a);border-left:3px solid var(--kcr-accent);border-radius:8px;padding:10px 12px;margin:8px 0 12px}
.kcr-h{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted,#7f7f88);margin-top:12px}
.kcr-thread{border-left:2px solid var(--border-strong,#3f3f46);padding-left:12px;margin:6px 0}
.kcr-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.kcr-notes{margin:0 0 16px;padding:0;list-style:none;color:var(--muted,#7f7f88);font-size:12px}
.kcr-notes li{padding:3px 0;overflow-wrap:anywhere}
.kcr-empty{text-align:center;color:var(--muted,#7f7f88);padding:48px 16px}
.kcr-spinner{display:inline-block;width:22px;height:22px;margin-bottom:12px;border:2px solid var(--border,#27272a);border-top-color:var(--kcr-accent);border-radius:50%;animation:kcrspin .8s linear infinite}
@keyframes kcrspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.kcr-spinner{animation:kcrpulse 1.6s ease-in-out infinite}}
.kcr-err{color:var(--danger,#ef4444);font-size:12px;margin:8px 0}
.kcr-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--bg-elevated,#1a1d25);border:1px solid #9046ff88;border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 12px 28px #00000059;z-index:60}
.kcr-req{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;margin-top:8px}
.kcr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.kcr-sections{display:flex;gap:2px;border-bottom:1px solid var(--border,#27272a);margin:20px 0 4px}
.kcr-section{background:transparent;border:0;border-bottom:2px solid transparent;padding:8px 14px;cursor:pointer;font-size:13px;color:var(--muted,#7f7f88);margin-bottom:-1px}
.kcr-section.sel{color:var(--text-strong,#fafafa);border-bottom-color:var(--kcr-accent);font-weight:600}
.kcr-diff{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--border,#27272a);border-radius:8px;overflow:auto;background:var(--bg,#12141a);margin:8px 0}
.kcr-dl{display:grid;grid-template-columns:44px 44px 16px 1fr;min-width:max-content}
.kcr-dl span{padding:0 6px;white-space:pre}
.kcr-dl .n{color:var(--muted-strong,#52525b);text-align:right;user-select:none}
.kcr-dl.add{background:var(--diff-add,#2ea04326)}.kcr-dl.add .t,.kcr-dl.add .s{color:var(--diff-add-text,#7ee787)}
.kcr-dl.del{background:var(--diff-del,#f8514926)}.kcr-dl.del .t,.kcr-dl.del .s{color:var(--diff-del-text,#ffa198)}
.kcr-dl.meta .t{color:var(--muted,#7f7f88);font-style:italic}
.kcr-dl.hit{box-shadow:inset 3px 0 0 var(--kcr-accent)}
.kcr-hunk{background:var(--diff-hunk,#04755833);color:var(--muted,#7f7f88);padding:2px 10px;white-space:pre}
.kcr-file{margin-bottom:10px;overflow:hidden}
.kcr-file-head{display:flex;gap:10px;align-items:center;width:100%;padding:10px 14px;background:transparent;border:0;cursor:pointer;text-align:left}
.kcr-file-head:hover{background:var(--card-hl,#ffffff0d)}
.kcr-file-body{padding:0 14px 12px}
.kcr-add{color:var(--diff-add-text,#7ee787)}.kcr-del{color:var(--diff-del-text,#ffa198)}
.kcr-seg{margin:0;border-radius:0;border-top:0}
.kcr-seg-head{border:1px solid var(--border,#27272a);border-radius:8px 8px 0 0;margin-top:8px}
.kcr-inline{padding:8px 0 8px 24px;border-left:3px solid var(--kcr-accent);margin:0 0 0 12px}
.kcr-inline .kcr-finding{margin-bottom:6px}
.kcr-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
.kcr-vote{background:transparent;border:1px solid var(--border,#27272a);border-radius:99px;padding:3px 10px;cursor:pointer;font-size:12px;color:var(--muted,#7f7f88)}
.kcr-vote:hover:not(:disabled){border-color:var(--border-hover,#52525b);color:var(--text,#e4e4e7)}
.kcr-vote.sel{background:var(--kcr-accent-soft);border-color:#9046ff88;color:var(--kcr-accent-text)}
.kcr-reasons{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.kcr-delta{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin:-6px 0 16px;color:var(--muted,#7f7f88)}
.kcr-delta b{color:var(--text-strong,#fafafa);font-weight:600}
.kcr-kv{display:grid;grid-template-columns:140px 1fr;gap:6px 14px;font-size:13px;padding:12px 16px}
.kcr-kv dt{color:var(--muted,#7f7f88)}.kcr-kv dd{margin:0;overflow-wrap:anywhere}
/* overview: Sage-style banded list */
.kcr-ov-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.kcr-ov-sum{color:var(--muted,#7f7f88);font-size:13px}
.kcr-track{display:flex;gap:6px;margin-left:auto;width:min(340px,100%)}
.kcr-bands{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.kcr-band{display:inline-flex;align-items:center;gap:7px;padding:6px 14px;border-radius:99px;border:1px solid var(--border,#27272a);background:var(--card,#181b22);cursor:pointer;font-size:13px}
.kcr-band .n{color:var(--muted,#7f7f88)}
.kcr-band:hover{border-color:var(--border-hover,#52525b)}
.kcr-band.sel{background:var(--kcr-accent-soft);border-color:var(--kcr-accent);color:var(--kcr-accent)}
.kcr-band.sel .n{color:var(--kcr-accent)}
.kcr-dot.red{background:var(--danger,#ef4444)}.kcr-dot.yellow{background:var(--warn,#eab308)}.kcr-dot.green{background:var(--ok,#22c55e)}
.kcr-rows{overflow:hidden}
.kcr-row{display:grid;grid-template-columns:auto 1fr auto;gap:2px 12px;align-items:start;padding:16px 20px;cursor:pointer}
.kcr-rows > .kcr-rowwrap + .kcr-rowwrap{border-top:1px solid var(--border,#27272a)}
.kcr-row:hover{background:var(--card-hl,#ffffff0d)}
.kcr-row:focus-visible{outline:2px solid var(--kcr-accent);outline-offset:-2px}
.kcr-num{color:var(--kcr-accent);font-size:15px;line-height:22px}
.kcr-row-title{display:flex;align-items:center;gap:10px;min-width:0}
.kcr .kcr-row-name{background:none;border:0;padding:0;cursor:pointer;font-weight:600;font-size:15px;line-height:22px;color:var(--text-strong,#fafafa);text-align:left;overflow-wrap:anywhere}
.kcr .kcr-row-name:hover{text-decoration:underline;text-decoration-color:var(--kcr-accent)}
.kcr-row-when{color:var(--muted,#7f7f88);font-size:12px;white-space:nowrap;line-height:22px;display:flex;align-items:center;gap:10px}
.kcr-chev{display:inline-block;font-size:16px;transition:transform .15s}
.kcr-chev.open{transform:rotate(90deg)}
.kcr-row-sub{grid-column:2;color:var(--muted,#7f7f88);font-size:12px;overflow-wrap:anywhere}
.kcr-pills{grid-column:2;display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.kcr-pill{display:inline-flex;align-items:center;padding:2px 10px;border-radius:99px;border:1px solid var(--border,#27272a);font-size:12px;color:var(--muted,#7f7f88);white-space:nowrap}
.kcr-pill.red,.kcr-pill.yellow,.kcr-pill.green{border-color:transparent}
.kcr-pill.red{color:var(--danger,#ef4444);background:color-mix(in srgb,var(--danger,#ef4444) 14%,transparent)}
.kcr-pill.yellow{color:var(--warn,#eab308);background:color-mix(in srgb,var(--warn,#eab308) 14%,transparent)}
.kcr-pill.green{color:var(--ok,#22c55e);background:color-mix(in srgb,var(--ok,#22c55e) 14%,transparent)}
.kcr-gate{margin:0 20px 18px;border:1px solid var(--border,#27272a);border-radius:12px;padding:14px 16px}
.kcr-gate-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#7f7f88)}
.kcr-gate-h.red{color:var(--danger,#ef4444)}.kcr-gate-h.green{color:var(--ok,#22c55e)}.kcr-gate-h.yellow{color:var(--warn,#eab308)}.kcr-gate-h.run{color:var(--kcr-accent-text)}
.kcr-gate-d{margin-top:6px;font-size:13px}
.kcr-gate-f{display:flex;gap:10px;align-items:baseline;margin-top:10px;padding-top:10px;border-top:1px solid var(--border,#27272a)}
.kcr-gate-f .kcr-sev{min-width:0}
.kcr-gate-more{margin-top:8px;color:var(--muted,#7f7f88);font-size:12px}
.kcr-key{margin-bottom:20px;padding:16px 20px}
.kcr-tabs{display:flex;gap:2px;padding:3px;border:1px solid var(--border,#27272a);border-radius:12px}
.kcr .kcr-tab{background:none;border:1px solid transparent;border-radius:9px;padding:6px 14px;font-size:13px;cursor:pointer;color:var(--muted,#7f7f88)}
.kcr .kcr-tab.on{background:var(--bg-elevated,#1a1d25);border-color:var(--border,#27272a);color:var(--kcr-accent-text);font-weight:600}
.kcr-key-h{display:flex;align-items:center;gap:10px}
.kcr-key-t{font-size:15px;font-weight:600;color:var(--text-strong,#fafafa)}
.kcr-key-p{color:var(--muted,#7f7f88);font-size:12px;margin:6px 0 12px}
.kcr-key-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.kcr-key-row .kcr-input{flex:1;min-width:220px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.kcr-key-cur{padding:7px 10px;border:1px solid var(--border,#27272a);border-radius:8px;background:var(--bg-elevated,#1a1d25);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.kcr-back{margin-bottom:14px}
`;

function useStyle() {
  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-kcr', '');
    el.textContent = CSS;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);
}

const sevColor = (s) => `var(--sev-${s})`;

function statusTone(status, outcome) {
  if (status === 'FAILED') return 'bad';
  if (status === 'PARTIAL' || outcome === 'INCOMPLETE') return 'warn';
  if (status === 'COMPLETED') return outcome === 'FINDINGS' ? 'warn' : 'ok';
  return 'run';
}

function Dot({ tone }) {
  return h('span', { className: `kcr-dot ${tone || ''}` });
}

function Chip({ children, color, title }) {
  return h(
    'span',
    { className: 'kcr-chip', title, style: color ? { color, borderColor: color + '66' } : undefined },
    children,
  );
}

/** Kiro Crew's own sign-in control (Settings → Agent → Kiro sign-in). */
const KIRO_SIGN_IN_ROUTE = '/settings/agent?highlight=agent.kiro-sign-in';
/** Kiro regions the page can show; the backend maps each to its BFF. */
const KIRO_REGIONS = [
  ['us-east-1', 'US East (N. Virginia)'],
  ['eu-central-1', 'Europe (Frankfurt)'],
];

function SignInBanner({ onSignIn }) {
  return h('div', { className: 'kcr-banner warn', style: { alignItems: 'center' } }, [
    h('div', { key: 't', style: { flex: 1 } }, [
      h('b', { key: 'b' }, 'Sign in with Kiro to see your reviews'),
      h(
        'span',
        { key: 's', style: { color: 'var(--muted,#7f7f88)' } },
        'Kiro Reviewer uses your Kiro Crew sign-in. Sign in, then come back to this page.',
      ),
    ]),
    h('button', { key: 'go', className: 'kcr-btn primary', onClick: onSignIn }, 'Sign in with Kiro'),
  ]);
}

/* ---------- review overview ---------- */

const BAND_LABELS = { red: 'Needs review', yellow: 'Worth a glance', green: 'Clean', run: 'In progress' };
const GATE_ICON = h(
  'svg',
  {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  h('path', {
    d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  }),
);
const GATE_MAX_FINDINGS = 3;
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function rowPills(s) {
  if (!s) return [];
  const out = [];
  if (s.level) out.push(['l', '', capitalize(s.level), 'Review depth']);
  if (s.iteration) {
    out.push([
      'i',
      '',
      `Iteration ${s.iteration}${s.budget ? ` of ${s.budget}` : ''}`,
      'Review rounds used of the rounds allowed',
    ]);
  }
  if (s.status === 'FAILED') out.push(['f', 'red', 'failed']);
  if (s.blocking > 0) out.push(['b', 'red', `${s.blocking} blocking`, 'Must be fixed before merge']);
  if (s.active - s.blocking > 0) {
    out.push(['a', 'yellow', `${s.active - s.blocking} should-fix`, 'Worth fixing, does not block the merge']);
  }
  if (s.suppressed > 0) out.push(['s', '', `${s.suppressed} suppressed`, 'Dismissed by you']);
  if (s.resolved > 0) out.push(['r', 'green', `${s.resolved} resolved`, 'Fixed in a later round']);
  return out.map(([k, tone, text, title]) => h('span', { key: k, className: `kcr-pill ${tone}`, title }, text));
}

function Gate({ review, onOpen }) {
  if (!review) return h('div', { className: 'kcr-gate' }, h('div', { className: 'kcr-sub' }, 'Loading…'));
  const g = gateSummary(review);
  const open = review.findings
    .filter((f) => f.state !== 'RESOLVED' && !f.suppressed)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || severityRank(a.severity) - severityRank(b.severity));
  const shown = open.slice(0, GATE_MAX_FINDINGS);
  return h('div', { className: 'kcr-gate' }, [
    h(
      'div',
      {
        key: 'h',
        className: `kcr-gate-h ${g.band || ''}`,
        title: 'Blocked means a blocking finding is still open; Pass means none are.',
      },
      [GATE_ICON, `Review gate · ${g.verdict}`],
    ),
    g.detail ? h('div', { key: 'd', className: 'kcr-gate-d' }, g.detail) : null,
    ...shown.map((f) =>
      h('div', { key: f.findingId, className: 'kcr-gate-f' }, [
        h('span', { key: 's', className: 'kcr-sev', style: { background: sevColor(f.severity) } }, f.severity),
        h('span', { key: 't' }, [
          h('div', { key: 'a', className: 'kcr-ftitle' }, f.title),
          h('div', { key: 'b', className: 'kcr-floc' }, `${f.file}:${f.startLine}`),
        ]),
      ]),
    ),
    open.length > shown.length
      ? h('div', { key: 'm', className: 'kcr-gate-more' }, `and ${open.length - shown.length} more`)
      : null,
    h(
      'div',
      { key: 'o', className: 'kcr-actions' },
      h('button', { className: 'kcr-btn primary', onClick: onOpen }, 'Open review'),
    ),
  ]);
}

function ReviewOverview({
  reviews,
  summaries,
  previews,
  expanded,
  onExpand,
  onOpen,
  onTrack,
  trackError,
  tracking,
  source,
  loading,
  loadedAt,
  hasMore,
}) {
  const [value, setValue] = useState('');
  const [band, setBand] = useState('all');
  const counts = bandCounts(reviews, summaries);
  const rows = reviews
    .map((r, i) => ({ r, i, b: reviewBand(summaries[r.reviewId]) }))
    .filter((x) => band === 'all' || x.b === band);
  const noun = reviews.length === 1 ? 'review' : 'reviews';
  return h('div', null, [
    h('div', { key: 'top', className: 'kcr-ov-top' }, [
      h(
        'span',
        { key: 's', className: 'kcr-ov-sum' },
        loading
          ? 'Loading reviews…'
          : [
              `${reviews.length} ${noun}`,
              source === 'service'
                ? hasMore
                  ? 'newest 1,000 of your reviews'
                  : 'all your reviews'
                : 'from this machine',
              loadedAt
                ? `updated ${new Date(loadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                : '',
            ]
              .filter(Boolean)
              .join(' · '),
      ),
      h(
        'form',
        {
          key: 'f',
          className: 'kcr-track',
          onSubmit: (e) => {
            e.preventDefault();
            if (value.trim()) onTrack(value.trim()).then((ok) => ok && setValue(''));
          },
        },
        [
          h('input', {
            key: 'i',
            className: 'kcr-input kcr-mono',
            placeholder: 'Track review ID (rev-…)',
            value,
            onChange: (e) => setValue(e.target.value),
            'aria-label': 'Review ID',
          }),
          h(
            'button',
            { key: 'b', className: 'kcr-btn', type: 'submit', disabled: tracking || !value.trim() },
            tracking ? '…' : 'Add',
          ),
        ],
      ),
    ]),
    trackError ? h('div', { key: 'e', className: 'kcr-err' }, trackError) : null,
    h(
      'div',
      { key: 'bands', className: 'kcr-bands', role: 'group', 'aria-label': 'Filter reviews' },
      [['all', 'All'], ...Object.entries(BAND_LABELS)].map(([k, label]) =>
        h(
          'button',
          {
            key: k,
            className: `kcr-band${band === k ? ' sel' : ''}`,
            'aria-pressed': band === k,
            onClick: () => setBand(k),
          },
          [
            k === 'all' ? null : h(Dot, { key: 'd', tone: k }),
            h('span', { key: 'l' }, label),
            h('span', { key: 'n', className: 'n' }, counts[k]),
          ],
        ),
      ),
    ),
    loading
      ? h('div', { key: 'loading', className: 'kcr-card kcr-empty', role: 'status' }, [
          h('span', { key: 'sp', className: 'kcr-spinner', 'aria-hidden': true }),
          h('div', { key: 't' }, 'Loading your reviews…'),
        ])
      : reviews.length === 0
        ? h(
            'div',
            { key: 'empty', className: 'kcr-card kcr-empty' },
            source === 'local'
              ? 'No reviews on this machine yet. Reviews you submit from Kiro chat appear here; add one from elsewhere by its ID.'
              : 'No reviews yet. Reviews you submit from Kiro chat appear here.',
          )
        : rows.length === 0
          ? h('div', { key: 'none', className: 'kcr-card kcr-empty' }, `No reviews in “${BAND_LABELS[band]}”.`)
          : h(
              'div',
              { key: 'rows', className: 'kcr-card kcr-rows' },
              rows.map(({ r, i, b }) => {
                const s = summaries[r.reviewId];
                const isOpen = expanded === r.reviewId;
                const name = [r.repo, r.headRef].filter(Boolean).join(' · ') || shortId(r.reviewId);
                const toggle = () => onExpand(isOpen ? null : r.reviewId);
                return h('div', { key: r.reviewId, className: 'kcr-rowwrap' }, [
                  h(
                    'div',
                    {
                      key: 'row',
                      className: 'kcr-row',
                      role: 'button',
                      tabIndex: 0,
                      'aria-expanded': isOpen,
                      onClick: toggle,
                      onKeyDown: (e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle();
                        }
                      },
                    },
                    [
                      h('span', { key: 'n', className: 'kcr-num' }, `#${i + 1}`),
                      h('span', { key: 't', className: 'kcr-row-title' }, [
                        h(Dot, { key: 'd', tone: b || '' }),
                        h(
                          'button',
                          {
                            key: 'b',
                            className: 'kcr-row-name',
                            title: 'Open review',
                            onClick: (e) => {
                              e.stopPropagation();
                              onOpen(r.reviewId);
                            },
                          },
                          name,
                        ),
                      ]),
                      h('span', { key: 'w', className: 'kcr-row-when' }, [
                        relTime((s && s.updatedAt) || r.updatedAt || r.trackedAt || r.createdAt),
                        h(
                          'span',
                          { key: 'c', className: `kcr-chev${isOpen ? ' open' : ''}`, 'aria-hidden': true },
                          '›',
                        ),
                      ]),
                      h('span', { key: 'id', className: 'kcr-row-sub kcr-mono' }, r.reviewId),
                      r.intent ? h('span', { key: 'in', className: 'kcr-row-sub' }, r.intent) : null,
                      h('span', { key: 'p', className: 'kcr-pills' }, rowPills(s)),
                    ],
                  ),
                  isOpen ? h(Gate, { key: 'g', review: previews[r.reviewId], onOpen: () => onOpen(r.reviewId) }) : null,
                ]);
              }),
            ),
  ]);
}

/* ---------- review detail ---------- */

function StatusBanner({ review }) {
  const it = review.iteration;
  const tone = statusTone(it.status, it.outcome);
  let title;
  let text = '';
  if (review.awaitingContext) {
    title = 'Waiting for context the reviewer requested';
    text =
      'The agent is sending it from the Kiro chat. If nothing is sent before the deadline, the review continues without it.';
  } else if (!review.terminal) {
    title =
      it.status === 'NEEDS_CONTEXT' ? 'Applying context' : `Review ${it.status === 'QUEUED' ? 'queued' : 'running'}`;
    text = 'This page refreshes every few seconds.';
  } else if (it.outcome === 'INCOMPLETE') {
    title = `Incomplete (${it.status})`;
    text = incompleteReasons(it);
  } else if (it.outcome === 'NO_FINDINGS') {
    title = 'Completed with no findings';
    text = 'A review with no findings does not mean the code is defect-free.';
  } else {
    title = `${it.counts.active} active finding${it.counts.active === 1 ? '' : 's'}`;
    text = it.counts.blocking > 0 ? `${it.counts.blocking} blocking.` : 'None are blocking.';
  }
  return h('div', { className: `kcr-banner ${tone}` }, [
    h('div', { key: 'd', style: { paddingTop: 5 } }, h(Dot, { tone })),
    h('div', { key: 't' }, [
      h('b', { key: 'b' }, title),
      text ? h('span', { key: 's', style: { color: 'var(--muted,#7f7f88)' } }, text) : null,
    ]),
  ]);
}

function incompleteReasons(it) {
  const c = it.completeness;
  const out = [];
  if (c) {
    for (const f of c.reviewersFailed || []) out.push(`reviewer ${f.reviewer} failed (${f.code})`);
    if (c.verify && c.verify !== 'OK') out.push(`verify ${c.verify}`);
    if (c.budgetExhausted) out.push('model budget exhausted');
    if (c.deadlineHit) out.push('work deadline hit');
    if (c.candidatesTruncated) out.push('candidates truncated');
    if (c.findingsTruncated) out.push('findings truncated');
  }
  if (it.error)
    out.push(`error ${it.error.code}${it.error.stage ? ` in ${it.error.stage}` : ''}: ${it.error.message || ''}`);
  return (out.length ? out.join('; ') : `status ${it.status}`) + '. These results are not a clean review.';
}

function Stat({ label, value, color }) {
  return h('div', { className: 'kcr-card kcr-stat' }, [
    h('div', { key: 'l', className: 'kcr-stat-l' }, label),
    h('div', { key: 'v', className: 'kcr-stat-v', style: color ? { color } : undefined }, value),
  ]);
}

function Stats({ review }) {
  const { counts, modelUsage } = review.iteration;
  const active = useMemo(() => review.findings.filter((f) => f.state !== 'RESOLVED' && !f.suppressed), [review]);
  const bySev = groupCounts(active, (f) => f.severity);
  const total = active.length || 1;
  return h('div', { key: 's' }, [
    h('div', { key: 'g', className: 'kcr-stats' }, [
      h(Stat, {
        key: 'b',
        label: 'Blocking',
        value: counts.blocking,
        color: counts.blocking ? 'var(--sev-critical)' : undefined,
      }),
      h(Stat, { key: 'a', label: 'Active', value: counts.active }),
      h(Stat, { key: 's', label: 'Suppressed', value: counts.suppressed }),
      h(Stat, {
        key: 'r',
        label: 'Resolved',
        value: counts.resolved,
        color: counts.resolved ? 'var(--ok,#22c55e)' : undefined,
      }),
      h(Stat, { key: 'u', label: 'Model calls', value: modelUsage ? modelUsage.calls : '—' }),
    ]),
    active.length > 0
      ? h('div', { key: 'v', className: 'kcr-card', style: { padding: '12px 16px', marginBottom: 16 } }, [
          h('div', { key: 'l', className: 'kcr-stat-l' }, 'Active findings by severity'),
          h(
            'div',
            { key: 'b', className: 'kcr-sevbar' },
            SEVERITIES.filter((s) => bySev[s]).map((s) =>
              h('span', {
                key: s,
                title: `${s}: ${bySev[s]}`,
                style: { width: `${(bySev[s] / total) * 100}%`, background: sevColor(s) },
              }),
            ),
          ),
          h(
            'div',
            { key: 'g', className: 'kcr-legend' },
            SEVERITIES.filter((s) => bySev[s]).map((s) =>
              h('span', { key: s }, [h('i', { key: 'i', style: { background: sevColor(s) } }), `${s} ${bySev[s]}`]),
            ),
          ),
        ])
      : null,
  ]);
}

function Notes({ review }) {
  const it = review.iteration;
  const notes = [];
  if (it.cache && it.cache.hit)
    notes.push(
      `Cached result${it.cache.cachedAt ? ` from ${it.cache.cachedAt}` : ''}: identical diff, rules, context and level; no model calls.`,
    );
  if (it.excludedFiles && it.excludedFiles.length)
    notes.push(
      `Excluded from review: ${it.excludedFiles.slice(0, 20).join(', ')}${it.excludedFiles.length > 20 ? ` … and ${it.excludedFiles.length - 20} more` : ''}`,
    );
  const skipped = (it.completeness && it.completeness.rulesSkipped) || [];
  if (skipped.length) notes.push(`Custom rules skipped (no matching changed file): ${skipped.join(', ')}`);
  const c = it.completeness && it.completeness.context;
  if (review.terminal && c && c.requested.length) {
    const parts = [`${c.provided.length} provided`];
    if (c.declined.length) parts.push(`declined: ${c.declined.join(', ')}`);
    if (c.notFound.length) parts.push(`not found: ${c.notFound.join(', ')}`);
    if (c.unanswered.length) parts.push(`not provided${c.timedOut ? ' (timed out)' : ''}: ${c.unanswered.join(', ')}`);
    notes.push(
      `Context round ${c.round == null ? '?' : c.round}: ${c.requested.length} requested; ${parts.join('; ')}.`,
    );
    if (c.missing) notes.push('Reviewed without some requested context (not fully informed).');
  }
  for (const w of it.warnings || []) notes.push(`Warning: ${w}`);
  if (it.startedAt && it.completedAt)
    notes.push(`Took ${formatDuration(Date.parse(it.completedAt) - Date.parse(it.startedAt))}.`);
  if (!notes.length) return null;
  return h(
    'ul',
    { className: 'kcr-notes' },
    notes.map((n, i) => h('li', { key: i }, n)),
  );
}

function ContextRequests({ review }) {
  const it = review.iteration;
  if (!review.awaitingContext) return null;
  const round = it.contextRound || {};
  const requests = it.contextRequests || [];
  return h('div', { className: 'kcr-card', style: { padding: '12px 16px', marginBottom: 16 } }, [
    h(
      'div',
      { key: 't', className: 'kcr-stat-l' },
      `Context requested (round ${round.round == null ? '?' : round.round})${round.expiresAt ? ` · answer by ${new Date(round.expiresAt).toLocaleTimeString()}` : ''}`,
    ),
    h(
      'div',
      { key: 'r', className: 'kcr-req' },
      requests.flatMap((q) => {
        const target =
          q.kind === 'search' ? q.query : q.kind === 'range' ? `${q.path}:${q.startLine}-${q.endLine}` : q.path;
        return [
          h('span', { key: q.requestId + 'k', className: 'kcr-chip' }, q.kind),
          h('div', { key: q.requestId + 'v' }, [
            h('span', { key: 't', className: 'kcr-mono' }, target || ''),
            h('div', { key: 'r', style: { color: 'var(--muted,#7f7f88)' } }, q.reason),
          ]),
        ];
      }),
    ),
  ]);
}

function Thread({ thread }) {
  if (!thread || !thread.length) return null;
  return h('div', null, [
    h('div', { key: 'h', className: 'kcr-h' }, 'Thread'),
    ...thread.map((t, i) =>
      h('div', { key: i, className: 'kcr-thread' }, [
        h('div', { key: 'a', className: 'kcr-sub' }, `${t.author} · iteration ${t.iteration}`),
        h('div', { key: 't', className: 'kcr-prose', style: { margin: '2px 0' } }, t.text),
      ]),
    ),
  ]);
}

function SuppressForm({ finding, onDone, api, reviewId, notify }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(
        `${API}/reviews/${reviewId}/findings/${finding.findingId}/suppress`,
        reason.trim() ? { reason: reason.trim() } : {},
      );
      notify(`Suppressed ${finding.findingId}`);
      setOpen(false);
      onDone();
    } catch (e) {
      setError(parseApiError(e));
    }
    setBusy(false);
  };
  if (!open)
    return h('button', { className: 'kcr-btn', style: { marginTop: 12 }, onClick: () => setOpen(true) }, 'Suppress…');
  return h('div', { style: { marginTop: 12 } }, [
    h('div', { key: 'h', className: 'kcr-h' }, 'Suppress for the rest of this review session'),
    h('textarea', {
      key: 't',
      className: 'kcr-textarea',
      rows: 3,
      maxLength: REASON_MAX,
      placeholder: 'Reason (optional)',
      value: reason,
      onChange: (e) => setReason(e.target.value),
      style: { marginTop: 6 },
    }),
    h('div', { key: 'c', className: 'kcr-sub', style: { textAlign: 'right' } }, `${reason.length}/${REASON_MAX}`),
    error ? h('div', { key: 'e', className: 'kcr-err' }, error) : null,
    h('div', { key: 'b', style: { display: 'flex', gap: 8, marginTop: 6 } }, [
      h(
        'button',
        { key: 'y', className: 'kcr-btn danger', disabled: busy, onClick: submit },
        busy ? 'Suppressing…' : 'Suppress finding',
      ),
      h('button', { key: 'n', className: 'kcr-btn', disabled: busy, onClick: () => setOpen(false) }, 'Cancel'),
    ]),
  ]);
}

const FEEDBACK_REASONS = [
  ['wrong', 'Wrong'],
  ['not_relevant', 'Not relevant'],
  ['too_minor', 'Too minor'],
  ['already_handled', 'Already handled'],
  ['other', 'Other'],
];
const FEEDBACK_COMMENT_MAX = 500;

function Feedback({ f, api, reviewId, onChanged, notify }) {
  const fb = f.feedback || null;
  const vote = fb ? fb.vote : null;
  const [picking, setPicking] = useState(false);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (body, msg) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`${API}/reviews/${reviewId}/findings/${f.findingId}/feedback`, body);
      notify(msg);
      setPicking(false);
      onChanged();
    } catch (e) {
      setError(parseApiError(e));
    }
    setBusy(false);
  };
  const reasonLabel = fb && fb.reason ? (FEEDBACK_REASONS.find(([k]) => k === fb.reason) || [, fb.reason])[1] : '';
  return h('div', { style: { marginTop: 12 } }, [
    h('div', { key: 'r', className: 'kcr-actions', style: { marginTop: 0 } }, [
      h('span', { key: 'l', className: 'kcr-sub' }, 'Was this helpful?'),
      h(
        'button',
        {
          key: 'u',
          className: `kcr-vote${vote === 'up' ? ' sel' : ''}`,
          disabled: busy,
          'aria-pressed': vote === 'up',
          onClick: () =>
            vote === 'up' ? send({ vote: null }, 'Feedback cleared') : send({ vote: 'up' }, 'Thanks for the feedback'),
        },
        '👍 Yes',
      ),
      h(
        'button',
        {
          key: 'd',
          className: `kcr-vote${vote === 'down' ? ' sel' : ''}`,
          disabled: busy,
          'aria-pressed': vote === 'down',
          onClick: () => {
            if (vote === 'down') send({ vote: null }, 'Feedback cleared');
            else {
              setReason('');
              setComment('');
              setPicking(true);
            }
          },
        },
        '👎 No',
      ),
      vote === 'down' && reasonLabel ? h('span', { key: 'why', className: 'kcr-sub' }, reasonLabel) : null,
    ]),
    picking
      ? h('div', { key: 'p', style: { marginTop: 8 } }, [
          h(
            'div',
            { key: 'c', className: 'kcr-reasons' },
            FEEDBACK_REASONS.map(([k, label]) =>
              h(
                'button',
                {
                  key: k,
                  className: `kcr-filter${reason === k ? ' sel' : ''}`,
                  onClick: () => setReason(reason === k ? '' : k),
                },
                label,
              ),
            ),
          ),
          h('textarea', {
            key: 't',
            className: 'kcr-textarea',
            rows: 2,
            maxLength: FEEDBACK_COMMENT_MAX,
            placeholder: 'Anything else? (optional)',
            value: comment,
            onChange: (e) => setComment(e.target.value),
            style: { marginTop: 8 },
          }),
          h('div', { key: 'b', style: { display: 'flex', gap: 8, marginTop: 6 } }, [
            h(
              'button',
              {
                key: 's',
                className: 'kcr-btn primary',
                disabled: busy,
                onClick: () =>
                  send(
                    {
                      vote: 'down',
                      ...(reason ? { reason } : {}),
                      ...(comment.trim() ? { comment: comment.trim() } : {}),
                    },
                    'Thanks, that helps tune the reviewer',
                  ),
              },
              busy ? 'Sending…' : 'Send feedback',
            ),
            h('button', { key: 'x', className: 'kcr-btn', disabled: busy, onClick: () => setPicking(false) }, 'Cancel'),
          ]),
        ])
      : null,
    error ? h('div', { key: 'e', className: 'kcr-err' }, error) : null,
  ]);
}

function copyText(text, notify, msg) {
  if (!navigator.clipboard) {
    notify('Clipboard is not available here');
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => notify(msg),
    () => notify('Copy failed (clipboard blocked)'),
  );
}

function AgentActions({ findings, review, openChat, notify, label }) {
  const prompt = () => buildFixPrompt(findings, review);
  return h('span', { className: 'kcr-actions', style: { marginTop: 0 } }, [
    h(
      'button',
      {
        key: 's',
        className: 'kcr-btn primary',
        title: 'Opens a chat with a prompt to verify and fix',
        onClick: () => openChat({ message: prompt() }),
      },
      label || 'Fix with agent',
    ),
    h(
      'button',
      { key: 'c', className: 'kcr-btn', onClick: () => copyText(prompt(), notify, 'Fix prompt copied') },
      'Copy prompt',
    ),
  ]);
}

function UnsuppressButton({ f, api, reviewId, onChanged, notify }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`${API}/reviews/${reviewId}/findings/${f.findingId}/unsuppress`, {});
      notify(`Unsuppressed ${f.findingId}`);
      onChanged();
    } catch (e) {
      setError(parseApiError(e));
    }
    setBusy(false);
  };
  return h('div', { style: { marginTop: 12 } }, [
    h(
      'button',
      { key: 'b', className: 'kcr-btn', disabled: busy, onClick: run },
      busy ? 'Unsuppressing…' : 'Unsuppress',
    ),
    error ? h('div', { key: 'e', className: 'kcr-err' }, error) : null,
  ]);
}

/** A suppressed finding: one dimmed row with the reason; click to read it in full or unsuppress. */
function SuppressedCard({ f, range, api, reviewId, onChanged, notify, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const why = f.suppressionReason ? `Reason: ${f.suppressionReason}` : 'No reason given';
  return h('div', { className: 'kcr-card kcr-finding sup' }, [
    h(
      'button',
      {
        key: 'h',
        className: 'kcr-sup-row',
        onClick: () => setOpen(!open),
        'aria-expanded': open,
        title: `${f.file}:${range}`,
      },
      [
        h('span', { key: 'tag', className: 'kcr-sup-tag' }, 'Suppressed'),
        h('span', { key: 's', className: 'kcr-sev' }, f.severity),
        h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
          h('div', { key: 'a', className: 'kcr-ftitle' }, f.title),
          h('div', { key: 'r', className: 'kcr-sup-why' }, why),
        ]),
        h('span', { key: 'x', style: { color: 'var(--muted,#7f7f88)' } }, open ? '▾' : '▸'),
      ],
    ),
    open
      ? h('div', { key: 'b', className: 'kcr-fbody' }, [
          h('div', { key: 'l', className: 'kcr-floc', style: { marginTop: 12 } }, `${f.file}:${range}`),
          h('div', { key: 'e', className: 'kcr-prose' }, f.explanation),
          f.suggestion
            ? h('div', { key: 'sg' }, [
                h('div', { key: 'h', className: 'kcr-h' }, 'Suggestion'),
                h('div', { key: 'c', className: 'kcr-code' }, f.suggestion),
              ])
            : null,
          h(Thread, { key: 'th', thread: f.thread }),
          h('div', { key: 'm', className: 'kcr-meta' }, [
            h(Chip, { key: 'id', title: 'Finding ID' }, f.findingId),
            f.category ? h(Chip, { key: 'ca' }, f.category) : null,
            f.ruleId ? h(Chip, { key: 'ru' }, `rule ${f.ruleId}`) : null,
            f.blocking ? h(Chip, { key: 'bl', color: 'var(--sev-critical)' }, 'blocking when active') : null,
          ]),
          h(UnsuppressButton, { key: 'un', f, api, reviewId, onChanged, notify }),
        ])
      : null,
  ]);
}

function FindingCard({ f, api, reviewId, onChanged, notify, defaultOpen, review, openChat }) {
  const [open, setOpen] = useState(defaultOpen);
  const range = f.endLine > f.startLine ? `${f.startLine}-${f.endLine}` : `${f.startLine}`;
  const stateLabel = f.state.toLowerCase();
  const canSuppress = f.state !== 'RESOLVED';
  if (f.suppressed) {
    return h(SuppressedCard, { f, range, api, reviewId, onChanged, notify, defaultOpen: false });
  }
  return h('div', { className: 'kcr-card kcr-finding' }, [
    h(
      'button',
      {
        key: 'h',
        className: 'kcr-fhead',
        onClick: () => setOpen(!open),
        'aria-expanded': open,
      },
      [
        h('span', { key: 's', className: 'kcr-sev', style: { background: sevColor(f.severity) } }, f.severity),
        h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
          h('div', { key: 'a', className: 'kcr-ftitle' }, f.title),
          h('div', { key: 'b', className: 'kcr-floc' }, `${f.file}:${range}`),
        ]),
        f.feedback ? h('span', { key: 'fb', title: 'Your feedback' }, f.feedback.vote === 'up' ? '👍' : '👎') : null,
        f.blocking ? h(Chip, { key: 'bl', color: 'var(--sev-critical)' }, 'blocking') : null,
        h(
          Chip,
          {
            key: 'st',
            color:
              f.state === 'NEW' ? 'var(--kcr-accent-text)' : f.state === 'RESOLVED' ? 'var(--ok,#22c55e)' : undefined,
          },
          stateLabel,
        ),
        h('span', { key: 'x', style: { color: 'var(--muted,#7f7f88)' } }, open ? '▾' : '▸'),
      ],
    ),
    open
      ? h('div', { key: 'b', className: 'kcr-fbody' }, [
          f.dismissedByAuthor
            ? h(
                'div',
                { key: 'd', className: 'kcr-banner warn', style: { marginTop: 12, marginBottom: 0 } },
                `Blocking, dismissed by author (${f.dismissalDisposition || 'dismissed'})${f.dismissalReason ? `: ${f.dismissalReason}` : ''}. Still counted as blocking.`,
              )
            : null,
          f.locallyUnsuppressed
            ? h(
                'div',
                { key: 'lu', className: 'kcr-banner warn', style: { marginTop: 12, marginBottom: 0 } },
                'Unsuppressed on this machine only. The service has no unsuppress call yet, so it still treats this finding as suppressed.',
              )
            : null,
          f.claimedFixedStillPresent
            ? h(
                'div',
                { key: 'c', className: 'kcr-banner warn', style: { marginTop: 12, marginBottom: 0 } },
                'Claimed fixed, but the finding is still present.',
              )
            : null,
          h('div', { key: 'e', className: 'kcr-prose' }, f.explanation),
          f.suggestion
            ? h('div', { key: 'sg' }, [
                h('div', { key: 'h', className: 'kcr-h' }, 'Suggestion'),
                h('div', { key: 'c', className: 'kcr-code' }, f.suggestion),
              ])
            : null,
          h(Thread, { key: 'th', thread: f.thread }),
          h('div', { key: 'm', className: 'kcr-meta' }, [
            h(Chip, { key: 'id', title: 'Finding ID' }, f.findingId),
            f.category ? h(Chip, { key: 'ca' }, f.category) : null,
            f.ruleId ? h(Chip, { key: 'ru' }, `rule ${f.ruleId}`) : null,
            h(Chip, { key: 'fs' }, `first seen in iteration ${f.firstSeenIteration}`),
            f.resolvedIteration ? h(Chip, { key: 'ri' }, `resolved in iteration ${f.resolvedIteration}`) : null,
            f.confidence != null
              ? h(Chip, { key: 'cf' }, `${Math.round(f.confidence * 100)}% confidence${f.verified ? ', verified' : ''}`)
              : null,
            f.carriedForward ? h(Chip, { key: 'cr' }, 'carried forward') : null,
            ...(f.reviewers || []).map((r) => h(Chip, { key: 'rv' + r }, r)),
          ]),
          canSuppress
            ? h(
                'div',
                { key: 'ag', className: 'kcr-actions' },
                h(AgentActions, { findings: [f], review, openChat, notify }),
              )
            : null,
          h(Feedback, { key: 'fbk', f, api, reviewId, onChanged, notify }),
          canSuppress ? h(SuppressForm, { key: 'sup', finding: f, api, reviewId, onDone: onChanged, notify }) : null,
        ])
      : null,
  ]);
}

/* ---------- diff and context ---------- */

const SIGN = { add: '+', del: '-', ctx: ' ', meta: '' };

function DiffLines({ lines }) {
  return lines.map((l, i) =>
    h('div', { key: i, className: `kcr-dl ${l.type}${l.hit ? ' hit' : ''}` }, [
      h('span', { key: 'o', className: 'n' }, l.oldNo == null ? '' : l.oldNo),
      h('span', { key: 'n', className: 'n' }, l.newNo == null ? '' : l.newNo),
      h('span', { key: 's', className: 's' }, SIGN[l.type]),
      h('span', { key: 't', className: 't' }, l.text),
    ]),
  );
}

function Collapsible({ title, right, children, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return h('div', { className: 'kcr-card kcr-file' }, [
    h('button', { key: 'h', className: 'kcr-file-head', onClick: () => setOpen(!open), 'aria-expanded': open }, [
      h('span', { key: 'x', style: { color: 'var(--muted,#7f7f88)' } }, open ? '▾' : '▸'),
      h('span', { key: 't', className: 'kcr-mono', style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, title),
      right ? h('span', { key: 'r' }, right) : null,
    ]),
    open ? h('div', { key: 'b', className: 'kcr-file-body' }, children) : null,
  ]);
}

function FileContent({ path, content, right }) {
  return h(
    Collapsible,
    { title: path, right },
    h('div', { className: 'kcr-code', style: { borderLeftColor: 'var(--border-strong,#3f3f46)' } }, content),
  );
}

const sectionHead = (key, text) =>
  h('div', { key, className: 'kcr-h', style: { marginTop: 20, marginBottom: 6 } }, text);

function ContextView({ stored, review, expired }) {
  if (!stored || (!stored.submission && stored.contextRounds.length === 0)) {
    return h(
      'div',
      { className: 'kcr-empty' },
      expired
        ? 'The service no longer keeps what was sent for this iteration (retention period passed).'
        : 'What was sent for this iteration was not stored on this machine.',
    );
  }
  const sub = stored.submission;
  const c = review.iteration.completeness && review.iteration.completeness.context;
  const entries = (c && c.entries) || [];
  const requests = review.iteration.contextRequests || [];
  const describe = (id) => {
    const q = requests.find((r) => r.requestId === id);
    if (q)
      return q.kind === 'search'
        ? `search: ${q.query}`
        : q.kind === 'range'
          ? `${q.path}:${q.startLine}-${q.endLine}`
          : q.path;
    const e = entries.find((x) => x.requestId === id);
    return e ? `${e.kind || 'file'}${e.path ? `: ${e.path}` : ''}` : '';
  };
  const out = [];
  if (sub) {
    const rows = [
      ['Base', `${sub.base.ref} @ ${sub.base.commit.slice(0, 12)}`],
      sub.head ? ['Head', `${sub.head.ref}${sub.head.commit ? ` @ ${sub.head.commit.slice(0, 12)}` : ''}`] : null,
      sub.level ? ['Level', sub.level] : null,
      ['Sent', new Date(sub.sentAt).toLocaleString()],
      ['File manifest', `${sub.manifestCount} file names (no content)`],
      sub.intent ? ['Intent', sub.intent] : null,
    ].filter(Boolean);
    out.push(
      h(
        'dl',
        { key: 'kv', className: 'kcr-card kcr-kv', style: { marginTop: 16 } },
        rows.flatMap(([k, v]) => [h('dt', { key: k + 't' }, k), h('dd', { key: k + 'd' }, v)]),
      ),
    );
    if (sub.commits && sub.commits.length) {
      out.push(sectionHead('ch', `Commits (${sub.commits.length})`));
      out.push(
        h(
          'ul',
          { key: 'cl', className: 'kcr-notes', style: { color: 'var(--text,#e4e4e7)' } },
          sub.commits.map((cm, i) =>
            h('li', { key: i }, [
              h('b', { key: 's' }, cm.subject),
              cm.body ? h('div', { key: 'b', className: 'kcr-sub', style: { whiteSpace: 'pre-wrap' } }, cm.body) : null,
            ]),
          ),
        ),
      );
    }
    if (sub.responses && sub.responses.length) {
      out.push(sectionHead('rh', `Responses to earlier findings (${sub.responses.length})`));
      out.push(
        h(
          'ul',
          { key: 'rl', className: 'kcr-notes' },
          sub.responses.map((r, i) =>
            h('li', { key: i }, `${r.findingId}: ${r.disposition}${r.comment ? ` · ${r.comment}` : ''}`),
          ),
        ),
      );
    }
    const rules = sub.rules
      ? [
          ['REVIEW_RULES.yaml', sub.rules.reviewRulesYaml],
          ['REVIEW.md', sub.rules.reviewMd],
        ].filter(([, content]) => content)
      : [];
    if (rules.length) {
      out.push(sectionHead('ruh', `Rules (from ${sub.base.ref})`));
      for (const [name, content] of rules) out.push(h(FileContent, { key: 'r' + name, path: name, content }));
    }
    out.push(sectionHead('cfh', `Context files sent with the review (${sub.context.length})`));
    if (sub.context.length) {
      sub.context.forEach((f, i) => out.push(h(FileContent, { key: 'c' + i, path: f.path, content: f.content })));
    } else {
      out.push(h('div', { key: 'cfe', className: 'kcr-sub' }, 'None.'));
    }
  }
  for (const round of stored.contextRounds) {
    out.push(
      sectionHead(
        'rd' + round.round,
        `Context round ${round.round} · sent ${new Date(round.sentAt).toLocaleTimeString()}`,
      ),
    );
    for (const r of round.responses) {
      const label = `${r.requestId}${describe(r.requestId) ? ` · ${describe(r.requestId)}` : ''}`;
      const chip = h(
        Chip,
        {
          color:
            r.status === 'provided' ? 'var(--ok,#22c55e)' : r.status === 'declined' ? 'var(--sev-high)' : undefined,
        },
        r.status,
      );
      const key = `rr${round.round}-${r.requestId}`;
      out.push(
        r.content
          ? h(FileContent, { key, path: label, content: r.content, right: chip })
          : h(
              'div',
              {
                key,
                className: 'kcr-card',
                style: { padding: '10px 14px', marginBottom: 10, display: 'flex', gap: 10 },
              },
              [h('span', { key: 'l', className: 'kcr-mono', style: { flex: 1 } }, label), chip],
            ),
      );
    }
    for (const f of round.context) {
      out.push(
        h(FileContent, {
          key: `ru${round.round}-${f.path}`,
          path: f.path,
          content: f.content,
          right: h(Chip, null, 'extra file'),
        }),
      );
    }
  }
  return h('div', null, out);
}

const FILTERS = [
  ['active', 'Active'],
  ['blocking', 'Blocking'],
  ['new', 'New'],
  ['persisting', 'Persisting'],
  ['resolved', 'Resolved'],
  ['suppressed', 'Suppressed'],
  ['all', 'All'],
];

function matches(f, filter) {
  switch (filter) {
    case 'active':
      return f.state !== 'RESOLVED' && !f.suppressed;
    case 'blocking':
      return f.blocking && f.state !== 'RESOLVED' && !f.suppressed;
    case 'new':
      return f.state === 'NEW' && !f.suppressed;
    case 'persisting':
      return f.state === 'PERSISTING' && !f.suppressed;
    case 'resolved':
      return f.state === 'RESOLVED';
    case 'suppressed':
      return f.suppressed;
    default:
      return true;
  }
}

function findingCards(list, props, defaultOpen) {
  return list.map((f) => h(FindingCard, { key: f.findingId, f, ...props, defaultOpen: defaultOpen && !f.suppressed }));
}

function DiffSegment({ lines }) {
  return h('div', { className: 'kcr-diff kcr-seg' }, h(DiffLines, { lines }));
}

/** One diff file with the shown findings placed under the lines they point to. */
function FileWithFindings({ file, place, props, openCards, defaultOpen }) {
  const p = filePath(file);
  const placedHere = [...place.unanchored, ...Object.values(place.anchors).flat()];
  const count = placedHere.filter((f) => !f.suppressed).length;
  const suppressedCount = placedHere.length - count;
  const title = file.status === 'renamed' && file.oldPath !== file.newPath ? `${file.oldPath} → ${file.newPath}` : p;
  const body = [];
  if (place.unanchored.length) {
    body.push(
      h('div', { key: 'uh', className: 'kcr-h', style: { marginTop: 4 } }, 'On lines this diff does not change'),
      ...findingCards(place.unanchored, props, openCards),
    );
  }
  if (file.hunks.length === 0) {
    body.push(
      h(
        'div',
        { key: 'nb', className: 'kcr-sub' },
        file.status === 'binary' ? 'Binary file, not shown.' : 'No content changes.',
      ),
    );
  }
  file.hunks.forEach((hunk, hi) => {
    body.push(h('div', { key: `hh${hi}`, className: 'kcr-hunk kcr-seg-head' }, hunk.header));
    let seg = [];
    hunk.lines.forEach((line, li) => {
      seg.push(line);
      const here = place.anchors[`${hi}:${li}`];
      if (!here) return;
      body.push(h(DiffSegment, { key: `s${hi}:${li}`, lines: seg }));
      seg = [];
      body.push(h('div', { key: `f${hi}:${li}`, className: 'kcr-inline' }, findingCards(here, props, openCards)));
    });
    if (seg.length) body.push(h(DiffSegment, { key: `s${hi}:end`, lines: seg }));
  });
  return h(
    Collapsible,
    {
      title,
      defaultOpen,
      right: h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
        count ? h(Chip, { key: 'f', color: 'var(--sev-high)' }, `${count} finding${count === 1 ? '' : 's'}`) : null,
        suppressedCount ? h(Chip, { key: 'sp' }, `${suppressedCount} suppressed`) : null,
        file.status !== 'modified' ? h(Chip, { key: 'st' }, file.status) : null,
        h('span', { key: 'a', className: 'kcr-add kcr-mono' }, `+${file.adds}`),
        h('span', { key: 'd', className: 'kcr-del kcr-mono' }, `−${file.dels}`),
      ]),
    },
    body,
  );
}

function Findings({ review, api, onChanged, notify, files, openChat }) {
  const [filter, setFilter] = useState('active');
  const [query, setQuery] = useState('');
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(([k]) => [k, review.findings.filter((f) => matches(f, k)).length])),
    [review],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Suppressed findings stay in the diff (disabled, with their reason) under every filter except Resolved.
    const keep = (f) => matches(f, filter) || (f.suppressed && f.state !== 'RESOLVED' && filter !== 'resolved');
    return review.findings
      .filter((f) => keep(f) && (!q || `${f.title} ${f.file} ${f.category} ${f.findingId}`.toLowerCase().includes(q)))
      .sort(
        (a, b) =>
          Number(a.suppressed) - Number(b.suppressed) ||
          severityRank(a.severity) - severityRank(b.severity) ||
          a.file.localeCompare(b.file) ||
          a.startLine - b.startLine,
      );
  }, [review, filter, query]);
  const placed = useMemo(() => (files ? placeFindings(files, shown) : null), [files, shown]);
  const props = { api, reviewId: review.reviewId, onChanged, notify, review, openChat };
  const blocking = review.findings.filter((f) => f.blocking && f.state !== 'RESOLVED' && !f.suppressed);
  const openCards = shown.filter((f) => !f.suppressed).length <= 3;

  const bulk =
    review.terminal && blocking.length
      ? h(
          'div',
          {
            key: 'bk',
            className: 'kcr-card',
            style: {
              padding: '10px 14px',
              margin: '16px 0 0',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            },
          },
          [
            h('span', { key: 't', style: { flex: 1, minWidth: 200 } }, [
              h('b', { key: 'b' }, `${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}`),
              h('span', { key: 's', className: 'kcr-sub' }, ' · the agent checks each one before changing code'),
            ]),
            h(AgentActions, {
              key: 'a',
              findings: blocking,
              review,
              openChat,
              notify,
              label: `Fix ${blocking.length} with agent`,
            }),
          ],
        )
      : null;
  const toolbar = h('div', { key: 't', className: 'kcr-toolbar' }, [
    ...FILTERS.map(([k, label]) =>
      h(
        'button',
        { key: k, className: `kcr-filter${filter === k ? ' sel' : ''}`, onClick: () => setFilter(k) },
        `${label} ${counts[k]}`,
      ),
    ),
    h('span', { key: 's', className: 'kcr-spacer' }),
    h('input', {
      key: 'q',
      className: 'kcr-input',
      style: { maxWidth: 220 },
      placeholder: 'Filter by title or file',
      value: query,
      onChange: (e) => setQuery(e.target.value),
      'aria-label': 'Filter findings',
    }),
  ]);

  const empty =
    shown.length === 0
      ? h(
          'div',
          { key: 'e', className: 'kcr-empty', style: { padding: files ? '16px' : undefined } },
          review.findings.length === 0
            ? review.terminal
              ? 'No findings in this iteration.'
              : 'Findings appear when the review finishes.'
            : 'No findings match this filter.',
        )
      : null;

  // No stored diff: the plain list.
  if (!placed) return h('div', null, [bulk, toolbar, empty || findingCards(shown, props, shown.length === 1)]);

  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  return h('div', null, [
    bulk,
    toolbar,
    h('div', { key: 'sum', className: 'kcr-sub', style: { margin: '0 0 12px' } }, [
      `${files.length} changed file${files.length === 1 ? '' : 's'} · `,
      h('span', { key: 'a', className: 'kcr-add' }, `+${adds}`),
      ' ',
      h('span', { key: 'd', className: 'kcr-del' }, `−${dels}`),
    ]),
    empty,
    ...files.map((file, i) => {
      const place = placed.perFile[i];
      const has = [...place.unanchored, ...Object.values(place.anchors).flat()].some((f) => !f.suppressed);
      return h(FileWithFindings, {
        key: `${filePath(file)}#${i}`,
        file,
        place,
        props,
        openCards,
        defaultOpen: has || files.length <= 3,
      });
    }),
    placed.outside.length
      ? h('div', { key: 'out' }, [
          h(
            'div',
            { key: 'h', className: 'kcr-h', style: { margin: '20px 0 6px' } },
            'Findings in files outside this diff',
          ),
          ...findingCards(placed.outside, props, openCards),
        ])
      : null,
  ]);
}

function ReviewDetail({ review, entry, onIteration, api, onChanged, notify, sent, sentError, openChat }) {
  const it = review.iteration;
  const [section, setSection] = useState('findings');
  const stored = sent && sent.iteration && sent.iteration.number === it.number ? sent.iteration : null;
  const delta = iterationDelta(review);
  const files = useMemo(
    () => (stored && stored.submission ? parseUnifiedDiff(stored.submission.diff) : null),
    [stored],
  );
  const contextCount = stored
    ? (stored.submission ? stored.submission.context.length : 0) +
      stored.contextRounds.reduce((n, r) => n + r.responses.filter((x) => x.content).length + r.context.length, 0)
    : 0;
  const sections = [
    ['findings', `Findings ${review.findings.filter((f) => f.state !== 'RESOLVED' && !f.suppressed).length}`],
    ['context', stored ? `Context ${contextCount}` : 'Context'],
  ];
  return h('div', null, [
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
      h(
        'h2',
        { key: 't', className: 'kcr-mono', style: { margin: 0, fontSize: 16, color: 'var(--text-strong,#fafafa)' } },
        review.reviewId,
      ),
      h(Chip, { key: 'l' }, review.level),
      entry && entry.headRef
        ? h(
            Chip,
            { key: 'b', color: 'var(--kcr-accent-text)' },
            entry.baseRef ? `${entry.headRef} ← ${entry.baseRef}` : entry.headRef,
          )
        : null,
      h('span', { key: 'sp', className: 'kcr-spacer' }),
      h(
        'button',
        {
          key: 'ho',
          className: 'kcr-btn',
          title: 'A short summary of this review for your CR or PR description',
          onClick: () => copyText(buildHandoff(review, entry), notify, 'Review summary copied for your CR/PR'),
        },
        'Copy for CR/PR',
      ),
      h(
        'button',
        { key: 'c', className: 'kcr-btn', onClick: () => copyText(review.reviewId, notify, 'Review ID copied') },
        'Copy ID',
      ),
    ]),
    h(
      'div',
      { key: 'sub', className: 'kcr-sub' },
      `Created ${relTime(review.createdAt)} · updated ${relTime(review.updatedAt)} · iteration ${it.number} of budget ${review.iterationBudget}${entry && entry.intent ? ` · ${entry.intent}` : ''}`,
    ),
    h(
      'div',
      { key: 'tabs', className: 'kcr-tabs', role: 'tablist' },
      review.iterations.map((i) =>
        h(
          'button',
          {
            key: i.number,
            role: 'tab',
            'aria-selected': i.number === it.number,
            className: `kcr-tab${i.number === it.number ? ' sel' : ''}`,
            onClick: () => onIteration(i.number === review.latestIteration ? null : i.number),
          },
          [
            h(Dot, { key: 'd', tone: statusTone(i.status, i.status === 'COMPLETED' ? 'FINDINGS' : '') }),
            `Iteration ${i.number}`,
          ],
        ),
      ),
    ),
    h(StatusBanner, { key: 'sb', review }),
    delta && review.terminal
      ? h('div', { key: 'dl', className: 'kcr-delta' }, [
          h('span', { key: 'l' }, `Since iteration ${delta.since}:`),
          h('span', { key: 'n' }, [h('b', { key: 'b' }, delta.fresh), ' new']),
          h('span', { key: 'p' }, [h('b', { key: 'b' }, delta.persisting), ' still open']),
          h('span', { key: 'r', style: { color: delta.resolved ? 'var(--ok,#22c55e)' : undefined } }, [
            h('b', { key: 'b', style: { color: 'inherit' } }, delta.resolved),
            ' resolved',
          ]),
        ])
      : null,
    h(ContextRequests, { key: 'cx', review }),
    h(Stats, { key: 'st', review }),
    h(Notes, { key: 'n', review }),
    h(
      'div',
      { key: 'sec', className: 'kcr-sections', role: 'tablist' },
      sections.map(([k, label]) =>
        h(
          'button',
          {
            key: k,
            role: 'tab',
            'aria-selected': section === k,
            className: `kcr-section${section === k ? ' sel' : ''}`,
            onClick: () => setSection(k),
          },
          label,
        ),
      ),
    ),
    section === 'findings' ? h(Findings, { key: 'f', review, api, onChanged, notify, files, openChat }) : null,
    section === 'context' && sentError
      ? h(
          'div',
          { key: 'se', className: 'kcr-banner bad', style: { marginTop: 16 } },
          h('div', null, [
            h('b', { key: 'b' }, 'Could not load what was sent for this review'),
            h(
              'span',
              { key: 's', style: { color: 'var(--muted,#7f7f88)' } },
              `${sentError}. If the app was just updated, turn it off and on in Apps so its backend restarts.`,
            ),
          ]),
        )
      : null,
    section === 'context' && !sentError
      ? h(ContextView, { key: 'c', stored, review, expired: !!(sent && sent.expired) })
      : null,
  ]);
}

/* ---------- page ---------- */

/** Kiro API key state for the chat tools. The key is never read back; only its last four characters show. */
function useApiKey(api, notify) {
  const [status, setStatus] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get(`${API}/api-key`)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.code) setErr(s.message);
      })
      .catch((e) => !cancelled && setErr(parseApiError(e)));
    return () => {
      cancelled = true;
    };
  }, [api]);

  const run = useCallback(
    async (path, body, done) => {
      setBusy(true);
      setErr('');
      try {
        setStatus(await api.post(`${API}/${path}`, body));
        setEditing(false);
        notify(done);
        return true;
      } catch (e) {
        setErr(parseApiError(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, notify],
  );

  const toggleEditing = useCallback((v) => {
    setErr('');
    setEditing(v);
  }, []);
  const set = Boolean(status && status.set);
  return {
    status,
    err,
    busy,
    editing,
    setEditing: toggleEditing,
    run,
    set,
    fromEnv: set && status.source === 'env',
  };
}

const VIEWS = [
  ['reviews', 'Reviews'],
  ['settings', 'Settings'],
];

function ViewTabs({ value, onChange }) {
  return h(
    'div',
    { className: 'kcr-tabs', role: 'tablist', 'aria-label': 'Kiro Reviewer views' },
    VIEWS.map(([id, label]) =>
      h(
        'button',
        {
          key: id,
          role: 'tab',
          'aria-selected': value === id,
          className: `kcr-tab${value === id ? ' on' : ''}`,
          onClick: () => onChange(id),
        },
        label,
      ),
    ),
  );
}

function RegionCard({ region, disabled, onChange }) {
  return h('section', { className: 'kcr-card kcr-key', 'aria-label': 'Kiro region' }, [
    h('div', { key: 'h', className: 'kcr-key-h' }, h('span', { className: 'kcr-key-t' }, 'Kiro region')),
    h('p', { key: 'p', className: 'kcr-key-p' }, 'The region whose reviews this page shows.'),
    h(
      'select',
      {
        key: 's',
        className: 'kcr-input kcr-region',
        value: region,
        disabled,
        onChange: (e) => onChange(e.target.value),
        'aria-label': 'Kiro region',
      },
      KIRO_REGIONS.map(([id, label]) => h('option', { key: id, value: id }, `${label} · ${id}`)),
    ),
  ]);
}

/** Shown at the top of the page while no key is set, or after "Change" in the header. */
function ApiKeyCard({ apiKey }) {
  const { status, err, busy, editing, setEditing, run, set, fromEnv } = apiKey;
  const [value, setValue] = useState('');
  const form = !set || editing;

  return h('section', { className: 'kcr-card kcr-key', 'aria-label': 'Kiro API key' }, [
    h('div', { key: 'h', className: 'kcr-key-h' }, [
      h('span', { key: 't', className: 'kcr-key-t' }, 'Kiro API key'),
      h(Chip, { key: 'c', color: set ? '#22c55e' : '#eab308' }, set ? 'Set' : 'Not set'),
    ]),
    h('p', { key: 'p', className: 'kcr-key-p' }, [
      'The chat tools (code_review_*) need a key. This page works without one, through your Kiro Crew sign-in. ',
      'Generate a key at ',
      h(
        'a',
        {
          key: 'l',
          href: 'https://app.kiro.dev',
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { color: 'var(--kcr-accent-text)' },
        },
        'app.kiro.dev',
      ),
      ' > Settings > API Keys. The key is stored only on this computer, in a file only you can read, and is never shown again.',
    ]),
    set
      ? h('div', { key: 'cur', className: 'kcr-key-row' }, [
          h('span', { key: 'm', className: 'kcr-key-cur' }, `ksk_••••••••${status.last4 || ''}`),
          h(
            'span',
            { key: 's', className: 'kcr-sub' },
            fromEnv ? 'from the KIRO_API_KEY environment variable' : 'saved on this computer',
          ),
          !fromEnv && !editing
            ? h('button', { key: 'r', className: 'kcr-btn', onClick: () => setEditing(true) }, 'Replace key')
            : null,
          !fromEnv
            ? h(
                'button',
                {
                  key: 'x',
                  className: 'kcr-btn danger',
                  disabled: busy,
                  title: 'Deletes the local file. The key stays valid in Kiro until you revoke it there.',
                  onClick: () => run('api-key/remove', {}, 'Key removed from this computer'),
                },
                'Remove',
              )
            : null,
        ])
      : null,
    form && !fromEnv
      ? h(
          'form',
          {
            key: 'f',
            className: 'kcr-key-row',
            style: set ? { marginTop: 8 } : undefined,
            onSubmit: (e) => {
              e.preventDefault();
              run('api-key', { key: value }, 'Key saved').then((ok) => ok && setValue(''));
            },
          },
          [
            h('input', {
              key: 'i',
              className: 'kcr-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: 'ksk_…',
              value,
              onChange: (e) => setValue(e.target.value),
              'aria-label': 'Kiro API key',
            }),
            h(
              'button',
              { key: 's', type: 'submit', className: 'kcr-btn primary', disabled: busy || value.trim() === '' },
              'Save key',
            ),
            editing
              ? h(
                  'button',
                  {
                    key: 'c',
                    type: 'button',
                    className: 'kcr-btn',
                    onClick: () => {
                      setEditing(false);
                      setValue('');
                    },
                  },
                  'Cancel',
                )
              : null,
          ],
        )
      : null,
    err ? h('div', { key: 'e', className: 'kcr-err' }, err) : null,
  ]);
}

export default function KiroCodeReviewer() {
  useStyle();
  const api = useAppApi();
  const { openChat } = useChatLauncher();
  const navigate = useNavigate();
  const [signIn, setSignIn] = useState(false);
  const [listSource, setListSource] = useState('local');
  const [listHasMore, setListHasMore] = useState(false);
  const [status, setStatus] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [summaries, setSummaries] = useState({});
  const [selected, setSelected] = useState(null);
  const [iteration, setIteration] = useState(null);
  const [review, setReview] = useState(null);
  const [sent, setSent] = useState(null);
  const [sentError, setSentError] = useState('');
  const [error, setError] = useState('');
  const [trackError, setTrackError] = useState('');
  const [tracking, setTracking] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(0);
  const [previews, setPreviews] = useState({});
  const [expanded, setExpanded] = useState(undefined);
  const [loadedAt, setLoadedAt] = useState(0);

  const notify = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3500);
  }, []);
  const apiKey = useApiKey(api, notify);
  const keyLoaded = Boolean(apiKey.status || apiKey.err);
  const [view, setView] = useState('reviews');
  // Reviews view shows the key card only as a prompt while no key is set; Settings always shows it.
  const keyPrompt = keyLoaded && !apiKey.set ? h(ApiKeyCard, { key: 'ak', apiKey }) : null;

  const linked = useMemo(() => {
    const id = new URLSearchParams(window.location.search).get('review');
    return id && /^rev-[0-9a-f]{24}$/.test(id) ? id : null;
  }, []);
  const loadList = useCallback(async () => {
    try {
      const [s, l0] = await Promise.all([api.get(`${API}/status`), api.get(`${API}/reviews`)]);
      // A link from chat (?review=rev-…) opens that review, adding it to the list when this machine did not submit it.
      const l =
        linked && !l0.reviews.some((r) => r.reviewId === linked)
          ? await api.post(`${API}/reviews/track`, { reviewId: linked }).catch(() => l0)
          : l0;
      setStatus(s);
      setReviews(l.reviews);
      setListSource(l.source);
      setListHasMore(Boolean(l.nextToken));
      setSummaries((m) => ({ ...fromList(l.reviews), ...m }));
      setSelected((cur) => cur || linked || null);
      setLoadedAt(Date.now());
      setSignIn(false);
    } catch (e) {
      setError(parseApiError(e));
      setSignIn(needsKiroSignIn(apiErrorCode(e)));
    }
  }, [api, linked]);
  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadReview = useCallback(async () => {
    if (!selected) return;
    try {
      const r = await api.get(`${API}/reviews/${selected}${iteration ? `?iteration=${iteration}` : ''}`);
      setReview(r);
      setError('');
      setSummaries((m) => ({ ...m, [r.reviewId]: summarize(r) }));
      if (!iteration) setPreviews((m) => ({ ...m, [r.reviewId]: r }));
    } catch (e) {
      setError(parseApiError(e));
      setSignIn(needsKiroSignIn(apiErrorCode(e)));
    }
  }, [api, selected, iteration]);

  useEffect(() => {
    setReview(null);
    setSent(null);
    setError('');
  }, [selected]);
  const shownIteration = review && review.reviewId === selected ? review.iteration.number : 0;
  const loadSent = useCallback(async () => {
    if (!selected || !shownIteration) return;
    try {
      const r = await api.get(`${API}/reviews/${selected}/iterations/${shownIteration}/sent`);
      setSent(r);
      setSentError('');
    } catch (e) {
      setSent(null);
      setSentError(parseApiError(e));
    }
  }, [api, selected, shownIteration]);
  useEffect(() => {
    loadSent();
  }, [loadSent]);
  useEffect(() => {
    loadReview();
  }, [loadReview]);
  useEffect(() => {
    if (!review || review.terminal) return undefined;
    const t = setInterval(loadReview, POLL_MS);
    return () => clearInterval(t);
  }, [review, loadReview]);

  // Full status (and the gate panel's data) for the first few reviews in the list, one at a time.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const r of reviews.slice(0, LIST_STATUS_MAX)) {
        if (cancelled || previews[r.reviewId] || r.reviewId === selected) continue;
        try {
          const v = await api.get(`${API}/reviews/${r.reviewId}`);
          if (cancelled) continue;
          setSummaries((m) => ({ ...m, [v.reviewId]: summarize(v) }));
          setPreviews((m) => ({ ...m, [v.reviewId]: v }));
        } catch {
          // The detail view reports errors; the list just shows no dot.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, reviews]);

  useEffect(() => {
    if (expanded !== undefined) return;
    const first = reviews.find((r) => reviewBand(summaries[r.reviewId]) === 'red');
    if (first) setExpanded(first.reviewId);
  }, [expanded, reviews, summaries]);

  // An expanded row the list fetch did not cover loads on demand.
  useEffect(() => {
    if (!expanded || previews[expanded]) return undefined;
    let cancelled = false;
    api
      .get(`${API}/reviews/${expanded}`)
      .then((v) => {
        if (cancelled) return;
        setPreviews((m) => ({ ...m, [v.reviewId]: v }));
        setSummaries((m) => ({ ...m, [v.reviewId]: summarize(v) }));
      })
      .catch((e) => !cancelled && notify(`Could not load ${shortId(expanded)}: ${parseApiError(e)}`));
    return () => {
      cancelled = true;
    };
  }, [api, expanded, previews, notify]);

  const openReview = useCallback((id) => {
    setSelected(id);
    setIteration(null);
  }, []);
  const closeReview = useCallback(() => {
    setSelected(null);
    setIteration(null);
    setReview(null);
    setError('');
  }, []);

  const [switchingRegion, setSwitchingRegion] = useState(false);
  const changeRegion = useCallback(
    async (region) => {
      setSwitchingRegion(true);
      try {
        await api.post(`${API}/kiro-region`, { region });
        closeReview();
        setReviews([]);
        setSummaries({});
        setPreviews({});
        setExpanded(undefined);
        setLoadedAt(0);
        await loadList();
      } catch (e) {
        notify(`Could not switch region: ${parseApiError(e)}`);
      } finally {
        setSwitchingRegion(false);
      }
    },
    [api, closeReview, loadList, notify],
  );

  const track = useCallback(
    async (id) => {
      setTracking(true);
      setTrackError('');
      try {
        const out = await api.post(`${API}/reviews/track`, { reviewId: id });
        setReviews(out.reviews);
        setListSource(out.source);
        setListHasMore(Boolean(out.nextToken));
        setExpanded(id);
        setTracking(false);
        return true;
      } catch (e) {
        setTrackError(parseApiError(e));
        setTracking(false);
        return false;
      }
    },
    [api],
  );

  const entry = reviews.find((r) => r.reviewId === selected);
  const configured = !status || status.configured;
  const goSignIn = useCallback(() => navigate(KIRO_SIGN_IN_ROUTE), [navigate]);

  return h('div', { className: 'kcr' }, [
    h('header', { key: 'hd', className: 'kcr-head' }, [
      h('div', { key: 't' }, [
        h('div', { key: 'a', className: 'kcr-title' }, 'Kiro Reviewer'),
        h(
          'div',
          { key: 'b', className: 'kcr-sub' },
          'AI reviews of your changes before you open a PR. Click a review to see its findings.',
        ),
      ]),
      h('span', { key: 'sp', className: 'kcr-spacer' }),
      view === 'reviews'
        ? h(
            'button',
            {
              key: 'rf',
              className: 'kcr-btn',
              onClick: () => {
                loadList();
                loadReview();
                loadSent();
              },
            },
            '↻ Refresh',
          )
        : null,
      h(ViewTabs, { key: 'tabs', value: view, onChange: setView }),
    ]),
    view === 'settings'
      ? h('main', { key: 'set', className: 'kcr-main' }, [
          status && status.kiroRegion
            ? h(RegionCard, {
                key: 'rg',
                region: status.kiroRegion,
                disabled: switchingRegion,
                onChange: changeRegion,
              })
            : null,
          keyLoaded ? h(ApiKeyCard, { key: 'ak', apiKey }) : null,
        ])
      : !configured
        ? h(
            'div',
            { key: 'cfg', className: 'kcr-main' },
            needsKiroSignIn(status.code)
              ? h(SignInBanner, { onSignIn: goSignIn })
              : h(
                  'div',
                  { className: 'kcr-banner warn' },
                  h('div', null, [
                    h('b', { key: 'b' }, 'Service endpoint is not configured'),
                    h(
                      'span',
                      { key: 's', style: { color: 'var(--muted,#7f7f88)' } },
                      `${status.message} Set "endpoint" in the app's data/config.json.`,
                    ),
                  ]),
                ),
          )
        : h(
            'main',
            { key: 'm', className: 'kcr-main' },
            selected
              ? [
                  keyPrompt,
                  h('button', { key: 'back', className: 'kcr-btn kcr-back', onClick: closeReview }, '← All reviews'),
                  error && signIn
                    ? h(SignInBanner, { key: 'e', onSignIn: goSignIn })
                    : error
                      ? h(
                          'div',
                          { key: 'e', className: 'kcr-banner bad' },
                          h('div', null, [
                            h('b', { key: 'b' }, 'Could not load this review'),
                            h('span', { key: 's', style: { color: 'var(--muted,#7f7f88)' } }, error),
                          ]),
                        )
                      : null,
                  review
                    ? h(ReviewDetail, {
                        key: 'd',
                        review,
                        entry,
                        onIteration: setIteration,
                        api,
                        onChanged: loadReview,
                        notify,
                        sent,
                        sentError,
                        openChat,
                      })
                    : !error
                      ? h('div', { key: 'x', className: 'kcr-empty' }, 'Loading review…')
                      : null,
                ]
              : [
                  keyPrompt,
                  error && signIn
                    ? h(SignInBanner, { key: 'e', onSignIn: goSignIn })
                    : error
                      ? h(
                          'div',
                          { key: 'e', className: 'kcr-banner bad' },
                          h('div', null, [
                            h('b', { key: 'b' }, 'Could not load your reviews'),
                            h('span', { key: 's', style: { color: 'var(--muted,#7f7f88)' } }, error),
                          ]),
                        )
                      : null,
                  h(ReviewOverview, {
                    key: 'ov',
                    reviews,
                    summaries,
                    previews,
                    expanded,
                    onExpand: setExpanded,
                    onOpen: openReview,
                    onTrack: track,
                    trackError,
                    tracking,
                    source: listSource,
                    loading: !loadedAt && !error,
                    hasMore: listHasMore,
                    loadedAt,
                  }),
                ],
          ),
    toast ? h('div', { key: 'toast', className: 'kcr-toast', role: 'status' }, toast) : null,
  ]);
}

/** Status dots from the list API; the stub list has no status. */
function fromList(reviews) {
  const out = {};
  for (const r of reviews) {
    if (r.status && r.counts) {
      out[r.reviewId] = {
        status: r.status,
        outcome: r.status === 'COMPLETED' ? (r.counts.active > 0 ? 'FINDINGS' : 'NO_FINDINGS') : '',
        blocking: r.counts.blocking,
        active: r.counts.active,
        suppressed: r.counts.suppressed,
        resolved: r.counts.resolved,
        level: r.level,
        iteration: r.latestIteration,
        updatedAt: r.updatedAt,
      };
    }
  }
  return out;
}

function summarize(r) {
  return {
    status: r.iteration.status,
    outcome: r.iteration.outcome,
    blocking: r.iteration.counts.blocking,
    active: r.iteration.counts.active,
    suppressed: r.iteration.counts.suppressed,
    resolved: r.iteration.counts.resolved,
    level: r.level,
    iteration: r.iteration.number,
    budget: r.iterationBudget,
    updatedAt: r.updatedAt,
  };
}
