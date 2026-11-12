import { useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

// The same key is read by the inline script in index.html before the first paint.
const storageKey = 'agentome-theme';

export function currentTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

// Reading localStorage throws when site data is blocked; then the choice holds for this tab only.
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** "system" removes the attribute and the saved choice, so the CSS follows the OS again. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (theme === 'system') storage()?.removeItem(storageKey);
  else storage()?.setItem(storageKey, theme);
}

export function useTheme() {
  const [theme, setTheme] = useState(currentTheme);
  return [
    theme,
    (next: Theme) => {
      applyTheme(next);
      setTheme(next);
    },
  ] as const;
}
