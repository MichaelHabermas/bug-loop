#!/usr/bin/env bash
# Open-model matrix sweep: OpenCode fixer via OpenRouter models × N trials.
#
# Usage:
#   ./scripts/model-sweep.sh [--base URL] [--pilot] [--config path]
#
# Per trial: fresh traffic (rotating seeds), reset cursor, agent-sdk dry-fix with
#   BUGLOOP_FIXER=opencode BUGLOOP_OPENCODE_MODEL=openrouter/<id>
#   --label or-<model-short>-t<trial>
#
# CUMULATIVE COST HALT: after each trial, sum reported USD from the trial trace;
# if cumulative across the whole sweep exceeds budgetHaltUsd ($18 default; soft
# cap $20), stop with a clear message.
#
# Prerequisites: leaky-service at --base, opencode on PATH + authed for OpenRouter,
# OPENROUTER_API_KEY set. Verify model ids first: bun run scripts/verify-models.ts
#
# Does not commit or push. Network calls are operator-machine only.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Shell-level env checks need .env; bun subprocesses already auto-load it.
# Precedence matches Bun dotenv: already-exported variables win over .env.
# A stale .env OPENROUTER_API_KEY must not overwrite the operator's export.
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    if [[ "$val" =~ ^\"(.*)\"$ ]]; then
      val="${BASH_REMATCH[1]}"
    elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi
    # Only fill when unset (exported or not) — never clobber existing env.
    if [ -z "${!key+x}" ]; then
      export "${key}=${val}"
    fi
  done < "$ROOT/.env"
fi

BASE_URL="http://127.0.0.1:3000"
CONFIG_PATH="${ROOT}/scripts/model-sweep.config.json"
PILOT=0
LOG_PATH="logs/leaky-service.jsonl"
CURSOR_PATH="pipelines/agent-sdk/.cursor.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "error: --base requires a URL" >&2
        exit 2
      fi
      BASE_URL="${2%/}"
      shift 2
      ;;
    --pilot)
      PILOT=1
      shift
      ;;
    --config)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "error: --config requires a path" >&2
        exit 2
      fi
      CONFIG_PATH="$2"
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--base URL] [--pilot] [--config path]

  --base URL     leaky-service base URL (default: http://127.0.0.1:3000)
  --pilot        1 model × 1 trial only (cheap smoke)
  --config path  matrix config JSON (default: scripts/model-sweep.config.json)

Budget halt: cumulative reported OpenRouter USD > budgetHaltUsd (default \$18)
stops the sweep (soft cap \$20). See README "Open-model sweeps (OpenRouter)".
EOF
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "error: OPENROUTER_API_KEY is required for money-true OpenRouter telemetry" >&2
  exit 1
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: opencode CLI not found on PATH" >&2
  exit 1
fi

probe_service() {
  if curl -sf --max-time 3 "${BASE_URL}/health" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

if ! probe_service; then
  cat >&2 <<EOF
error: leaky-service is not reachable at ${BASE_URL}

Start it first (separate terminal), then re-run this script:
  bun run service

Probe used: GET ${BASE_URL}/health
EOF
  exit 1
fi

PLAN_ARGS=(--config "${CONFIG_PATH}")
if [[ ${PILOT} -eq 1 ]]; then
  PLAN_ARGS+=(--pilot)
fi

echo "model-sweep: service ok at ${BASE_URL}"
if [[ ${PILOT} -eq 1 ]]; then
  echo "model-sweep: PILOT mode (1 model × 1 trial)"
fi

PLAN_JSON="$(bun run scripts/model-sweep.ts "${PLAN_ARGS[@]}")"
HALT_USD="$(printf '%s' "${PLAN_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.config.budgetHaltUsd))')"
CAP_USD="$(printf '%s' "${PLAN_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.config.budgetCapUsd))')"
TRAFFIC_COUNT="$(printf '%s' "${PLAN_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.config.trafficCount))')"
PLAN_COUNT="$(printf '%s' "${PLAN_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.plans.length))')"

echo "model-sweep: ${PLAN_COUNT} trial(s); budget halt \$${HALT_USD} (cap \$${CAP_USD})"
echo "model-sweep: VERIFY model ids against openrouter.ai/api/v1/models before relying on results"
mkdir -p traces

CUMULATIVE_USD="0"
TRACE_PATHS=()
FAILED_ROWS=()
HALTED=0

