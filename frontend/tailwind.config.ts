import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        visiyon: {
          bg: "rgb(var(--visiyon-bg) / <alpha-value>)",
          panel: "rgb(var(--visiyon-panel) / <alpha-value>)",
          panel2: "rgb(var(--visiyon-panel2) / <alpha-value>)",
          border: "rgb(var(--visiyon-border) / <alpha-value>)",
          text: "rgb(var(--visiyon-text) / <alpha-value>)",
          "text-2": "rgb(var(--visiyon-text) / var(--visiyon-text-2-alpha))",
          "text-3": "rgb(var(--visiyon-text) / var(--visiyon-text-3-alpha))",
          accent: "rgb(var(--visiyon-accent) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      // Used on error/warning banners (see animate-blink) so a failed
      // save or a login/checkout error visibly catches the eye instead
      // of sitting there as static red text.
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        // Used on the captcha puzzle piece when dropped in the wrong
        // spot — a quick horizontal shake to signal "try again".
        shake: {
          "0%, 100%": { transform: "translateX(0)" },
          "20%": { transform: "translateX(-6px)" },
          "40%": { transform: "translateX(6px)" },
          "60%": { transform: "translateX(-4px)" },
          "80%": { transform: "translateX(4px)" },
        },
      },
      animation: {
        blink: "blink 1s ease-in-out infinite",
        shake: "shake 0.4s ease-in-out",
      },
    },
  },
  // Official Tailwind plugins are now installed (see package.json) and
  // wired up here — add more to this array as needed, e.g.
  // require("@tailwindcss/aspect-ratio"). typography gives the
  // `prose` classes. forms is scoped to strategy: "class" — the
  // default "base" strategy resets every native <input>/<select>/
  // <textarea> unconditionally (its own blue focus ring, white
  // background, borders), which clobbered every custom-styled input
  // already in this app. With "class", it only applies when you add
  // its `form-input`/`form-select`/etc. classes yourself.
  plugins: [require("@tailwindcss/typography"), require("@tailwindcss/forms")({ strategy: "class" })],
};

export default config;
