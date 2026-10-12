#!/usr/bin/env bash
# pnpm otui — opentui-slack (from source) against the server `pnpm dev:all` runs.
# Its own config dir, daemon socket and no web page, so it runs beside your
# Slack setup. The variables are exported, so they win over the .env in the
# opentui-slack repo (Bun never overrides what the environment has).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${CAMPFLARE_DEV_ENV:-$root/apps/server/.wrangler/campflare-dev.env}"
[ -f "$env_file" ] || { echo "no $env_file: run pnpm dev:all first" >&2; exit 2; }
set -a
. "$env_file"
set +a
otui_home="$(dirname "$env_file")/otui"
mkdir -p -m 700 "$otui_home"
export XDG_CONFIG_HOME="$otui_home" OPENTUI_SLACK_SOCKET="$otui_home/control.sock" OPENTUI_SLACK_WEB_PORT=off
cd "${OPENTUI_SLACK_REPO:-$HOME/Projects/solcreek/opentui-slack}"
exec bun src/index.tsx "$@"
