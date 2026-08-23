"use client";

import { FiMoon, FiSun } from "react-icons/fi";
import { useTheme } from "../lib/theme";

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      onClick={toggle}
      aria-label="Toggle light / dark mode"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="group relative flex h-9 w-16 items-center rounded-full border border-border/80 bg-surface2/80 px-1 transition-colors hover:border-cyan-neon/50"
    >
      <span
        className={`absolute top-1 flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-neon to-purple-neon text-[13px] text-black shadow-[0_0_10px_rgba(34,232,255,0.5)] transition-all duration-300 ease-out ${
          isDark ? "left-1" : "left-8"
        }`}
      >
        {isDark ? <FiMoon /> : <FiSun />}
      </span>
    </button>
  );
}
