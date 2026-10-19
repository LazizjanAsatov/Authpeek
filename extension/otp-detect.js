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
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function key(el, type, ch) {
    el.dispatchEvent(new KeyboardEvent(type, { key: ch, code: `Digit${ch}`, bubbles: true }));
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

  globalThis.OtpDetect = { findOtpTarget, fillTarget, submitTarget, isUsernameField, findIdentityHints };
})();
