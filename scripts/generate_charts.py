#!/usr/bin/env python3
"""
AutoOps AI — Presentation Chart Generator

Regenerates the three benchmark charts used in the AutoOps AI presentation,
straight from the numbers reported in the paper (Section V, Tables III/IV):

  1. detection_recall.png    — Detection recall: pilot (N=48) vs full benchmark (N=102)
  2. latency_metrics.png     — Mean end-to-end latency per incident scenario (Table III)
  3. outcome_distribution.png — Resolved vs. Failed/Escalated outcome split (Table IV)

Usage:
    python3 generate_charts.py [output_dir]

    output_dir defaults to the current working directory, so running this
    from inside a presentation-assets folder drops the PNGs right there.

Requires: matplotlib (pip install matplotlib). No other dependencies —
the source numbers are hardcoded below rather than parsed from anywhere,
so this has nothing else to fail on.
"""

import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter

# ── Source data (paper/paper.tex, Section V) ────────────────────────────

DETECTION_RECALL = {
    "Pilot Baseline\n(N=48)": 66.7,
    "AutoOps AI\n(N=102)": 100.0,
}

# Table III — mean end-to-end latency per scenario, n=17 each (N=102 total)
SCENARIO_LATENCY = {
    "OOM Kill": 7.24,
    "High Error\nRate": 3.81,
    "CPU Spike": 3.85,
    "Disk Full": 3.52,
    "Connection Pool\nExhaustion": 3.47,
    "Service Down": 3.52,
}
OVERALL_MEAN_LATENCY = 4.23  # Table IV, AutoOps AI (RAG+LLM) arm

# Table IV — AutoOps AI (RAG+LLM) arm, N=102
OUTCOME_DISTRIBUTION = {
    "Resolved": 83,
    "Failed / Escalated": 17,
}

# ── Shared style ─────────────────────────────────────────────────────────
# A small, consistent palette (cyan/purple/emerald/amber) matching the
# AutoOps AI dashboard's own accent colors, on a clean white background
# that reproduces well on both a screen and a printed slide.

CYAN = "#22a6d9"
PURPLE = "#7c5cff"
EMERALD = "#1fa971"
AMBER = "#e0a020"
MUTED = "#94a3b8"
INK = "#1a2233"

plt.rcParams.update(
    {
        "figure.dpi": 150,
        "savefig.dpi": 300,
        "font.family": "sans-serif",
        "font.sans-serif": ["Helvetica Neue", "Arial", "DejaVu Sans"],
        "font.size": 12,
        "text.color": INK,
        "axes.edgecolor": "#d6dbe3",
        "axes.labelcolor": INK,
        "xtick.color": INK,
        "ytick.color": INK,
        "axes.titleweight": "bold",
        "axes.titlesize": 15,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
    }
)


def _strip_spines(ax, keep=("left", "bottom")):
    for side, spine in ax.spines.items():
        spine.set_visible(side in keep)


def _bar_value_labels(ax, bars, fmt="{:.0f}%", offset=1.5, color=INK):
    for bar in bars:
        height = bar.get_height()
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            height + offset,
            fmt.format(height),
            ha="center",
            va="bottom",
            fontsize=13,
            fontweight="bold",
            color=color,
        )


# ── Chart 1: Detection Recall ──────────────────────────────────────────


def make_detection_recall_chart(output_dir: Path) -> Path:
    labels = list(DETECTION_RECALL.keys())
    values = list(DETECTION_RECALL.values())
    colors = [MUTED, CYAN]

    fig, ax = plt.subplots(figsize=(6.5, 5.5))
    bars = ax.bar(labels, values, color=colors, width=0.55, zorder=3)

    _bar_value_labels(ax, bars, fmt="{:.1f}%")

    ax.set_ylim(0, 112)
    ax.yaxis.set_major_formatter(PercentFormatter(xmax=100))
    ax.set_ylabel("Detection Recall")
    ax.set_title("Detection Recall: Pilot vs. Full Benchmark")
    ax.text(
        0.5,
        -0.16,
        "Fixed error-signature gap (cpu_spike / connection_pool_exhaustion) between runs — Section V-A",
        transform=ax.transAxes,
        ha="center",
        fontsize=9.5,
        color=MUTED,
        style="italic",
    )
    ax.grid(axis="y", color="#e8ebf0", linewidth=1, zorder=0)
    _strip_spines(ax)
    fig.tight_layout()

    out_path = output_dir / "detection_recall.png"
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path


