import { describe, expect, test } from 'bun:test'

import Board from '../../hooks/board'
import { BOARD_BACKLOG, boardOf } from '../../hooks/logic'
import type { BoardProps } from '../../hooks/logic'
import { EMPTY_GAME } from '../../hooks/logic'

// The board's module, run against a surface of its own: its elements draw
// plain data, and what it posts and keeps is recorded.
type Node = {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

Object.assign(globalThis, {
  h: (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ({ type, props: props ?? {}, children: children.flat() }) as Node,
  Fragment: 'Fragment',
})

function surfaceOf() {
  const posts: unknown[] = []
  const listeners: {
    key?: (e: unknown) => void
    pointer?: (e: unknown) => void
  } = {}
  let state: unknown
  const surface = {
    elements: { Box: 'Box', Text: 'Text' },
    get state() {
      return state
    },
    setState: (next: unknown) => {
      state = next
    },
    columns: 29,
    rows: 7,
    every: () => () => {},
    onKey: (fn: (e: unknown) => void) => {
      listeners.key = fn
      return () => {}
    },
    onPointer: (fn: (e: unknown) => void) => {
      listeners.pointer = fn
      return () => {}
    },
    post: (data: unknown) => {
      posts.push(data)
    },
  }
  return {
    posts,
    draw: (props: BoardProps) =>
      (Board as unknown as (p: BoardProps, s: unknown) => Node)(props, surface),
    key: (event: Record<string, unknown>) => listeners.key?.(event),
    pointer: (event: Record<string, unknown>) => listeners.pointer?.(event),
  }
}

function propsWith(change: Partial<BoardProps> = {}): BoardProps {
  return { ...boardOf(EMPTY_GAME, 0), frame: 'dim', count: 0, ...change }
}

describe('the board widget posts', () => {
  test('each input is numbered on and posted with every one not yet counted', () => {
    const board = surfaceOf()
    board.draw(propsWith())
    board.key({ key: 'left' })
    board.key({ key: 'up' })
    expect(board.posts).toEqual([
      { count: 1, inputs: [{ kind: 'key', key: 'left' }] },
      {
        count: 2,
        inputs: [
          { kind: 'key', key: 'left' },
          { kind: 'key', key: 'up' },
        ],
      },
    ])
  })

  test('once counted, inputs are not sent again', () => {
    const board = surfaceOf()
    board.draw(propsWith())
    board.key({ key: 'left' })
    board.key({ key: 'up' })
    board.draw(propsWith({ count: 2 }))
    board.key({ key: 'down' })
    expect(board.posts.at(-1)).toEqual({
      count: 3,
      inputs: [{ kind: 'key', key: 'down' }],
    })
  })

  test('a new board numbers on from the count it is given', () => {
    const board = surfaceOf()
    board.draw(propsWith({ count: 5 }))
    board.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    expect(board.posts).toEqual([{ count: 6, inputs: [{ kind: 'click' }] }])
  })

  test('past the bound the oldest go, so the post starts past the next number', () => {
    const board = surfaceOf()
    board.draw(propsWith())
    for (let k = 0; k < BOARD_BACKLOG + 6; k++) board.key({ key: 'left' })
    const last = board.posts.at(-1) as { count: number; inputs: unknown[] }
    expect(last.count).toBe(BOARD_BACKLOG + 6)
    expect(last.inputs).toHaveLength(BOARD_BACKLOG)
    expect(last.count - last.inputs.length + 1).toBe(7)
  })

  test('modifiers come as given, each only when held', () => {
    const board = surfaceOf()
    board.draw(propsWith())
    board.key({ key: 'tab', shift: true })
    board.key({ key: 'o', ctrl: true, meta: true })
    expect((board.posts.at(-1) as { inputs: unknown[] }).inputs).toEqual([
      { kind: 'key', key: 'tab', shift: true },
      { kind: 'key', key: 'o', ctrl: true, meta: true },
    ])
  })

  test('only a left-button press is a click', () => {
    const board = surfaceOf()
    board.draw(propsWith())
    board.pointer({ type: 'down', x: 1, y: 1, button: 'right' })
    board.pointer({ type: 'down', x: 1, y: 1, button: 'middle' })
    board.pointer({ type: 'down', x: 1, y: 1 })
    board.pointer({ type: 'move', x: 2, y: 1, button: 'left' })
    board.pointer({ type: 'up', x: 2, y: 1, button: 'left' })
    expect(board.posts).toEqual([])
    board.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    expect(board.posts).toEqual([{ count: 1, inputs: [{ kind: 'click' }] }])
  })
})

describe('the board widget draws its props', () => {
  const textOf = (node: unknown): string =>
    typeof node === 'string'
      ? node
      : typeof node === 'object' && node !== null
        ? ((node as Node).children ?? []).map(textOf).join('')
        : ''

  test('the frame is cyan while the game has the keys, Claude Code’s warning colour while a turn’s end fades, and dim otherwise', () => {
    const board = surfaceOf()
    const frameOf = (tree: Node) => tree.children[0] as Node
    const game = frameOf(board.draw(propsWith({ frame: 'game' }))).props
    expect(game).toMatchObject({ borderStyle: 'round', borderColor: 'cyan' })
    expect(game.borderDimColor).toBeUndefined()
    const fade = frameOf(board.draw(propsWith({ frame: 'fade' }))).props
    expect(fade).toMatchObject({ borderStyle: 'round', borderColor: 'warning' })
    expect(fade.borderDimColor).toBeUndefined()
    const dim = frameOf(board.draw(propsWith({ frame: 'dim' }))).props
    expect(dim).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    expect(dim.borderColor).toBeUndefined()
  })

  test('an occupied tile is drawn in its own colours, never dimmed, whatever the frame', () => {
    const board = surfaceOf()
    const game = {
      ...EMPTY_GAME,
      cells: [2, 0, 2048, ...new Array(13).fill(0)],
    }
    for (const frame of ['game', 'fade', 'dim'] as const) {
      const tree = board.draw({ ...propsWith({ frame }), ...boardOf(game, 0) })
      const first = (tree.children[0] as Node).children[0] as Node
      const tiles = first.children.filter(
        (child): child is Node =>
          typeof child === 'object' &&
          child !== null &&
          (child as Node).props.backgroundColor !== undefined,
      )
      const view = boardOf(game, 0).tiles
      expect(tiles.map(tile => tile.props)).toEqual([
        {
          backgroundColor: view[0]?.background,
          color: view[0]?.color,
          bold: true,
        },
        {
          backgroundColor: view[2]?.background,
          color: view[2]?.color,
          bold: true,
        },
      ])
    }
  })

  test('four rows of four 6-column tiles with a space between, and the caption under the frame', () => {
    const board = surfaceOf()
    const game = {
      ...EMPTY_GAME,
      cells: [2, 2048, 0, 131072, ...new Array(12).fill(0)],
    }
    const tree = board.draw({ ...propsWith(), ...boardOf(game, 0) })
    const rows = (tree.children[0] as Node).children
    expect(rows).toHaveLength(4)
    expect(textOf(rows[0])).toBe('  2     2048    ·    131072')
    for (const row of rows) expect(textOf(row)).toHaveLength(27)
    expect(textOf(tree.children[1])).toBe('score 0 · best 0')
    for (const row of rows)
      expect((row as Node).props.wrap).toBe('truncate-end')
    expect((tree.children[1] as Node).props.wrap).toBe('truncate-end')
  })

  test('the largest tiles still fit their row', () => {
    const board = surfaceOf()
    const game = { ...EMPTY_GAME, cells: new Array(16).fill(2 ** 30) }
    const tree = board.draw({ ...propsWith(), ...boardOf(game, 0) })
    for (const row of (tree.children[0] as Node).children) {
      expect(textOf(row)).toHaveLength(27)
    }
  })
})
