#!/usr/bin/env bash
set -euo pipefail

# Query orchestrator run history for the planner's feedback loop.
# Usage:
#   feedback.sh                          # recent runs (last 10)
#   feedback.sh --project claude-orchestrator
#   feedback.sh --status failed
#   feedback.sh --issue FAU-10           # runs for a specific issue
#   feedback.sh --limit 20

BASE_URL="${ORCHESTRATOR_URL:-http://localhost:7400}"

# Parse args
PROJECT="" STATUS="" ISSUE="" LIMIT="10"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --status)  STATUS="$2";  shift 2 ;;
    --issue)   ISSUE="$2";   shift 2 ;;
    --limit)   LIMIT="$2";   shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Build query string
QS="limit=${LIMIT}"
[ -n "$PROJECT" ] && QS="${QS}&project=${PROJECT}"
[ -n "$STATUS" ]  && QS="${QS}&status=${STATUS}"

# Fetch runs
RESPONSE=$(curl -sf "${BASE_URL}/api/runs?${QS}" 2>/dev/null) || {
  echo "Error: orchestrator not reachable at ${BASE_URL}" >&2
  echo "Is the orchestrator running? (cd orchestrator && bun run dev)" >&2
  exit 1
}

# Filter by issue key if specified
if [ -n "$ISSUE" ]; then
  RESPONSE=$(echo "$RESPONSE" | jq --arg key "$ISSUE" '[.[] | select(.issue_key == $key)]')
fi

# Format as compact table
echo "$RESPONSE" | jq -r '
  ["ISSUE", "STATUS", "ITERS", "RETRY", "ERROR", "PR"],
  (.[] | [
    .issue_key,
    .status,
    (.iterations | tostring),
    (.retry_attempt | tostring),
    (.error_summary // "-" | if length > 60 then .[:57] + "..." else . end),
    (.pr_url // "-" | if length > 40 then .[:37] + "..." else . end)
  ]) | @tsv' | column -t -s $'\t' 2>/dev/null || {
  # Fallback if column not available
  echo "$RESPONSE" | jq -r '.[] | "\(.issue_key)\t\(.status)\t\(.iterations) iters\t\(.error_summary // "-")"'
}

COUNT=$(echo "$RESPONSE" | jq 'length')
echo ""
echo "${COUNT} run(s) shown"
