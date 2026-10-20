// Finds and fills one-time-code fields on a page. Loaded as a content script before
// content.js; kept free of chrome.* calls so it can be tested in a plain DOM.
(() => {
  const POSITIVE =
    /\b(otp|totp|2fa|mfa|one ?time|two ?factor|2 ?step|authenticator|verification|verify|security code|auth code|authentication code|passcode|code|token|pin)\b/;
  const NEGATIVE =
    /\b(zip|postal|post ?code|promo|promotion|coupon|discount|gift|voucher|referral|invite|invitation|country|area|phone|captcha|card|cvv|cvc|csc|search|tax|vat|swift|iban|sort ?code|routing)\b/;
  const FILLABLE_TYPES = new Set(['', 'text', 'tel', 'number']);

  const normalize = (s) =>
    String(s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-.[\]]+/g, ' ')
      .toLowerCase();

  function isVisible(el) {
    if (el.hidden) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true });
    }
    const win = el.ownerDocument.defaultView;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function isFillable(el) {
    return (
      el.tagName === 'INPUT' &&
      FILLABLE_TYPES.has((el.getAttribute('type') || '').toLowerCase()) &&
      !el.disabled &&
      !el.readOnly &&
      isVisible(el)
    );
  }

  function describe(el) {
    const doc = el.ownerDocument;
    const parts = [el.name, el.id, el.placeholder, el.title, el.getAttribute('aria-label'), el.autocomplete];
    for (const label of el.labels || []) parts.push(label.textContent);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      parts.push(doc.getElementById(id)?.textContent);
    }
    return normalize(parts.filter(Boolean).join(' '));
  }

  function looksLikeOtp(el) {
    if ((el.getAttribute('autocomplete') || '').toLowerCase().includes('one-time-code')) return 'strong';
    const text = describe(el);
    return POSITIVE.test(text) && !NEGATIVE.test(text) ? 'weak' : null;
  }

  function findSplit(candidates) {
    const boxes = candidates.filter((el) => el.maxLength === 1);
    if (boxes.length < 4) return null;
    for (let level = 1; level <= 4; level++) {
      const groups = new Map();
      for (const box of boxes) {
        let parent = box;
        for (let i = 0; i < level && parent; i++) parent = parent.parentElement;
        if (!parent) continue;
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(box);
      }
      for (const group of groups.values()) {
        if (group.length >= 4 && group.length <= 8 && !group[0].value) return group;
      }
    }
    return null;
  }

  function findOtpTarget(doc) {
    const candidates = [...doc.querySelectorAll('input')].filter(isFillable);
    const singles = candidates.filter((el) => el.maxLength !== 1 && !el.value);

    const strong = singles.find((el) => looksLikeOtp(el) === 'strong');
    if (strong) return { kind: 'single', input: strong };

    const split = findSplit(candidates);
    if (split) return { kind: 'split', inputs: split };

    const weak = singles.find((el) => looksLikeOtp(el) === 'weak');
    if (weak) return { kind: 'single', input: weak };
    return null;
  }

  // Set the value the way a user would, so React/Vue/Angular notice the change.
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function key(el, type, ch) {
    const code = /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`; // Steam codes have letters
    el.dispatchEvent(new KeyboardEvent(type, { key: ch, code, bubbles: true }));
  }

  function fillTarget(target, code) {
    if (target.kind === 'single') {
      target.input.focus();
      setValue(target.input, code);
      return;
    }
    target.inputs.forEach((box, i) => {
      const ch = code[i] ?? '';
      box.focus();
      key(box, 'keydown', ch);
      setValue(box, ch);
      key(box, 'keyup', ch);
    });
  }

  const SUBMIT_TEXT = /verify|submit|continue|confirm|sign ?in|log ?in|next|done|authenticate/i;

  function submitTarget(target) {
    const input = target.kind === 'single' ? target.input : target.inputs[target.inputs.length - 1];
    if (input.form) {
      if (typeof input.form.requestSubmit === 'function') input.form.requestSubmit();
      else input.form.submit();
      return true;
    }
    let scope = input.parentElement;
    for (let i = 0; i < 6 && scope; i++, scope = scope.parentElement) {
      const button = [...scope.querySelectorAll('button, input[type=submit], [role=button]')].find(
        (b) => !b.disabled && SUBMIT_TEXT.test(b.textContent || b.value || '')
      );
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }

  // ---------- who is signing in ----------

  const USERNAME = /\b(user|username|user ?name|user ?id|email|e ?mail|login|login ?id|account|identifier|loginfmt)\b/;
  const USERNAME_TYPES = new Set(['', 'text', 'email']);
  const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

  function isUsernameField(el) {
    if (el?.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (!USERNAME_TYPES.has(type) || looksLikeOtp(el)) return false;
    if (type === 'email' || /username|email/i.test(el.getAttribute('autocomplete') || '')) return true;
    return USERNAME.test(describe(el));
  }

  // Usernames the code page itself carries: hidden or read-only username fields, and
  // email addresses in the visible text ("Signed in as bob@acme.com").
  function findIdentityHints(doc) {
    const hints = new Set();
    for (const el of doc.querySelectorAll('input')) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password' || !el.value || looksLikeOtp(el)) continue;
      const attrs = normalize([el.name, el.id, el.autocomplete].join(' '));
      if (type === 'email' || USERNAME.test(attrs)) hints.add(el.value.trim());
    }
    const text = doc.body ? (doc.body.innerText ?? doc.body.textContent) : '';
    for (const email of text.match(EMAIL) || []) {
      if (hints.size >= 20) break;
      hints.add(email);
    }
    return [...hints];
  }

  // ---------- setup keys printed for manual entry ----------

  // "JBSW Y3DP EHPK 3PXP" (groups of 4) or one long run, using only base32 characters.
  const KEY_SHAPE = /(?:^|[^A-Za-z0-9])((?:[A-Za-z2-7]{4}[ -]){3,}[A-Za-z2-7]{1,4}|[A-Za-z2-7]{16,})(?![A-Za-z0-9])/g;
  const KEY_CONTEXT = /\b(secret|key|setup|set up|manual|manually|authenticator|can'?t scan|cannot scan|enter this|2fa|two.?factor|totp)\b/i;

  function pageText(doc) {
    // Text nodes joined by line breaks, so text in neighbouring elements never runs together.
    const parts = [];
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const tag = node.parentElement?.tagName;
      if (tag !== 'SCRIPT' && tag !== 'STYLE' && node.nodeValue.trim()) parts.push(node.nodeValue);
    }
    return parts.join('\n');
  }

  function keysIn(text, contextFor) {
    const keys = [];
    for (const m of text.matchAll(KEY_SHAPE)) {
      const key = m[1].replace(/[ -]/g, '').toUpperCase();
      // Real keys are random, so they almost always contain one of the digits 2-7.
      if (key.length < 16 || key.length > 128 || !/[2-7]/.test(key) || !/[A-Z]/.test(key)) continue;
      if (KEY_CONTEXT.test(contextFor(m.index))) keys.push(key);
    }
    return keys;
  }

  // Secret keys a setup page shows for people who can't scan its QR code.
  function findSetupKeys(doc) {
    const found = new Set();
    const text = pageText(doc);
    for (const key of keysIn(text, (i) => text.slice(Math.max(0, i - 200), i + 1))) found.add(key);
    for (const el of doc.querySelectorAll('input, textarea')) {
      if ((el.getAttribute('type') || '').toLowerCase() === 'password' || !el.value) continue;
      for (const key of keysIn(el.value, () => describe(el))) found.add(key);
    }
    return [...found];
  }

  globalThis.OtpDetect = {
    findOtpTarget, fillTarget, submitTarget, isUsernameField, findIdentityHints, findSetupKeys,
  };
})();
