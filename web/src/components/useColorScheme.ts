import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type ColorSchemePref = "light" | "dark" | "system";

const STORAGE_KEY = "colorScheme";

function readPref(): ColorSchemePref {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function systemScheme(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Module-level pref store. Without this, each `useColorScheme()` call would
// hold its own `useState` and the toolbar toggle would only update App —
// leaving every other consumer (Editor, OutputIrPane, TracePanel) stuck on
// their initial render.
let currentPref: ColorSchemePref = readPref();
const prefListeners = new Set<() => void>();

function applyDocumentTheme(p: ColorSchemePref): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (p === "system") delete root.dataset.theme;
  else root.dataset.theme = p;
}
applyDocumentTheme(currentPref);

function setStoredPref(p: ColorSchemePref): void {
  if (p === currentPref) return;
  currentPref = p;
  try {
    if (p === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, p);
  } catch { /* private mode */ }
  applyDocumentTheme(p);
  for (const l of prefListeners) l();
}

function subscribePref(cb: () => void): () => void {
  prefListeners.add(cb);
  return () => { prefListeners.delete(cb); };
}

function getPrefSnapshot(): ColorSchemePref { return currentPref; }

export function useColorScheme(): {
  scheme: "light" | "dark";
  pref: ColorSchemePref;
  setPref: (p: ColorSchemePref) => void;
} {
  const pref = useSyncExternalStore(subscribePref, getPrefSnapshot, getPrefSnapshot);
  const [sys, setSys] = useState<"light" | "dark">(() => systemScheme());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSys(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const scheme: "light" | "dark" = pref === "system" ? sys : pref;
  const setPref = useCallback((p: ColorSchemePref) => setStoredPref(p), []);
  return { scheme, pref, setPref };
}

export function monacoBuiltinTheme(scheme: "light" | "dark"): "vs" | "vs-dark" {
  return scheme === "dark" ? "vs-dark" : "vs";
}
