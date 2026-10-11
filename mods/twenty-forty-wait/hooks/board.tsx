import type { ClientModule, ClientSurface, JsonValue } from 'claude-code'

import { BOARD_BACKLOG } from './logic'
import type { BoardProps, Tile } from './logic'

// The inputs not yet acknowledged, each with its number, and the last number
// given. Dropped with the instance; a new one numbers on from the count the
// model acknowledged, which its props carry.
type Local = { last: number; backlog: { number: number; input: JsonValue }[] }

const TILE_WIDTH = 6

/**
 * The 2048 board in the band: its tiles in a frame, highlighted while the
 * game has the keys, in Claude Code's warning colour while a turn's end fades
 * with the game on, and the scores under it. It draws its props and posts
 * every click and key it gets; the hooks decide what they mean.
 *
 * Each input gets the next number and is posted at once together with every
 * input before it the model hasn't acknowledged yet, so an input lost
 * between frames arrives with the next one, and one sent twice counts once.
 */
const Board: ClientModule<BoardProps, Local> = (props, surface) => {
  // Set again on each call, so an input is numbered and trimmed against the
  // count acknowledged in the latest props.
  surface.onKey(event => {
    sent(surface, props.count, {
      kind: 'key',
      key: event.key,
      ...(event.ctrl === true ? { ctrl: true } : {}),
      ...(event.shift === true ? { shift: true } : {}),
      ...(event.meta === true ? { meta: true } : {}),
    })
  })
  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'left') {
      sent(surface, props.count, { kind: 'click' })
    }
  })
  const { Box, Text } = surface.elements
  const rows = [0, 1, 2, 3].map(row => (
    <Text wrap="truncate-end">
      {props.tiles.slice(row * 4, row * 4 + 4).flatMap((tile, column) => {
        const drawn = tileTree(surface, tile)
        return column === 0 ? [drawn] : [<Text> </Text>, drawn]
      })}
    </Text>
  ))
  return (
    <Box flexDirection="column">
      {props.frame === 'game' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan">
          {rows}
        </Box>
      ) : props.frame === 'fade' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="warning">
          {rows}
        </Box>
      ) : (
        <Box flexDirection="column" borderStyle="round" borderDimColor>
          {rows}
        </Box>
      )}
      <Text dimColor wrap="truncate-end">
        {props.caption}
      </Text>
    </Box>
  )
}

export default Board

// Numbers the input, keeps it with the backlog not yet acknowledged, and
// posts them all. Past the bound the oldest go, and the model, seeing the
// gap, hands the keys back.
function sent(
  surface: ClientSurface<Local>,
  acknowledged: number,
  input: JsonValue,
): void {
  const kept = surface.state ?? { last: acknowledged, backlog: [] }
  const last = Math.max(kept.last, acknowledged) + 1
  const backlog = [
    ...kept.backlog.filter(entry => entry.number > acknowledged),
    { number: last, input },
  ].slice(-BOARD_BACKLOG)
  surface.setState({ last, backlog })
  surface.post({ count: last, inputs: backlog.map(entry => entry.input) })
}

// One tile, its value centred in a fixed width; an empty cell in the
// theme's own text colour, dimmed.
function tileTree(surface: ClientSurface<Local>, tile: Tile) {
  const { Text } = surface.elements
  const left = Math.floor((TILE_WIDTH - tile.text.length) / 2)
  const label = tile.text
    .padStart(tile.text.length + Math.max(0, left))
    .padEnd(TILE_WIDTH)
  return tile.isEmpty ? (
    <Text dimColor>{label}</Text>
  ) : (
    <Text backgroundColor={tile.background} color={tile.color} bold>
      {label}
    </Text>
  )
}
