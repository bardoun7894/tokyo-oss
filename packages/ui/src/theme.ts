// Light / dark / system, stored per browser. Call applyTheme() early — or copy
// the snippet in README.md into index.html — so the page never flashes the
// wrong theme.
import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "ui_theme";
// "system" needs no JS: with no data-theme, tokens.css follows the OS
// through a prefers-color-scheme media query.

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* storage blocked */ }
  return "system";
}

export function applyTheme(choice: ThemeChoice = getThemeChoice()): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function setThemeChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(KEY, choice); } catch { /* applies for this page load anyway */ }
  applyTheme(choice);
  window.dispatchEvent(new CustomEvent("ui-theme", { detail: choice }));
}

export function useThemeChoice(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  useEffect(() => {
    const on = (e: Event) => setChoice((e as CustomEvent<ThemeChoice>).detail);
    window.addEventListener("ui-theme", on);
    return () => window.removeEventListener("ui-theme", on);
  }, []);
  return [choice, setThemeChoice];
}
