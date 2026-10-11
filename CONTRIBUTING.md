# Contributing

## Principles

- **Logic is separate from the UI.** Every decision is a pure function: it
  takes values and returns values, and never touches `$`, the clock or
  randomness. UI files only draw and report raw input. `register.tsx` is a thin
  shell: read the state, call the logic, write the result, carry out the effects
  the logic returned.
- **Few files, well structured.** A mod is a handful of files: the logic, the
  UI and the shell. Split a file only when part of it becomes its own domain.
  Every exported function has a doc comment saying what it decides.
- **State is versioned and read defensively.** State is kept under a shape tag,
  so state written by older code reads as absent rather than wrong. Everything
  read back is checked before use, and a widget never gets `undefined` props.
- Strict TypeScript, no `any`. Formatting follows `.prettierrc`.

## Tests

- **Unit tests** (`tests/unit/*.spec.ts`, run with Bun) cover the logic. They
  are fast, independent and deterministic: time and randomness are passed in.
  The logic imports only types from `claude-code`, so it runs outside Claude
  Code.
- **Engine tests** (`tests/engine/*.test.ts`, run with `claude plugin test`)
  cover the wiring through Claude Code's test kit.
- Test titles describe behavior in plain words.

## Checks

    scripts/check.sh           # everything: format, manifests, types, both test sets
    scripts/check.sh unit      # unit tests only
    scripts/check.sh engine    # engine tests only

You need Claude Code, Bun and Node; Prettier and TypeScript run at pinned
versions. Type checking reads the types Claude Code writes beside a mod when it
loads one, so run `claude --plugin-dir mods/<name>` once after cloning. Every
commit passes `scripts/check.sh`.

## Versions

A mod's version lives in its `plugin.json`, as semver. A release bumps it and
is tagged with `claude plugin tag`. `main` is always releasable, so unfinished
work stays on a branch. Each mod's README names the Claude Code version it was
tested with.
