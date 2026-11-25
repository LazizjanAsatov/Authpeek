# AuthPeek QA server (1.3)

A tiny local site that always rejects the code. Use it to check that auto-fill tries once and does not loop, and that Whitelisted IPs hides and refuses codes.

## Run

From the repository root:

```
node scripts/qa-server.mjs
```

Open http://localhost:8765. Every attempt is printed in the terminal, for example `[attempt] /loop #3 code=123456 at 12:00:01`. Visit `/stats` for counts and `/reset` to zero them.

## Set up Chrome

1. Open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the `extension` folder of the repository. If it is already loaded, click the reload arrow on its card.
2. Open http://localhost:8765 in a tab. With that tab active, click the AuthPeek icon, click the + button (Add account) at the top, choose the Enter key tab, and use secret `JBSWY3DPEHPK3PXP` and service `QA`.
3. Still in the popup on the QA tab, click the ⋮ button (Edit) at the end of the QA row, click "Auto-fill on localhost" (it adds a `localhost` chip under "Auto-fill on these sites"), then click "Save changes". The button only shows when the popup is opened on the QA tab.
4. Open settings (the gear at the top of the popup, or "Backup & settings" at the bottom) and, under Auto-fill, turn on "Press Verify after filling".

## Fill records (read this before re-running)

AuthPeek remembers each fill for 10 minutes, per account and site, and the three QA pages are one site (`localhost`). So after one automatic fill, every QA page shows the suggestion card instead of filling, for 10 minutes. It also fills at most 3 codes by itself per site in 10 minutes, whichever account. `/reset` only zeroes the server's counters, not AuthPeek's records. To re-run a test with a fresh automatic fill right away, close and reopen Chrome (the records live only in memory; unlock AuthPeek again afterwards), or wait 10 minutes.

## Expected result on each page

Click Reset first, then open the page (one page per fresh start, see above).

- `/loop`, `/spa`, `/digits`: the terminal shows exactly ONE `[attempt]` line and the page counter shows 1. Then the AuthPeek suggestion card appears in the top right corner of the page, the AuthPeek icon shows an amber `!`, and nothing more is filled or submitted.
- The card's Fill button is disabled at first, because the code shown is the one that was just used: the card says "A new one comes in N s". When the next code comes, the button reads "Fill the new code". Click it. The code is filled once and Verify is not pressed, so the counter stays at 1, and the `!` on the icon goes away.
- `/digits` is the exception: it submits itself when the sixth box is filled, so clicking Fill gives one more attempt (counter 2). That is by design.
- `/spa` swaps in a new empty input after each reject. AuthPeek must not fill that new input on its own.
- While the card is showing, open the popup on that tab: the box "This page is asking for a code · localhost" has an amber line with a warning sign, "AuthPeek already filled a code here in the last 10 minutes, so it won't fill again by itself…". Unlocking the popup on such a page doesn't fill by itself either. Fill code in that box still works: a fill you ask for always does.
- The right-click menu (AuthPeek ▸ the QA account) and Alt+Shift+O also always fill: they are fills you ask for.

## Whitelist checks

Start with Whitelisted IPs empty, and with no fill record for the QA account (close and reopen Chrome first).

1. In settings, open Whitelisted IPs (in the list on the left). The status shows "Off. Codes work on any network. Your IP: …" and an "Add my current IP" link. Click it, then Add…, and enter your AuthPeek password (the dialog warns that AuthPeek older than 1.3 can't unlock once the list is used). The status then says "On a whitelisted network". Codes show in the popup, and opening `/loop` auto-fills once.
2. Add `198.51.100.0/24` (password again). Then remove your own IP with its × (password again). Now:
   - the popup shows an amber notice at the top, "Codes are hidden. This network isn't in your whitelisted IPs." with your IP and the buttons Check again and Settings; the rows keep their names and the ⋮ button, but have no code, no copy, no Fill and no Share;
   - a QA page shows the toast "AuthPeek codes are off on this network. It isn't in your whitelisted IPs." and the AuthPeek icon shows a grey `IP`;
   - in settings, Download, Email to myself, Backup as text and Export as links are refused with "Not available: this network isn't in your whitelisted IPs.";
   - in the popup, ⋮ on any account → Share → Create link says the same and makes no link, and "Show setup QR code" (after the password) says the same and shows no QR code.
3. Open a share link someone else made (paste it into the popup, or open it in a tab): it still shows its codes. It holds no secret of this vault, so the whitelist doesn't apply to it.
4. To finish, click "Turn off…" (password). The dialog says AuthPeek older than 1.3 still won't be able to unlock this vault, and settings keeps showing that note.

## Idle lock

Set "Ask for my password" to "After 1 minute without use", open the popup on the codes list (or on an account's Edit or Share view) and leave it. Within about a minute and a half the popup goes to the password screen by itself: the popup's regular network re-check does not count as use. A page with a code field that keeps asking doesn't keep AuthPeek unlocked either; only a code going into a page, or something you do in the popup or settings, restarts the timer.
