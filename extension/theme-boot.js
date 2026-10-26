// Runs in <head> before the CSS, so a page opens in the chosen theme instead of flashing the
// other one first. lib/theme.js keeps this copy in localStorage in step with the setting.
try {
  const theme = localStorage.getItem('authpeek-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage blocked: the page follows the system theme, which is the default anyway.
}
