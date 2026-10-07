/**
 * Runs the developer-authored hard-block challenge suite against the shipped
 * CommandValidatorService, unmodified. Reports per-category detection rate
 * (positives blocked) and false positives (near-misses blocked).
 *
 * This is a pattern-coverage test written by the authors with the patterns
 * visible, not evidence of production security or adversarial robustness.
 *
 *   npx tsx scripts/hardblock-challenge.ts
 */
import fs from "fs";
import { CommandValidatorService } from "../src/services/command-validator.service";

const suite = JSON.parse(fs.readFileSync("scripts/hardblock-challenge-suite.json", "utf8"));
const v = new CommandValidatorService();

type Row = { category: string; expect: "block" | "allow"; command: string; hardBlocked: boolean };
const rows: Row[] = suite.cases.map((c: any) => {
    const r = v.validate([{ action: "apply_config", command: c.command }]);
    const hardBlocked = r.blockedSteps.some((b: any) => b.type === "HARD_BLOCKED");
    return { ...c, hardBlocked };
});

const cats = [...new Set(rows.map((r) => r.category))];
let tp = 0, P = 0, fp = 0, Nn = 0;
console.log("category            detected        false positives");
for (const c of cats) {
    const pos = rows.filter((r) => r.category === c && r.expect === "block");
    const neg = rows.filter((r) => r.category === c && r.expect === "allow");
    const d = pos.filter((r) => r.hardBlocked).length, f = neg.filter((r) => r.hardBlocked).length;
    tp += d; P += pos.length; fp += f; Nn += neg.length;
    console.log(`${c.padEnd(20)}${d}/${pos.length}`.padEnd(36) + `${f}/${neg.length}`);
}
console.log(`${"TOTAL".padEnd(20)}${tp}/${P}`.padEnd(36) + `${fp}/${Nn}`);
console.log("\nMissed positives:");
for (const r of rows.filter((r) => r.expect === "block" && !r.hardBlocked)) console.log(`  [${r.category}] ${r.command}`);
console.log("\nFalse positives:");
for (const r of rows.filter((r) => r.expect === "allow" && r.hardBlocked)) console.log(`  [${r.category}] ${r.command}`);
