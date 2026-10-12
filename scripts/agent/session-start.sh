#!/usr/bin/env bash
# Claude Code SessionStart hook.
#
# 1. Every agent command runs on the flake's toolchain: agents start a fresh
#    shell per command, so `nix develop` never reaches them; Claude Code runs
#    $CLAUDE_ENV_FILE before each Bash command instead, and this puts
#    .dev/dev-tools/bin first on PATH there. The out-link is also a GC root,
#    so garbage collection can't take the toolchain away mid-session.
# 2. `pnpm ready --quick`: silent when the checkout is ready; otherwise what
#    isn't, as context for the agent.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

if command -v nix >/dev/null 2>&1 && nix build --quiet --out-link .dev/dev-tools '.#dev-tools' >/dev/null 2>&1; then
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    bin="$PWD/.dev/dev-tools/bin"
    # Runs before every command, and SessionStart fires again on resume: add the entry once.
    # $PATH stays literal on purpose: it expands when the line runs.
    # shellcheck disable=SC2016
    printf 'case ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' "$bin" "$bin" >> "$CLAUDE_ENV_FILE"
  fi
else
  echo "Nix toolchain unavailable (nix build .#dev-tools failed or nix is missing): commands use the Node on PATH."
fi

scripts/agent/node scripts/agent/ready-summary.ts
exit 0
