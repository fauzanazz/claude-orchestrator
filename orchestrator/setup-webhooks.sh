#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
source "$SCRIPT_DIR/.env"

PROJECTS_JSON="$SCRIPT_DIR/../planner/projects.json"
WEBHOOK_URL="https://${TUNNEL_HOSTNAME}/webhook/github"

if [ -z "$GITHUB_WEBHOOK_SECRET" ]; then
  echo "Error: GITHUB_WEBHOOK_SECRET not set in .env" >&2
  exit 1
fi

if [ -z "$TUNNEL_HOSTNAME" ]; then
  echo "Error: TUNNEL_HOSTNAME not set in .env" >&2
  exit 1
fi

REPOS=$(jq -r '.[].repo' "$PROJECTS_JSON" | sort -u)

if [ -z "$REPOS" ]; then
  echo "No repos found in $PROJECTS_JSON"
  exit 0
fi

echo "Adding PR review webhook to repos:"
echo "  URL: $WEBHOOK_URL"
echo ""

for REPO in $REPOS; do
  echo -n "  $REPO ... "

  # Check we have admin access (listing hooks requires it)
  if ! gh api "repos/$REPO/hooks" --silent 2>/dev/null; then
    echo "skipped (no admin access)"
    continue
  fi

  # Check if webhook already exists for this URL
  EXISTING=$(gh api "repos/$REPO/hooks" --jq ".[] | select(.config.url == \"$WEBHOOK_URL\") | .id")

  if [ -n "$EXISTING" ]; then
    echo "already exists (hook $EXISTING)"
    continue
  fi

  gh api "repos/$REPO/hooks" \
    --method POST \
    -f name=web \
    -F active=true \
    -f "events[]=pull_request_review" \
    -f "config[url]=$WEBHOOK_URL" \
    -f "config[content_type]=json" \
    -f "config[secret]=$GITHUB_WEBHOOK_SECRET" \
    --silent

  echo "done"
done

echo ""
echo "Webhooks configured."
