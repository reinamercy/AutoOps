"""
Renders the AutoOps AI four-layer system architecture as a clean,
publication-quality vector figure (matplotlib), matching IEEE conference
figure conventions: sans-serif type, grayscale/subdued palette, sharp box
boundaries, directional arrows. Saves both a 300 DPI PNG (for reliable
pdflatex inclusion) and a PDF (vector) version. Sized compactly (~3.3in
tall at 7in wide) to fit a strict page budget as a two-column figure.
"""
import matplotlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Helvetica", "Arial", "DejaVu Sans"],
    "font.size": 8.0,
})

FIG_W, FIG_H = 7.0, 3.30
fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
ax.set_xlim(0, FIG_W)
ax.set_ylim(0, FIG_H)
ax.axis("off")

# ---- Palette: subdued grayscale-blue, IEEE-safe in print ----
LAYER_FACE = ["#eef1f4", "#e4e9ee", "#dae1e8", "#ced8e0"]   # L1..L4, light -> slightly darker
LAYER_EDGE = "#33383d"
BOX_FACE = "#ffffff"
BOX_EDGE = "#33383d"
ACCENT_FACE = "#c9d3db"     # highlighted sub-boxes (Planning..Execution loop group)
TEXT_COLOR = "#16181a"

layer_defs = [
    # (label, y0, height, components)
    ("L1 — Infrastructure & Ingestion", 0.08, 0.62,
     ["Kubernetes\ncluster", "Go log\ningester", "Event\nsimulator"]),
    ("L2 — Data & Storage (real, auto-fallback)", 0.78, 0.62,
     ["PostgreSQL", "Redis", "ChromaDB", "Kafka"]),
    ("L3 — Multi-Agent Brain (orchestrator.ts)", 1.48, 1.15, None),
    ("L4 — Interface & Observability", 2.71, 0.50,
     ["Fastify\nREST API", "WebSocket\nfeed", "Dashboard\nUI", "Prometheus\nmetrics"]),
]

def draw_layer_frame(y0, h, label, idx):
    box = FancyBboxPatch((0.15, y0), FIG_W - 0.3, h,
                          boxstyle="round,pad=0.018,rounding_size=0.045",
                          linewidth=1.2, edgecolor=LAYER_EDGE,
                          facecolor=LAYER_FACE[idx], zorder=1)
    ax.add_patch(box)
    ax.text(0.30, y0 + h - 0.12, label, fontsize=8.0, fontweight="bold",
             color=TEXT_COLOR, va="top", ha="left")

def draw_component_row(y0, h, components, top_offset=0.26):
    n = len(components)
    margin = 0.45
    avail = FIG_W - 2 * margin
    bw = avail / n - 0.14
    bh = h - top_offset - 0.09
    by = y0 + 0.09
    for i, comp in enumerate(components):
        bx = margin + i * (avail / n) + 0.07
        rect = FancyBboxPatch((bx, by), bw, bh,
                               boxstyle="round,pad=0.013,rounding_size=0.035",
                               linewidth=0.9, edgecolor=BOX_EDGE,
                               facecolor=BOX_FACE, zorder=3)
        ax.add_patch(rect)
        ax.text(bx + bw / 2, by + bh / 2, comp, fontsize=6.8, ha="center",
                 va="center", color=TEXT_COLOR, zorder=4)

# ---- Draw L1, L2, L4 frames + component boxes ----
for idx, (label, y0, h, comps) in enumerate(layer_defs):
    draw_layer_frame(y0, h, label, idx)
    if comps is not None:
        draw_component_row(y0, h, comps)

# ---- L3: pipeline chain with retry loop ----
_, l3_y0, l3_h, _ = layer_defs[2]
pipeline = ["Monitoring", "RCA", "Planning", "SLA", "Decision", "Execution", "Feedback"]
n = len(pipeline)
margin = 0.40
avail = FIG_W - 2 * margin
bw = avail / n - 0.09
bh = 0.36
by = l3_y0 + 0.30
edges = []
for i, name in enumerate(pipeline):
    bx = margin + i * (avail / n) + 0.045
    edges.append((bx, bx + bw))
    face = ACCENT_FACE if name in ("Planning", "SLA", "Decision", "Execution") else BOX_FACE
    rect = FancyBboxPatch((bx, by), bw, bh,
                           boxstyle="round,pad=0.010,rounding_size=0.03",
                           linewidth=0.9, edgecolor=BOX_EDGE,
                           facecolor=face, zorder=3)
    ax.add_patch(rect)
    ax.text(bx + bw / 2, by + bh / 2, name, fontsize=6.3, ha="center",
             va="center", color=TEXT_COLOR, zorder=4)

for i in range(n - 1):
    ax.annotate("", xy=(edges[i + 1][0], by + bh / 2),
                 xytext=(edges[i][1], by + bh / 2),
                 arrowprops=dict(arrowstyle="-|>", color=BOX_EDGE, lw=0.9),
                 zorder=2)

# Bracket below Planning..Execution showing the bounded retry sub-loop,
# with an arrowhead feeding back up into Planning (Execution -> Planning).
px0 = margin + 2 * (avail / n) + 0.045
px1 = margin + 6 * (avail / n) + 0.045 - 0.09
bracket_y = by - 0.13
ax.plot([px0, px0, px1, px1], [by - 0.02, bracket_y, bracket_y, by],
        color="#555b61", lw=0.9, zorder=2)
ax.annotate("", xy=(px0, by - 0.02), xytext=(px0, bracket_y),
            arrowprops=dict(arrowstyle="-|>", color="#555b61", lw=0.9),
            zorder=2)
ax.text((px0 + px1) / 2, bracket_y - 0.04, "retry loop ($\\leq$ 3): Execution $\\to$ Planning",
        fontsize=6.2, ha="center", va="top", color=TEXT_COLOR, style="italic")

ax.text(FIG_W / 2, l3_y0 + l3_h - 0.12 - 0.16,
        "single immutable IncidentState threaded through every stage",
        fontsize=6.4, ha="center", va="top", color="#40464c", style="italic")

# ---- Inter-layer flow arrows (bottom -> top) ----
for i in range(3):
    y0_lower = layer_defs[i][1] + layer_defs[i][2]
    y0_upper = layer_defs[i + 1][1]
    ax.annotate("", xy=(FIG_W / 2, y0_upper), xytext=(FIG_W / 2, y0_lower),
                arrowprops=dict(arrowstyle="-|>", color=LAYER_EDGE, lw=1.3),
                zorder=2)

plt.tight_layout(pad=0.20)
plt.savefig(os.path.join(HERE, "architecture.png"), dpi=320)
plt.savefig(os.path.join(HERE, "architecture.pdf"))
plt.close()
print("wrote architecture diagram")
