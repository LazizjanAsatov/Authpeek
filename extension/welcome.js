// Welcome page, opened once by the background when AuthPeek is first installed.
import { openVault } from './lib/codes.js';
import { syncTheme } from './lib/theme.js';

syncTheme(openVault());

document.querySelector('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
