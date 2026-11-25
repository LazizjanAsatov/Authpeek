// Watches the page for a verification-code field and fills it when the background
// worker says which linked account it is for. Also notes the username typed during
// login, so sites with several accounts get the right code.
(() => {
  if (globalThis.__authPeekLoaded) return;
  globalThis.__authPeekLoaded = true;

  const {
    findOtpTarget, fillTarget, submitTarget, filledWith, isUsernameField, findIdentityHints, findSetupKeys,
    spacedCode, suggestText, networkText,
  } = globalThis.OtpDetect;
  // A cheap first filter only: it is per element and per page load. The real "fill once"
  // limit lives in the background (lib/attempts.js), where a reload can't reset it.
  const asked = new WeakSet();
  let lastTarget = null;
  let scanTimer = null;
  let lockedNoticeShown = false;
  let chooseNoticeShown = false;
  let networkNoticeShown = false;
  let card = null; // the suggestion card (see below)
  let cardBusy = false;
  let cardDismissed = false;
  // This frame's host, as the background names it in otp:status, otp:fill and otp:card-filled.
  const ownHost = () => location.hostname.toLowerCase();

  const anchorOf = (t) => (t.kind === 'single' ? t.input : t.inputs[0]);
  // The form a Verify press would submit (the last box, for split fields).
  const formOf = (t) => (t.kind === 'single' ? t.input : t.inputs[t.inputs.length - 1])?.form || null;

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
    closeCard();
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

  // The box last right-clicked, for "AuthPeek ▸ …" in the context menu.
  let rightClicked = null;
  function contextMenuTarget() {
    const el = rightClicked;
    if (!el?.isConnected || !['INPUT', 'TEXTAREA'].includes(el.tagName) || el.disabled || el.readOnly) return null;
    const detected = findOtpTarget(document) || lastTarget;
    if (detected?.kind === 'split' && detected.inputs.includes(el)) return detected; // one of the 6 boxes
    return { kind: 'single', input: el };
  }

  // Watches, until stop(), for the page submitting `form` or starting to leave (capture phase,
  // so the page can't hide it). stop() removes the listeners and says whether either happened.
  // Added only for the 300 ms around a fill: a lasting beforeunload listener costs pages the
  // back/forward cache in some browsers.
  function watchSubmit(form) {
    let fired = false;
    const onLeave = () => {
      fired = true;
    };
    const onSubmit = (e) => {
      if (form && e.target === form) fired = true;
    };
    window.addEventListener('beforeunload', onLeave, true);
    window.addEventListener('pagehide', onLeave, true);
    document.addEventListener('submit', onSubmit, true);
    return {
      stop() {
        window.removeEventListener('beforeunload', onLeave, true);
        window.removeEventListener('pagehide', onLeave, true);
        document.removeEventListener('submit', onSubmit, true);
        return fired;
      },
    };
  }

  // Returns true when the code was put in.
  function fill(target, { code, name, autoSubmit }) {
    if (typeof code !== 'string' || !code) return false;
    // Started before the first digit goes in: many sites submit on the last digit.
    const watch = autoSubmit ? watchSubmit(formOf(target)) : null;
    fillTarget(target, code);
    toast(`Code filled for ${name}`);
    // Press Verify only if the page didn't submit the field's form or start leaving by itself
    // (a full-page form.submit() keeps the field's value until the page unloads), and the field
    // still holds this code (not cleared or re-rendered): pressing again is a second attempt.
    if (watch) {
      setTimeout(() => {
        const submitted = watch.stop();
        if (!submitted && filledWith(target, code)) submitTarget(target);
      }, 300);
    }
    return true;
  }

  async function scan() {
    const target = findOtpTarget(document);
    if (!target) return;
    lastTarget = target;
    const anchor = anchorOf(target);
    if (asked.has(anchor)) return;
    asked.add(anchor);

    const reply = await send({ type: 'otp:found', hints: findIdentityHints(document) });
    if (reply?.status === 'fill') {
      // The background has already counted this automatic fill, so a field the site re-rendered
      // while we waited (the network check can take seconds) gets it instead of losing it.
      // Only a detected code field: an automatic fill never goes into whatever box has focus.
      const into = anchor.isConnected ? target : findOtpTarget(document);
      if (into) {
        lastTarget = into;
        asked.add(anchorOf(into));
        fill(into, reply);
      }
    } else if (reply?.status === 'suggest') showCard(reply);
    else if (reply?.status === 'network' && !networkNoticeShown) {
      networkNoticeShown = true;
      toast(networkText(reply.reason));
    } else if (reply?.status === 'locked' && !lockedNoticeShown) {
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
      // Same rule as otp:fill: only a frame on the host the question is for answers, so a
      // third-party frame can't make the popup offer a fill this page would then refuse.
      if (typeof msg.host !== 'string' || msg.host !== ownHost()) return false;
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
      const keys = links.length ? [] : findSetupKeys(document); // a printed key, for people who can't scan
      if (links.length || keys.length) sendResponse({ links, keys });
      return false;
    }
    if (msg?.type === 'otp:fill') {
      // Every sender names the host it resolved the code for. A frame on any other host
      // (a third-party iframe, or a frame that navigated meanwhile) never fills it, and a
      // message without a host is refused.
      if (typeof msg.host !== 'string' || msg.host !== ownHost()) {
        sendResponse({ filled: false });
        return false;
      }
      const target = (msg.useContextTarget && contextMenuTarget()) || currentTarget();
      if (!target) return false;
      sendResponse({ filled: fill(target, msg) });
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
  on('contextmenu', (e) => {
    rightClicked = e.target;
  });

  // Remember the username typed on the sign-in step (it's usually gone by the code step).
  let lastSent = '';
  function noteUsername(el) {
    // Only text boxes have text values; list items and progress bars have numbers.
    const value = typeof el?.value === 'string' ? el.value.trim() : '';
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

  // ---------- suggestion card ----------
  // Shown instead of a second automatic fill. One per page; a new suggestion updates it.
  // Its buttons only react to real clicks/keys (isTrusted), so the page can't press them,
  // and its Fill never presses Verify.
  function buildCard() {
    const host = document.createElement('authpeek-card');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          position: fixed; z-index: 2147483647; right: 20px; top: 20px; width: 340px; max-width: calc(100vw - 40px);
          box-sizing: border-box; padding: 14px 40px 14px 16px; border-radius: 12px;
          font: 400 13px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
          color: #FAFBFC; background: #1A2130; box-shadow: 0 8px 28px rgb(26 33 48 / .32);
        }
        p { margin: 0 0 10px; }
        .next { color: #F5C26B; }
        .fill {
          font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1; padding: 9px 14px; border: 0; border-radius: 8px;
          color: #0E1520; background: #3FC1A8; cursor: pointer; font-variant-numeric: tabular-nums;
        }
        .fill:disabled { opacity: .5; cursor: default; }
        .close {
          position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; border: 0; border-radius: 6px;
          font-family: inherit; font-size: 18px; line-height: 1; color: #C9D1DC; background: transparent; cursor: pointer;
        }
        .close:hover { background: rgb(255 255 255 / .08); }
        button:focus-visible { outline: 2px solid #8FD9C9; outline-offset: 2px; }
      </style>
      <div class="card" role="alertdialog" aria-label="AuthPeek didn't fill this code again" aria-describedby="main">
        <p class="main" id="main"></p>
        <p class="next" hidden></p>
        <button class="fill" type="button"></button>
        <button class="close" type="button" aria-label="Close">×</button>
      </div>`;
    const c = {
      host,
      box: root.querySelector('.card'),
      main: root.querySelector('.main'),
      next: root.querySelector('.next'),
      fillBtn: root.querySelector('.fill'),
      closeBtn: root.querySelector('.close'),
      code: '',
      until: 0,
      timer: null,
    };
    c.fillBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      fillFromCard();
    });
    c.closeBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      dismissCard();
    });
    c.box.addEventListener('keydown', (e) => {
      if (!e.isTrusted || e.key !== 'Escape') return;
      e.stopPropagation();
      dismissCard();
    });
    return c;
  }

  // Button state: disabled while the code shown is the one just tried, or while asking.
  function refreshCard() {
    if (!card) return;
    const left = Math.ceil((card.until - Date.now()) / 1000);
    if (left > 0) {
      card.next.hidden = false;
      card.next.textContent = suggestText({ nextIn: left }).next;
      card.fillBtn.textContent = `Fill ${spacedCode(card.code)}`;
      card.fillBtn.disabled = true;
      return;
    }
    clearInterval(card.timer);
    card.timer = null;
    card.next.hidden = true;
    // After a countdown the shown code is old; the click fetches the new one anyway.
    card.fillBtn.textContent = card.until ? 'Fill the new code' : `Fill ${spacedCode(card.code)}`;
    card.fillBtn.disabled = cardBusy;
  }

  function showCard(reply) {
    // Closed with × or Escape: stays closed on this page, even if the site re-renders the field.
    if (cardDismissed) {
      send({ type: 'otp:card-closed' });
      return;
    }
    if (!card) card = buildCard();
    card.main.textContent = suggestText(reply).main;
    card.code = typeof reply.code === 'string' ? reply.code : '';
    clearInterval(card.timer);
    card.timer = null;
    const nextIn = Number(reply.nextIn);
    card.until = Number.isFinite(nextIn) && nextIn > 0 ? Date.now() + nextIn * 1000 : 0;
    if (card.until) card.timer = setInterval(refreshCard, 1000);
    refreshCard();
    if (!card.host.isConnected) document.documentElement.appendChild(card.host);
  }

  // Closed by the user: also clears the '!' badge.
  function dismissCard() {
    cardDismissed = true;
    closeCard();
    send({ type: 'otp:card-closed' });
  }

  function closeCard() {
    if (!card) return;
    clearInterval(card.timer);
    card.timer = null;
    card.host.remove();
  }

  async function fillFromCard() {
    if (!card || cardBusy) return;
    cardBusy = true;
    card.fillBtn.disabled = true;
    try {
      // Asks again: a fresh code, the network check and the account pick happen in the background.
      const reply = await send({ type: 'otp:fill-suggested', hints: findIdentityHints(document) });
      if (reply?.status === 'fill') {
        const target = currentTarget();
        if (!target) {
          toast("Couldn't find the code box. Click in it, then use the AuthPeek icon.");
          return;
        }
        if (fill(target, { code: reply.code, name: reply.name, autoSubmit: false })) {
          // Only now does the background record this fill and clear the '!' badge.
          send({ type: 'otp:card-filled', host: ownHost() });
          closeCard();
        }
      } else if (reply?.status === 'network') {
        toast(networkText(reply.reason));
      } else if (reply?.status === 'locked') {
        toast('AuthPeek is locked. Click the extension icon to fill this code.');
      } else if (reply?.status === 'choose') {
        toast('Click the AuthPeek icon to choose which account to fill.');
      } else {
        toast("AuthPeek couldn't get a code. Click the AuthPeek icon to fill it.");
      }
    } finally {
      cardBusy = false;
      refreshCard();
    }
  }
})();
