# Chrome Web Store listing

## Name
AuthPeek – Authenticator & Code Autofill

## Summary (132 characters max)
Your 2-step verification codes in Chrome. Scan QR codes, auto-fill codes on login pages, and sync them encrypted.

## Description
AuthPeek is an authenticator that lives in your browser. It makes the same 6-digit codes as Google Authenticator, and fills them into login pages for you.

Add accounts
• Scan the QR code on a site's 2-step verification setup page
• Upload or paste a screenshot of a QR code
• Type in the secret key
• Move everything over from Google Authenticator with its Transfer accounts QR codes

Auto-fill
• On sites you've linked, the code is filled the moment the page asks for it
• Works with single code boxes and with codes split into separate boxes
• Optional: press Verify for you
• Shortcut: Alt+Shift+O

Safe by design
• Your accounts are encrypted with your password (AES-256) before they're saved
• They sync to your other computers through your Google account, still encrypted
• Codes are only filled on sites you've linked, never on look-alike pages
• You choose when it asks for your password: after a few minutes, when Chrome starts, or never
• Encrypted backups you can download or email to yourself
• No servers, no tracking, no ads

## Category
Productivity

## Single purpose
Generate time-based one-time passwords (2-step verification codes) and fill them into login forms.

## Permission justifications
- **storage**: Saves the user's encrypted accounts and settings (sync storage) and keeps the unlock key in memory while unlocked (session storage). If the user turns off password prompts, the key is kept in local storage on that computer only.
- **activeTab**: Captures the visible tab only when the user clicks "Scan QR code on this page", to read a 2FA setup QR code.
- **Host permissions (content script on http/https pages)**: Detects verification-code fields on login pages so the code can be filled automatically. Only form fields are inspected; no page content is collected or transmitted.

## Data usage disclosures
- Collects: authentication information (2FA secret keys) — stored encrypted in the user's own Chrome sync storage only; not transmitted to the developer.
- Not sold, not used for unrelated purposes, not used for creditworthiness.

## Screenshots to take (1280×800)
1. Popup with several accounts and the countdown bar
2. A login page with the code filled and the "Code filled" notice
3. The Add account screen scanning a QR code
4. Settings page showing Backup
