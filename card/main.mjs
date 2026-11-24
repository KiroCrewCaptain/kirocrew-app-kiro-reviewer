// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs inside the sandboxed MCP Apps iframe. Speaks JSON-RPC over postMessage with the Crew host:
// ui/initialize -> ui/notifications/initialized -> tool-input, tool-result; reports its height back.
import { copyText, renderCard } from './render.mjs';

const PROTOCOL = '2025-11-21';
const root = document.getElementById('root');
let seq = 0;
let latest = null;

const send = (msg) => parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');

function applyTheme(ctx) {
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme === 'light' ? 'light' : 'dark';
  const vars = ctx.styles && ctx.styles.variables;
  if (!vars || typeof vars !== 'object') return;
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
  }
}

function reportSize() {
  const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
  if (h > 0) send({ method: 'ui/notifications/size-changed', params: { height: h } });
}

function render(data) {
  latest = data;
  const html = renderCard(data);
  root.innerHTML = html == null ? '<div class="muted pad">No card for this result.</div>' : html;
  reportSize();
}

function copy(text, button) {
  const done = () => {
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = old), 1500);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? done() : (button.textContent = 'Copy blocked');
    } catch {
      button.textContent = 'Copy blocked';
    }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button[data-act]') : null;
  if (b && latest) copy(copyText(latest, b.getAttribute('data-act')), b);
  setTimeout(reportSize, 0);
});
document.addEventListener('toggle', () => reportSize(), true);
new ResizeObserver(reportSize).observe(document.body);

window.addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.method === 'ui/notifications/tool-result') {
    const p = m.params || {};
    render(p.structuredContent || null);
  } else if (m.method === 'ui/notifications/host-context-changed' && m.params) {
    applyTheme(m.params);
  }
});

const initId = ++seq;
window.addEventListener('message', function onInit(e) {
  const m = e.data;
  if (e.source !== parent || !m || m.id !== initId) return;
  window.removeEventListener('message', onInit);
  const ctx = (m.result && m.result.hostContext) || {};
  applyTheme(ctx);
  send({ method: 'ui/notifications/initialized', params: {} });
});
send({
  id: initId,
  method: 'ui/initialize',
  params: {
    protocolVersion: PROTOCOL,
    appInfo: { name: 'kiro-code-reviewer-card', version: '0.1.0' },
    appCapabilities: {},
  },
});
