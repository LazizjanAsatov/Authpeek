// Watches the page for a verification-code field and fills it when the background
// worker says which linked account it is for. Also notes the username typed during
// login, so sites with several accounts get the right code.
(() => {
  if (globalThis.__authPeekLoaded) return;
  globalThis.__authPeekLoaded = true;

  const { findOtpTarget, fillTarget, submitTarget, isUsernameField, findIdentityHints } = globalThis.OtpDetect;
  const asked = new WeakSet();
  let lastTarget = null;
  let scanTimer = null;
  let lockedNoticeShown = false;
  let chooseNoticeShown = false;

  const anchorOf = (t) => (t.kind === 'single' ? t.input : t.inputs[0]);

  // When AuthPeek is reloaded or removed, this copy keeps running in already-open tabs
  // but can no longer reach the extension; sendMessage then throws right away. Stop quietly.
  const listeners = [];
  let observer = null;
  function on(type, handler) {
    document.addEventListener(type, handler, true);
    listeners.push([type, handler]);
  }
  function shutDown() {
    observer?.disconnect();
    clearTimeout(scanTimer);
    for (const [type, handler] of listeners) document.removeEventListener(type, handler, true);
  }
  function send(message) {
    try {
      if (!chrome.runtime?.id) throw new Error('disconnected');
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      shutDown();
      return Promise.resolve(null);
    }
  }

  function focusedInput() {
    const el = document.activeElement;
    return el?.tagName === 'INPUT' && !el.disabled && !el.readOnly ? { kind: 'single', input: el } : null;
  }

  function currentTarget() {
    const fresh = findOtpTarget(document);
    if (fresh) lastTarget = fresh;
    if (lastTarget && anchorOf(lastTarget).isConnected) return lastTarget;
    return focusedInput();
  }

  function fill(target, { code, name, autoSubmit }) {
    fillTarget(target, code);
    toast(`Code filled for ${name}`);
    if (autoSubmit) setTimeout(() => submitTarget(target), 300);
  }

  async function scan() {
    const target = findOtpTarget(document);
    if (!target) return;
    lastTarget = target;
    const anchor = anchorOf(target);
    if (asked.has(anchor)) return;
    asked.add(anchor);

    const reply = await send({ type: 'otp:found', hints: findIdentityHints(document) });
    if (reply?.status === 'fill' && anchor.isConnected) fill(target, reply);
    else if (reply?.status === 'locked' && !lockedNoticeShown) {
      lockedNoticeShown = true;
      toast('AuthPeek is locked. Click the extension icon to fill this code.');
    } else if (reply?.status === 'choose' && reply.count > 1 && !chooseNoticeShown) {
      chooseNoticeShown = true;
      toast(`This site has ${reply.count} accounts in AuthPeek. Click the AuthPeek icon to choose one.`);
    }
  }

  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'otp:status') {
      if (findOtpTarget(document) || lastTarget?.input?.isConnected || lastTarget?.inputs?.[0]?.isConnected) {
        sendResponse({ hasTarget: true, hints: findIdentityHints(document) });
      }
      return false; // frames without a field stay silent so another frame can answer
    }
    if (msg?.type === 'otp:links') {
      // Setup pages often carry the otpauth:// link: as a link, in a field, or as text.
      const sources = [
        ...[...document.querySelectorAll('a[href^="otpauth"]')].map((a) => a.getAttribute('href')),
        ...[...document.querySelectorAll('input, textarea')].map((el) => el.value),
        document.body?.innerText || '',
      ];
      const links = [...new Set(sources.join('\n').match(/otpauth(?:-migration)?:\/\/[^\s"'<>`]+/gi) || [])];
      if (links.length) sendResponse({ links });
      return false;
    }
    if (msg?.type === 'otp:fill') {
      const target = currentTarget();
      if (!target) return false;
      fill(target, msg);
      sendResponse({ filled: true });
    }
    return false;
  });

  // Fields often appear after the password step without a page load.
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'disabled'],
  });
  on('focusin', (e) => e.target?.tagName === 'INPUT' && scheduleScan());

  // Remember the username typed on the sign-in step (it's usually gone by the code step).
  let lastSent = '';
  function noteUsername(el) {
    const value = el?.value?.trim();
    if (!value || value === lastSent || !isUsernameField(el)) return;
    lastSent = value;
    send({ type: 'otp:username', value });
  }
  on('change', (e) => noteUsername(e.target));
  on('focusout', (e) => noteUsername(e.target));
  on('submit', (e) => e.target?.querySelectorAll?.('input').forEach((el) => noteUsername(el)));
  on('keydown', (e) => e.key === 'Enter' && noteUsername(e.target));
  scan();

  // Small notice in the corner. Closed shadow DOM keeps the page's CSS out.
  let toastHost = null;
  let toastTimer = null;
  function toast(text) {
    if (!toastHost) {
      toastHost = document.createElement('authpeek-toast');
      const root = toastHost.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          div {
            position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; max-width: 320px;
            display: flex; gap: 10px; align-items: center;
            padding: 11px 14px; border-radius: 10px;
            font: 500 13px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
            color: #FAFBFC; background: #1A2130; box-shadow: 0 6px 24px rgb(26 33 48 / .28);
            opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s;
          }
          div.show { opacity: 1; transform: none; }
          i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #3FC1A8; }
          @media (prefers-reduced-motion: reduce) { div { transition: none; } }
        </style>
        <div role="status"><i></i><span></span></div>`;
      toastHost._box = root.querySelector('div');
      toastHost._text = root.querySelector('span');
    }
    if (!toastHost.isConnected) document.documentElement.appendChild(toastHost);
    toastHost._text.textContent = text;
    requestAnimationFrame(() => toastHost._box.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastHost._box.classList.remove('show'), 3200);
  }
})();
