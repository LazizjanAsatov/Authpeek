// Light, Dark or System (no attribute: the CSS follows the computer's setting).
// The choice lives in settings.theme in sync; a copy in localStorage lets theme-boot.js
// apply it before the first paint.
const KEY = 'authpeek-theme';

export const THEMES = ['system', 'light', 'dark'];

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    localStorage.setItem(KEY, THEMES.includes(theme) ? theme : 'system');
  } catch {
    // Without storage the next page may flash once; the setting itself is still applied.
  }
}

// Applies the saved theme, then follows changes made in settings, here or on another computer.
export async function syncTheme(vault) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) applyTheme(changes.settings.newValue?.theme);
  });
  applyTheme((await vault.getSettings()).theme);
}
