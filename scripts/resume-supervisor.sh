#!/usr/bin/env bash
# AutoOps AI — unattended resume supervisor for the held-out full arm.
#
# WHY THIS EXISTS
# Groq's allowance for this account behaves like a rolling window rather than a
# calendar-midnight reset: each resume recovers roughly what was spent ~24h
# earlier, so one run completes ~20 incidents and then pauses. Finishing 100
# genuine model evaluations therefore needs many resumes spread over days.
# Cron proved unreliable for this (session-only, and it fires only while the
# REPL is idle), so the retry lives in a plain process instead.
#
# Safety properties this relies on, all already in eval-harness.ts:
#   · every incident is checkpointed, so a kill at any moment loses nothing
#   · RESUME=true skips exactly the incidents already recorded
#   · exit 3 means "paused on confirmed quota exhaustion", not failure
#   · exit 2 means the run degraded (model path silently became fallback) and
#     must NOT be retried blindly — the supervisor stops and says so
#
#   bash scripts/resume-supervisor.sh [retry_interval_seconds]
set -uo pipefail
cd "$(dirname "$0")/.."

INTERVAL="${1:-2700}"          # default 45 min between attempts
OUT="${SUP_OUT:-eval-heldout-full-gptoss120b.json}"
SCENARIO_SET="${SUP_SCENARIO_SET:-held_out}"
RUNS_PER_SCENARIO="${SUP_RUNS_PER_SCENARIO:-20}"
COLD_START="${SUP_COLD_START:-true}"
LOG="${SUP_LOG:-/tmp/resume-supervisor.log}"
API_BASE=${API_BASE:-http://127.0.0.1:3002}
MAX_ATTEMPTS=200

say() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

remaining() {
  node -e '
    const fs=require("fs");
    try { const d=JSON.parse(fs.readFileSync("scripts/'"$OUT"'","utf8"));
          console.log((d.remaining||[]).length); }
    catch { console.log("?"); }'
}

say "supervisor started; interval=${INTERVAL}s; remaining=$(remaining)"

for ((attempt=1; attempt<=MAX_ATTEMPTS; attempt++)); do
  rem=$(remaining)
  if [ "$rem" = "0" ]; then
    say "COMPLETE — 100/100 recorded. Supervisor exiting."
    exit 0
  fi

  # The server must be up and in the arm we claim; the harness verifies this
  # itself and refuses to record mislabelled results, but checking here avoids
  # burning an attempt on a server that simply isn't running.
  if ! curl -sf "$API_BASE/api/debug/stores" >/dev/null 2>&1; then
    say "attempt $attempt: eval server unreachable at $API_BASE — retrying in ${INTERVAL}s"
    sleep "$INTERVAL"; continue
  fi

  say "attempt $attempt: $rem incidents remaining — resuming"
  API_BASE="$API_BASE" SCENARIO_SET="$SCENARIO_SET" RUNS_PER_SCENARIO="$RUNS_PER_SCENARIO" \
    ARM=full PAIRED=true INTERLEAVE=true WORK_ORDER_SEED=1337 COLD_START="$COLD_START" \
    THROTTLE_MS=16000 RESUME=true OUT="$OUT" \
    npx tsx scripts/eval-harness.ts >>"$LOG" 2>&1
  code=$?

  case "$code" in
    0) say "attempt $attempt: run reported COMPLETE (remaining=$(remaining))"
       [ "$(remaining)" = "0" ] && { say "ALL 100 RECORDED. Supervisor exiting."; exit 0; }
       ;;
    3) say "attempt $attempt: paused on quota (remaining=$(remaining)); sleeping ${INTERVAL}s" ;;
    2) say "attempt $attempt: *** CONTAMINATED RUN (exit 2) — model path degraded to fallback. ***"
       say "Stopping. This needs a human: retrying would record degraded plans as results."
       exit 2 ;;
    *) say "attempt $attempt: unexpected exit $code; sleeping ${INTERVAL}s" ;;
  esac

  sleep "$INTERVAL"
done

say "reached MAX_ATTEMPTS=$MAX_ATTEMPTS with $(remaining) remaining; exiting"
exit 1
