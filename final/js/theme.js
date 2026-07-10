// ─── Theme — Dark/Light toggle with persistence ──────────────────────────

const STORAGE_KEY  = 'platform_theme';
const DEFAULT_THEME = 'dark';

let currentTheme = localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;

export function getTheme() {
  return currentTheme;
}

export function setTheme(theme) {
  if (theme !== 'dark' && theme !== 'light') return;
  currentTheme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

export function toggleTheme() {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
  document.documentElement.setAttribute('data-theme', currentTheme);
}
