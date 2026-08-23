// Sourced directly from the paper's own Related Work section and
// bibliography (paper/paper.tex) — every row below mirrors the comparative
// framing already written and cited there, not invented for the dashboard.
export interface LiteratureRow {
  author: string;
  year: string;
  methodology: string;
  limitations: string;
  advantage: string;
}

export const LITERATURE_REVIEW: LiteratureRow[] = [
  {
    author: "Notaro et al.",
    year: "2020",
    methodology: "Systematic mapping study surveying the published AIOps literature.",
    limitations: "Finds the field overwhelmingly detection-focused; remediation is under-studied.",
    advantage: "Treats detection as stage 1 of 6, not the terminal output — closes the gap the survey identifies.",
  },
  {
    author: "Zhang et al. (AIOps/LLM Survey)",
    year: "2025",
    methodology: "Survey of AIOps research specifically in the LLM era.",
    limitations: "Finds the same detection/remediation imbalance persists even with LLMs.",
    advantage: "Full six-agent closed loop from detection through execution and feedback, not LLM-assisted analysis alone.",
  },
  {
    author: "Ding et al. (TraceDiag)",
    year: "2023",
    methodology: "Graph-pruning policy for tractable root-cause search over large microservice topologies, deployed at Microsoft.",
    limitations: "Optimizes RCA efficiency/accuracy only — terminal output is a diagnosis, not a verified fix.",
    advantage: "RCA is stage 2 of 6; a verified, executed remediation follows, with retry and feedback loops.",
  },
  {
    author: "Chen et al. (RCACopilot)",
    year: "2024",
    methodology: "LLM-assisted root-cause prediction; 0.77 accuracy over a year of Microsoft production incidents.",
    limitations: "Outputs a diagnosis for a human to act on — no execution path.",
    advantage: "Closes exactly this gap: diagnosis feeds a risk-scored decision engine that can auto-execute or gate to human approval.",
  },
  {
    author: "Sarda et al.",
    year: "2024",
    methodology: "LLM proposes and directly applies microservice remediations, evaluated experimentally.",
    limitations: "No intermediate risk gate — every LLM-proposed action is a candidate for execution on equal footing.",
    advantage: "Independent, non-LLM risk-scoring engine sits between any proposed plan and execution — a graded score, not a binary predicate.",
  },
  {
    author: "Chen et al. (STRATUS)",
    year: "2025",
    methodology: "Multi-agent state machine for autonomous SRE; safety enforced via a formal “Transactional No-Regression” property.",
    limitations: "Safety is a constraint on the LLM's exploration space, not an independently computed score.",
    advantage: "LLM is the least-preferred of four plan sources (template → memory → LLM → fallback), with risk scored independently of how the plan was generated.",
  },
  {
    author: "Chen et al. (AIOpsLab)",
    year: "2025",
    methodology: "Benchmark framework evaluating AI agents via fault injection across the full detection-to-mitigation lifecycle.",
    limitations: "A benchmarking harness, not a production remediation system in itself.",
    advantage: "AIOpsLab's own evaluation standard is what the 102-incident benchmark holds AutoOps AI to, with measured (not target) MTTR and recall.",
  },
  {
    author: "Yao et al. (ReAct)",
    year: "2023",
    methodology: "Tool-augmented reasoning letting an LLM select actions from a constrained tool surface.",
    limitations: "The reasoning-action loop has no independent risk gate of its own.",
    advantage: "Planning agent is ReAct-informed but departs from it via an independent risk-scoring engine between any proposed plan and execution.",
  },
  {
    author: "Lewis et al. (RAG)",
    year: "2020",
    methodology: "Retrieval-augmented generation grounding LLM output in retrieved documents rather than parametric knowledge alone.",
    limitations: "A general-purpose technique, not adapted to an operations/incident domain.",
    advantage: "Planning agent retrieves the k most similar historical incidents as prompt context directly inside the remediation loop.",
  },
  {
    author: "Zhang et al. (RAG4ITOps)",
    year: "2024",
    methodology: "RAG paired with a fine-tuned retriever and generator specifically for IT-operations text.",
    limitations: "Domain-specific fine-tuning is a heavier data/infrastructure investment.",
    advantage: "Trades fine-tuning for an off-the-shelf embedding model (all-MiniLM-L6-v2) — comparable grounding, zero-training deployment.",
  },
  {
    author: "Burns et al. (Borg/Omega/Kubernetes)",
    year: "2016",
    methodology: "Reconciliation-loop operator pattern toward a declared desired state — the dominant automated-remediation paradigm.",
    limitations: "Reliable for narrow failure modes but requires a hand-written rule per mode.",
    advantage: "Template layer plays a similar role for well-understood signatures; memory and LLM layers extend coverage to modes no operator author anticipated.",
  },
];