for ((i = 0; i < PLAN_COUNT; i++)); do
  TRIAL_JSON="$(printf '%s' "${PLAN_JSON}" | bun -e "
    const j = JSON.parse(await Bun.stdin.text());
    const p = j.plans[${i}];
    if (!p) process.exit(1);
    process.stdout.write(JSON.stringify(p));
  ")"
  LABEL="$(printf '%s' "${TRIAL_JSON}" | bun -e 'const p=JSON.parse(await Bun.stdin.text()); process.stdout.write(p.label)')"
  SEED="$(printf '%s' "${TRIAL_JSON}" | bun -e 'const p=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(p.seed))')"
  MODEL="$(printf '%s' "${TRIAL_JSON}" | bun -e 'const p=JSON.parse(await Bun.stdin.text()); process.stdout.write(p.openCodeModel)')"
  TRACE_PATH="$(printf '%s' "${TRIAL_JSON}" | bun -e 'const p=JSON.parse(await Bun.stdin.text()); process.stdout.write(p.tracePath)')"
  MODEL_ID="$(printf '%s' "${TRIAL_JSON}" | bun -e 'const p=JSON.parse(await Bun.stdin.text()); process.stdout.write(p.modelId)')"

  echo
  echo "=== trial: ${LABEL} ==="
  echo "model: ${MODEL_ID} (${MODEL})"
  echo "seed: ${SEED}"
  echo "trace: ${TRACE_PATH}"

  : >"${LOG_PATH}"
  if ! bun run traffic -- --count "${TRAFFIC_COUNT}" --seed "${SEED}" --base "${BASE_URL}"; then
    echo "warn: traffic generation failed for ${LABEL}; continuing" >&2
    FAILED_ROWS+=("${LABEL}:traffic")
    continue
  fi

  rm -f "${CURSOR_PATH}"

  set +e
  env \
    BUGLOOP_FIXER=opencode \
    BUGLOOP_OPENCODE_MODEL="${MODEL}" \
    OPENROUTER_API_KEY="${OPENROUTER_API_KEY}" \
    bun run pipeline:agent-sdk -- \
      --from-start \
      --fix \
      --base "${BASE_URL}" \
      --trace "${TRACE_PATH}" \
      --label "${LABEL}"
  pipeline_status=$?
  set -e

  if [[ ${pipeline_status} -ne 0 ]]; then
    echo "warn: pipeline exited ${pipeline_status} for ${LABEL}; continuing" >&2
    FAILED_ROWS+=("${LABEL}:pipeline(${pipeline_status})")
  fi

  if [[ -f "${TRACE_PATH}" ]]; then
    TRACE_PATHS+=("${TRACE_PATH}")
  else
    echo "warn: no trace written at ${TRACE_PATH}" >&2
    FAILED_ROWS+=("${LABEL}:missing-trace")
    continue
  fi

  # Sum reported USD for this trial and check cumulative halt.
  CHECK_JSON="$(
    bun -e '
      import {
        checkBudgetAfterTrial,
        trialUsdFromTraceFile,
      } from "./scripts/model-sweep.ts";
      const tracePath = process.argv[1];
      const cumulative = Number(process.argv[2]);
      const haltAt = Number(process.argv[3]);
      const cap = Number(process.argv[4]);
      const label = process.argv[5];
      const trace = await Bun.file(tracePath).json();
      const trialUsd = trialUsdFromTraceFile(trace);
      const result = checkBudgetAfterTrial({
        cumulativeUsd: cumulative,
        trialUsd,
        haltAtUsd: haltAt,
        capUsd: cap,
        label,
      });
      process.stdout.write(JSON.stringify(result));
    ' "${TRACE_PATH}" "${CUMULATIVE_USD}" "${HALT_USD}" "${CAP_USD}" "${LABEL}"
  )"
  TRIAL_USD="$(printf '%s' "${CHECK_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.trialUsd))')"
  CUMULATIVE_USD="$(printf '%s' "${CHECK_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.cumulativeUsd))')"
  DID_HALT="$(printf '%s' "${CHECK_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(j.halt ? "1" : "0")')"
  HALT_MSG="$(printf '%s' "${CHECK_JSON}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(j.message ?? "")')"

  echo "trial reported USD: \$${TRIAL_USD}  cumulative: \$${CUMULATIVE_USD} / halt \$${HALT_USD}"

  if [[ "${DID_HALT}" == "1" ]]; then
    echo
    echo "${HALT_MSG}"
    HALTED=1
    break
  fi
done

echo
echo "=== model-sweep summary ==="
echo "cumulative reported OpenRouter USD: \$${CUMULATIVE_USD} (halt \$${HALT_USD}, cap \$${CAP_USD})"
if [[ ${#TRACE_PATHS[@]} -gt 0 ]]; then
  bun run scripts/sweep-summary.ts "${TRACE_PATHS[@]}"
else
  echo "No trace files produced." >&2
fi

if [[ ${#FAILED_ROWS[@]} -gt 0 ]]; then
  echo
  echo "Completed with failures (non-fatal for the sweep):"
  for item in "${FAILED_ROWS[@]}"; do
    echo "  - ${item}"
  done
fi

if [[ ${HALTED} -eq 1 ]]; then
  exit 3
fi
