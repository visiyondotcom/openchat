"use client";

import { useEffect, useState } from "react";
import { Sun, Moon, MoonStar } from "lucide-react";

type Theme = "dark" | "light" | "midnight";
const THEMES: Theme[] = ["dark", "light", "midnight"];
const ICONS: Record<Theme, typeof Sun> = { dark: Moon, light: Sun, midnight: MoonStar };
const LABELS: Record<Theme, string> = { dark: "dark mode", light: "light mode", midnight: "midnight mode" };

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = (typeof window !== "undefined" && localStorage.getItem("visiyon_theme")) as Theme | null;
    setTheme(stored && THEMES.includes(stored) ? stored : "dark");
  }, []);

  function toggle() {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    setTheme(next);
    localStorage.setItem("visiyon_theme", next);
    document.documentElement.classList.remove(...THEMES);
    document.documentElement.classList.add(next);
  }

  const Icon = ICONS[theme];
  const nextLabel = LABELS[THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]];

  return (
    <button
      onClick={toggle}
      title={`Switch to ${nextLabel}`}
      className="p-2 rounded-lg border border-visiyon-border text-visiyon-text-2 hover:text-visiyon-text hover:border-visiyon-text transition-colors"
    >
      <Icon size={15} />
    </button>
  );
}

