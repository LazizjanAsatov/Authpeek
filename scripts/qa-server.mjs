// Tiny QA server for AuthPeek auto-fill. Node built-ins only.
// Run from the repository root: node scripts/qa-server.mjs   ->   http://localhost:8765
import http from 'node:http';

const PORT = 8765;
const HOST = '127.0.0.1';
const PAGES = ['/loop', '/spa', '/digits'];
const stats = Object.fromEntries(PAGES.map((p) => [p, { attempts: 0, last: [] }]));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function record(page, code) {
  const s = stats[page];
  s.attempts += 1;
  s.last.push(code);
  if (s.last.length > 10) s.last.shift();
  console.log(`[attempt] ${page} #${s.attempts} code=${code} at ${new Date().toTimeString().slice(0, 8)}`);
}

function layout(name, page, body, { error = false, script = '' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AuthPeek QA – ${name}</title>
<style>
body{font:16px system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px}
#counter{font-size:72px;font-weight:700;line-height:1}
.err{color:#c00;font-weight:600;margin:8px 0}
input{font-size:20px;padding:6px}
.digits input{width:2em;text-align:center;margin-right:4px}
button{font-size:16px;padding:6px 14px}
</style></head><body>
<p>Signed in as qa@example.com</p>
<h1>${name}</h1>
${stats[page] ? `<div>Attempts on this page:</div>
<div id="counter" data-page="${page}">${stats[page].attempts}</div>
<div id="msg" class="err">${error ? 'Invalid code' : ''}</div>` : ''}
${body}
<p><a href="/">Index</a> | <a href="/stats">Stats</a> | <a href="/reset">Reset</a></p>
${script}
</body></html>`;
}

const loopForm = `<form id="f" method="post" action="/loop">
<input autocomplete="one-time-code" name="otp" inputmode="numeric" autofocus>
<button type="submit">Verify</button></form>`;

const spaForm = `<form id="f">
<span id="slot"><input autocomplete="one-time-code" name="otp" inputmode="numeric" autofocus></span>
<button type="submit">Verify</button></form>`;

const spaScript = `<script>
let local = 0;
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = e.target.querySelector('input[name=otp]').value;
  local++;
  let server = '?';
  try {
    const r = await fetch('/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: '/spa', code }) });
    server = (await r.json()).attempts;
  } catch {}
  document.getElementById('counter').textContent = server;
  document.getElementById('msg').textContent = 'Invalid code (client attempts: ' + local + ')';
  // Simulate a React re-render: swap in a brand-new, empty input element.
  const fresh = document.createElement('input');
  fresh.setAttribute('autocomplete', 'one-time-code');
  fresh.name = 'otp';
  fresh.inputMode = 'numeric';
  document.getElementById('slot').replaceChildren(fresh);
  fresh.focus();
});
</script>`;

const digitsForm = `<form id="f" method="post" action="/digits">
<div class="digits" id="boxes">${[0, 1, 2, 3, 4, 5].map((i) => `<input maxlength="1" inputmode="numeric" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" name="d${i}">`).join('')}</div>
<input type="hidden" name="code" id="code"></form>`;

const digitsScript = `<script>
const boxes = [...document.querySelectorAll('#boxes input')];
const form = document.getElementById('f');
boxes.forEach((b, i) => b.addEventListener('input', () => {
  if (b.value.length > 1) b.value = b.value.slice(-1);
  if (b.value && boxes[i + 1]) boxes[i + 1].focus();
  if (boxes.every((x) => x.value.length === 1)) {
    document.getElementById('code').value = boxes.map((x) => x.value).join('');
    form.submit();
  }
}));
boxes[0].focus();
</script>`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(b));
  });
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const html = (b) => send(res, 200, 'text/html', b);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (path === '/') {
      return html(layout('Index', '/', `<ul><li><a href="/loop">/loop</a> – full-reload reject</li>
<li><a href="/spa">/spa</a> – JS re-render reject</li>
<li><a href="/digits">/digits</a> – six boxes, auto-submit</li></ul>`));
    }
    if (path === '/loop') return html(layout('Loop', '/loop', loopForm));
    if (path === '/spa') return html(layout('SPA', '/spa', spaForm, { script: spaScript }));
    if (path === '/digits') return html(layout('Digits', '/digits', digitsForm, { script: digitsScript }));
    if (path === '/stats') return send(res, 200, 'application/json', JSON.stringify(stats, null, 2));
    if (path === '/reset') {
      for (const p of PAGES) stats[p] = { attempts: 0, last: [] };
      console.log('[reset]');
      res.writeHead(302, { location: '/' });
      return res.end();
    }
    return send(res, 404, 'text/plain', 'Not found');
  }

  if (req.method === 'POST') {
    const raw = await readBody(req);
    if (path === '/loop') {
      const code = new URLSearchParams(raw).get('otp') ?? '';
      record('/loop', code);
      return html(layout('Loop', '/loop', loopForm, { error: true }));
    }
    if (path === '/digits') {
      const code = new URLSearchParams(raw).get('code') ?? '';
      record('/digits', code);
      return html(layout('Digits', '/digits', digitsForm, { error: true, script: digitsScript }));
    }
    if (path === '/log') {
      let page = '/spa', code = '';
      try { const j = JSON.parse(raw); page = j.page; code = String(j.code ?? ''); } catch {}
      if (!stats[page]) return send(res, 400, 'application/json', '{"error":"unknown page"}');
      record(page, code);
      return send(res, 200, 'application/json', JSON.stringify({ attempts: stats[page].attempts }));
    }
  }
  send(res, 404, 'text/plain', 'Not found');
}).listen(PORT, HOST, () => console.log(`AuthPeek QA server on http://localhost:${PORT}`));
