// Unit specs run on Bun and import its runner from `bun:test`. Typed here as
// the Claude Code test kit's describe, test and expect, so tsc checks them with
// no package.json, and a spec can use only the matchers both runners have.
declare module 'bun:test' {
  export { describe, expect, test } from 'claude-code/testing'
}
