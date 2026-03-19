#!/usr/bin/env bash

set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required but was not found in PATH." >&2
  exit 1
fi

COUNT="${npm_config_n:-${1:-}}"

if [[ -z "${COUNT}" ]]; then
  echo "Usage: npm run dev:tmux -- <count>" >&2
  echo "   or: npm run dev:tmux --n=<count>" >&2
  exit 1
fi

if ! [[ "${COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Count must be a positive integer. Received: ${COUNT}" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="chat-test-harness-dev-$(date +%s)"
RUN_CMD="cd \"$ROOT_DIR\" && npm run dev; exec \"${SHELL:-/bin/bash}\" -l"

tmux new-session -d -s "${SESSION_NAME}" -n "dev-1" "${RUN_CMD}"

for ((index = 2; index <= COUNT; index += 1)); do
  tmux new-window -t "${SESSION_NAME}" -n "dev-${index}" "${RUN_CMD}"
done

echo "Started ${COUNT} tmux window(s) in session: ${SESSION_NAME}"

if [[ -n "${TMUX:-}" ]]; then
  tmux switch-client -t "${SESSION_NAME}"
else
  exec tmux attach -t "${SESSION_NAME}"
fi
