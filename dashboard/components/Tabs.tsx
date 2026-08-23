"use client";

import type { IconType } from "react-icons";

export interface TabDef {
  id: string;
  label: string;
  icon: IconType;
  badge?: number;
}

interface Props {
  tabs: TabDef[];
  activeTab: string;
  onChange: (id: string) => void;
}

export default function Tabs({ tabs, activeTab, onChange }: Props) {
  return (
    <div className="glass mb-5 flex gap-1 rounded-2xl p-1.5">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`relative flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-semibold transition-all duration-300 ${
              isActive
                ? "bg-gradient-to-r from-cyan-neon/15 to-purple-neon/15 text-text shadow-[inset_0_0_0_1px_rgba(34,232,255,0.35)]"
                : "text-muted hover:bg-[var(--overlay-soft)] hover:text-text"
            }`}
          >
            <Icon className={isActive ? "text-cyan-neon" : ""} size={15} />
            {tab.label}
            {typeof tab.badge === "number" && tab.badge > 0 && (
              <span className="rounded-full bg-cyan-neon/20 px-1.5 py-0.5 text-[9px] font-bold text-cyan-neon">
                {tab.badge}
              </span>
            )}
            {isActive && (
              <span className="absolute inset-x-4 -bottom-[7px] h-[2px] rounded-full bg-gradient-to-r from-cyan-neon to-purple-neon" />
            )}
          </button>
        );
      })}
    </div>
  );
}
