# claude-code-mods

[Mods](https://code.claude.com/docs/en/plugins/mods/overview) are Claude Code
plugins that can add to its interface, such as a panel above the prompt.

| Mod                                         | What it does                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Twenty Forty-Wait](mods/twenty-forty-wait) | A 2048 game above the prompt to keep your attention in Claude Code while it works, with a live view of Claude's work and a your-turn card when it stops. |

## Install

    /plugin install twenty-forty-wait --marketplace leonidb/claude-code-mods

Or add the marketplace once, then install from it:

    /plugin marketplace add leonidb/claude-code-mods
    /plugin install twenty-forty-wait@leonidb

## Requirements

Claude Code 2.1.289 or later. Each mod's README names the version it was
tested with.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

An independent community project, not affiliated with or endorsed by Anthropic.
[Apache License 2.0](LICENSE).
