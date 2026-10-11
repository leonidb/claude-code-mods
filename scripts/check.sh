#!/usr/bin/env bash
# Every check a change must pass before it lands, from anywhere in the repo:
#
#   scripts/check.sh           all of them, in order, stopping at the first failure
#   scripts/check.sh unit      the unit specs alone (pure functions, on Bun)
#   scripts/check.sh engine    the engine tests alone (claude plugin test)
#
# Needs Claude Code, Bun and Node (for npx). Prettier and TypeScript run at the
# versions pinned below, so no package.json is needed.
set -euo pipefail

MOD=mods/twenty-forty-wait
PRETTIER=prettier@3.9.9
TYPESCRIPT=typescript@5.9.3

cd "$(dirname "$0")/.."

step() {
  printf '\n== %s\n' "$1"
}

unit() {
  step 'unit specs: bun test'
  # The config beside the specs has Bun compile JSX as Claude Code does.
  bun --config="./$MOD/tests/unit/bunfig.toml" test "./$MOD/tests/unit"
}

engine() {
  step 'engine tests: claude plugin test'
  claude plugin test "$MOD"
}

format() {
  step 'format: prettier --check'
  # Exactly the files git tracks or would track, so anything git ignores (in
  # .gitignore or a local exclude) is left alone.
  git ls-files -z --cached --others --exclude-standard |
    xargs -0 npx --yes "$PRETTIER" --check --ignore-unknown
}

manifests() {
  step 'manifests: claude plugin validate --strict'
  claude plugin validate --strict .
  claude plugin validate --strict "$MOD"
}

types() {
  step 'types: tsc'
  # tsc reads the Claude Code types the mod's tsconfig extends. Claude Code
  # writes them beside the mod when an interactive session loads it.
  if [[ ! -f "$MOD/.claude-plugin/types/tsconfig.json" ]]; then
    echo "The generated Claude Code types are missing from $MOD/.claude-plugin/types/." >&2
    echo "Start 'claude --plugin-dir $MOD' once, quit it, then run this again." >&2
    exit 1
  fi
  npx --yes -p "$TYPESCRIPT" tsc -p "$MOD"
}

case "${1:-all}" in
  unit) unit ;;
  engine) engine ;;
  all)
    format
    manifests
    types
    unit
    engine
    printf '\nAll checks passed.\n'
    ;;
  *)
    echo 'usage: scripts/check.sh [unit|engine]' >&2
    exit 2
    ;;
esac