# ── Chart 2: Mean Latency per Scenario ─────────────────────────────────


def make_latency_chart(output_dir: Path) -> Path:
    labels = list(SCENARIO_LATENCY.keys())
    values = list(SCENARIO_LATENCY.values())

    # OOM Kill is the outlier (routed through the human-approval gate — see
    # Table III's dagger note) — give it its own color so it doesn't read
    # as noise.
    colors = [PURPLE if v == max(values) else CYAN for v in values]

    fig, ax = plt.subplots(figsize=(9.5, 5.5))
    bars = ax.bar(labels, values, color=colors, width=0.6, zorder=3)

    _bar_value_labels(ax, bars, fmt="{:.2f}s", offset=0.08)

    ax.axhline(
        OVERALL_MEAN_LATENCY,
        color=AMBER,
        linewidth=1.75,
        linestyle="--",
        zorder=2,
    )
    ax.text(
        len(labels) - 0.4,
        OVERALL_MEAN_LATENCY + 0.12,
        f"Overall mean: {OVERALL_MEAN_LATENCY}s",
        ha="right",
        va="bottom",
        fontsize=10,
        fontweight="bold",
        color=AMBER,
    )

    ax.set_ylim(0, max(values) * 1.22)
    ax.set_ylabel("Mean end-to-end latency (seconds)")
    ax.set_title("Mean Latency by Incident Scenario ($n$=17 each, $N$=102 total)")
    ax.grid(axis="y", color="#e8ebf0", linewidth=1, zorder=0)
    _strip_spines(ax)
    plt.setp(ax.get_xticklabels(), fontsize=10.5)
    fig.tight_layout()

    out_path = output_dir / "latency_metrics.png"
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path


# ── Chart 3: Outcome Distribution ──────────────────────────────────────


def make_outcome_distribution_chart(output_dir: Path) -> Path:
    labels = list(OUTCOME_DISTRIBUTION.keys())
    values = list(OUTCOME_DISTRIBUTION.values())
    colors = [EMERALD, "#e05a4e"]

    fig, ax = plt.subplots(figsize=(6.5, 6.5))
    wedges, _texts, autotexts = ax.pie(
        values,
        colors=colors,
        startangle=90,
        counterclock=False,
        wedgeprops=dict(width=0.42, edgecolor="white", linewidth=3),
        autopct=lambda pct: f"{pct:.0f}%",
        pctdistance=0.79,
    )
    for t in autotexts:
        t.set_fontsize(15)
        t.set_fontweight("bold")
        t.set_color("white")

    ax.legend(
        wedges,
        labels,
        loc="upper center",
        bbox_to_anchor=(0.5, 0.02),
        ncol=2,
        frameon=False,
        fontsize=11,
    )
    ax.set_title("Incident Outcome Distribution\n(AutoOps AI, RAG+LLM arm, $N$=102)", pad=12)
    ax.text(0, 0, "N=102", ha="center", va="center", fontsize=16, fontweight="bold", color=INK)
    ax.set_aspect("equal")
    fig.tight_layout()

    out_path = output_dir / "outcome_distribution.png"
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path


def main():
    output_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    output_dir.mkdir(parents=True, exist_ok=True)

    paths = [
        make_detection_recall_chart(output_dir),
        make_latency_chart(output_dir),
        make_outcome_distribution_chart(output_dir),
    ]

    for p in paths:
        print(f"Saved {p}")


if __name__ == "__main__":
    main()
