import { describe, expect, test } from 'bun:test'

import manifest from '../../.claude-plugin/plugin.json' with { type: 'json' }

describe('the manifest', () => {
  // Rule change: the mod has no settings, so Claude Code shows no settings
  // screen when it's installed, and settings an older version kept don't
  // reach it.
  test('declares no settings', () => {
    expect(Object.keys(manifest)).not.toContain('userConfig')
  })
})
