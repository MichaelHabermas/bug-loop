#!/usr/bin/env bash
# Phase C quick cost sweep: run the agent-sdk pipeline dry-fix under several
# model/effort configs and collect traces for comparison.
#
# Usage:
#   ./scripts/cost-sweep.sh [--base URL]
#
# Prerequisites: leaky-service already listening at --base (default http://127.0.0.1:3000).
# Does not commit or push.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_URL="http://127.0.0.1:3000"
TRAFFIC_SEED=42
TRAFFIC_COUNT=50
CURSOR_PATH="pipelines/agent-sdk/.cursor.json"
LOG_PATH="logs/leaky-service.jsonl"

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
    -h|--help)
      echo "Usage: $0 [--base URL]"
      echo "  --base URL   leaky-service base URL (default: http://127.0.0.1:3000)"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo "Usage: $0 [--base URL]" >&2
      exit 2
      ;;
  esac
done

# name|space-separated env assignments applied only for that row
CONFIG_MATRIX=(
  "baseline|BUGLOOP_TRIAGE_MODEL=sonnet BUGLOOP_FIXER=grok"
  "grok-low|BUGLOOP_TRIAGE_MODEL=sonnet BUGLOOP_FIXER=grok BUGLOOP_GROK_EFFORT=low"
  "haiku-triage|BUGLOOP_TRIAGE_MODEL=haiku BUGLOOP_FIXER=grok"
  "codex-luna|BUGLOOP_TRIAGE_MODEL=sonnet BUGLOOP_FIXER=codex BUGLOOP_CODEX_MODEL=gpt-5.6-luna"
)

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

echo "cost-sweep: service ok at ${BASE_URL}"
mkdir -p traces

TRACE_PATHS=()
FAILED_ROWS=()

for row in "${CONFIG_MATRIX[@]}"; do
  name="${row%%|*}"
  env_assignments="${row#*|}"
  trace_path="traces/sweep-${name}.json"

  echo
  echo "=== config: ${name} ==="
  echo "env: ${env_assignments}"
  echo "trace: ${trace_path}"

  # Fresh traffic under a fixed seed so rows are comparable; clear prior log so
  # --from-start does not re-ingest older sweeps.
  : >"${LOG_PATH}"
  if ! bun run traffic -- --count "${TRAFFIC_COUNT}" --seed "${TRAFFIC_SEED}" --base "${BASE_URL}"; then
    echo "warn: traffic generation failed for ${name}; continuing" >&2
    FAILED_ROWS+=("${name}:traffic")
    continue
  fi

  rm -f "${CURSOR_PATH}"

  # shellcheck disable=SC2086 # intentional word-split of env_assignments
  set +e
  env ${env_assignments} bun run pipeline:agent-sdk -- \
    --from-start \
    --fix \
    --base "${BASE_URL}" \
    --trace "${trace_path}" \
    --label "${name}"
  pipeline_status=$?
  set -e

  if [[ ${pipeline_status} -ne 0 ]]; then
    echo "warn: pipeline exited ${pipeline_status} for ${name}; continuing" >&2
    FAILED_ROWS+=("${name}:pipeline(${pipeline_status})")
  fi

  if [[ -f "${trace_path}" ]]; then
    TRACE_PATHS+=("${trace_path}")
  else
    echo "warn: no trace written at ${trace_path}" >&2
    FAILED_ROWS+=("${name}:missing-trace")
  fi
done

echo
echo "=== cost-sweep summary ==="
if [[ ${#TRACE_PATHS[@]} -eq 0 ]]; then
  echo "No trace files produced." >&2
  exit 1
fi

bun run scripts/sweep-summary.ts "${TRACE_PATHS[@]}"

if [[ ${#FAILED_ROWS[@]} -gt 0 ]]; then
  echo
  echo "Completed with failures (non-fatal for the sweep):"
  for item in "${FAILED_ROWS[@]}"; do
    echo "  - ${item}"
  done
fi
