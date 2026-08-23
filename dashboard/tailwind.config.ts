import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        surface2: "rgb(var(--surface2) / <alpha-value>)",
        border: "rgb(var(--border) / <alpha-value>)",
        text: "rgb(var(--text) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        cyan: {
          neon: "#22e8ff",
        },
        purple: {
          neon: "#b06bff",
        },
        success: "#3fb950",
        warn: "#d29922",
        danger: "#f85149",
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
      backdropBlur: {
        xs: "2px",
      },
      keyframes: {
        "pulse-glow-cyan": {
          "0%, 100%": {
            boxShadow: "0 0 0 0 rgba(34,232,255,0.45), 0 0 18px 2px rgba(34,232,255,0.25)",
          },
          "50%": {
            boxShadow: "0 0 0 8px rgba(34,232,255,0), 0 0 28px 6px rgba(34,232,255,0.4)",
          },
        },
        "pulse-glow-red": {
          "0%, 100%": {
            boxShadow: "0 0 0 0 rgba(248,81,73,0.45), 0 0 18px 2px rgba(248,81,73,0.25)",
          },
          "50%": {
            boxShadow: "0 0 0 8px rgba(248,81,73,0), 0 0 28px 6px rgba(248,81,73,0.4)",
          },
        },
        "pulse-glow-purple": {
          "0%, 100%": {
            boxShadow: "0 0 0 0 rgba(176,107,255,0.45), 0 0 18px 2px rgba(176,107,255,0.25)",
          },
          "50%": {
            boxShadow: "0 0 0 8px rgba(176,107,255,0), 0 0 28px 6px rgba(176,107,255,0.4)",
          },
        },
        breathe: {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.015)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        comet: {
          "0%": { transform: "translateX(-120%)", opacity: "0" },
          "10%": { opacity: "1" },
          "90%": { opacity: "1" },
          "100%": { transform: "translateX(120%)", opacity: "0" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.15" },
        },
      },
      animation: {
        "pulse-glow-cyan": "pulse-glow-cyan 1.8s ease-in-out infinite",
        "pulse-glow-red": "pulse-glow-red 1.4s ease-in-out infinite",
        "pulse-glow-purple": "pulse-glow-purple 1.8s ease-in-out infinite",
        breathe: "breathe 2.4s ease-in-out infinite",
        shimmer: "shimmer 2.5s linear infinite",
        comet: "comet 1.4s ease-in-out infinite",
        "fade-in-up": "fade-in-up 0.25s ease",
        blink: "blink 1.2s steps(2) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
