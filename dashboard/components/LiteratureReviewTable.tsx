import { FiBookOpen } from "react-icons/fi";
import { LITERATURE_REVIEW } from "../lib/literatureReview";

export default function LiteratureReviewTable() {
  return (
    <div className="glass rounded-2xl">
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <FiBookOpen className="text-purple-neon" /> Literature Review
        </div>
        <div className="hidden text-[11px] text-muted sm:block">
          Prior work AutoOps AI is positioned against, from the paper&apos;s Related Work
        </div>
      </div>
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-[900px] table-fixed text-left text-[11.5px]">
          <colgroup>
            <col className="w-[15%]" />
            <col className="w-[24%]" />
            <col className="w-[24%]" />
            <col className="w-[37%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--hairline)] text-muted">
              {["Author / Year", "Methodology", "Limitations", "AutoOps AI Advantage"].map((h) => (
                <th key={h} className="px-4 py-2.5 align-bottom text-[10px] font-semibold uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LITERATURE_REVIEW.map((row) => (
              <tr
                key={row.author}
                className="border-b border-[var(--hairline)] align-top transition-colors last:border-b-0 hover:bg-[var(--overlay-soft)]"
              >
                <td className="px-4 py-3.5">
                  <div className="font-semibold text-text">{row.author}</div>
                  <span className="mt-1 inline-block rounded-full border border-cyan-neon/40 bg-cyan-neon/10 px-1.5 py-0.5 text-[9px] font-bold text-cyan-neon">
                    {row.year}
                  </span>
                </td>
                <td className="px-4 py-3.5 leading-relaxed text-text/80">{row.methodology}</td>
                <td className="px-4 py-3.5 leading-relaxed text-amber-300/90">{row.limitations}</td>
                <td className="px-4 py-3.5">
                  <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] px-3 py-2 leading-relaxed text-emerald-300/90">
                    {row.advantage}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
