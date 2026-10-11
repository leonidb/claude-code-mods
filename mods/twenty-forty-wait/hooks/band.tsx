import type { ElementTable, RenderElement } from 'claude-code'

import { BOARD_COLUMNS, SIDE_GAP } from './logic'
import type {
  BandView,
  CardView,
  MinimizedView,
  ModeView,
  StatusView,
} from './logic'

/** The elements the band draws with, from the surface's table. */
export type BandElements = Pick<
  ElementTable<'terminal'>,
  'Box' | 'Text' | 'Client'
>

/**
 * Draws the band's view as it is: the board beside the card or the live
 * view, or above it when narrow, and the mode row at the bottom, unless it
 * has nothing to say. Each text is one row of its own, cut at the band's
 * width, so the band is never taller than its layout. Nothing is decided here.
 */
export function bandTree(
  ui: BandElements,
  view: Exclude<BandView, { kind: 'none' }>,
): RenderElement {
  const { Box, Text } = ui
  if (view.kind === 'minimized') {
    return (
      <Text wrap="truncate-end">
        {headTree(ui, view.tone, view.head)}
        <Text dimColor>{view.tail}</Text>
      </Text>
    )
  }
  const { Client } = ui
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection={view.direction} columnGap={SIDE_GAP}>
        <Client
          key={view.boardKey}
          module="./board.tsx"
          props={{
            ...view.board,
            frame: view.frame,
            count: view.count,
          }}
          width={BOARD_COLUMNS}
        />
        <Box flexDirection="column" flexGrow={1}>
          {view.card !== null
            ? cardTree(ui, view.card)
            : view.status !== null
              ? statusTree(ui, view.status)
              : null}
        </Box>
      </Box>
      {view.mode.line !== '' ? modeTree(ui, view.mode) : null}
    </Box>
  )
}

// The mode row: highlighted while the game has the keys, dimmed otherwise.
function modeTree(ui: BandElements, mode: ModeView): RenderElement {
  const { Text } = ui
  return mode.isActive ? (
    <Text color="cyan" bold wrap="truncate-end">
      {mode.line}
    </Text>
  ) : (
    <Text dimColor wrap="truncate-end">
      {mode.line}
    </Text>
  )
}

function cardTree(ui: BandElements, card: CardView): RenderElement {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color="green" bold wrap="truncate-end">
        {card.heading}
      </Text>
      {card.stats !== null ? (
        <Text dimColor wrap="truncate-end">
          {card.stats}
        </Text>
      ) : null}
      {card.rows.map(row => (
        <Text wrap="truncate-end">{row}</Text>
      ))}
      {card.files !== null ? (
        <Text dimColor wrap="truncate-end">
          {card.files}
        </Text>
      ) : null}
    </Box>
  )
}

// A state's first words in its tone: plain while Claude works, the banner
// while a turn's end fades (Claude Code's warning colour, bold, is for this
// warning alone), the card's heading, or dim while idle.
function headTree(
  ui: BandElements,
  tone: MinimizedView['tone'],
  text: string,
): RenderElement {
  const { Text } = ui
  return tone === 'working' ? (
    <Text>{text}</Text>
  ) : tone === 'waiting' ? (
    <Text color="warning" bold>
      {text}
    </Text>
  ) : tone === 'card' ? (
    <Text color="green" bold>
      {text}
    </Text>
  ) : (
    <Text dimColor>{text}</Text>
  )
}

function statusTree(ui: BandElements, status: StatusView): RenderElement {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text wrap="truncate-end">
        {headTree(ui, status.tone, status.headline)}
      </Text>
      {status.current.map(line => (
        <Text wrap="truncate-end">{line}</Text>
      ))}
      {status.before.map(line => (
        <Text dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}
