import { describe, expect, test } from 'bun:test'

import { bandTree } from '../../hooks/band'
import type { BandElements } from '../../hooks/band'
import { boardOf } from '../../hooks/logic'
import type { MinimizedView, ModeView } from '../../hooks/logic'

// The band's drawing, run against elements that draw plain data.
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

const UI = {
  Box: 'Box',
  Text: 'Text',
  Client: 'Client',
} as unknown as BandElements

// Every text in the tree, with the style it asks for: a Text's own props
// over those of the Text it sits in.
function textsOf(
  node: unknown,
  inherited: Record<string, unknown> = {},
): { text: string; style: Record<string, unknown> }[] {
  if (typeof node !== 'object' || node === null) return []
  const { type, props, children } = node as Node
  const style = type === 'Text' ? { ...inherited, ...props } : {}
  const own = children.filter(child => typeof child === 'string').join('')
  return [
    ...(type === 'Text' && own.length > 0 ? [{ text: own, style }] : []),
    ...children.flatMap(child => textsOf(child, style)),
  ]
}

describe('the minimized band', () => {
  const line = (tone: MinimizedView['tone'], head: string) =>
    textsOf(
      bandTree(UI, {
        kind: 'minimized',
        tone,
        head,
        tail: ' · more rows show the game',
      }),
    )
  const ROW = { wrap: 'truncate-end' }
  const TAIL = {
    text: ' · more rows show the game',
    style: { ...ROW, dimColor: true },
  }

  test('leads with the state in its tone, on one cut row, and the rest dim', () => {
    expect(line('working', '● Claude is working · 3s')).toEqual([
      { text: '● Claude is working · 3s', style: ROW },
      TAIL,
    ])
    // Rule change: the banner is Claude Code's warning colour as bold text,
    // on no background.
    expect(
      line('waiting', 'Claude is waiting for you · the board locks in 3s'),
    ).toEqual([
      {
        text: 'Claude is waiting for you · the board locks in 3s',
        style: { ...ROW, color: 'warning', bold: true },
      },
      TAIL,
    ])
    expect(line('card', '✓ YOUR TURN')).toEqual([
      { text: '✓ YOUR TURN', style: { ...ROW, color: 'green', bold: true } },
      TAIL,
    ])
    expect(line('idle', "No activity yet · Claude's work shows here")).toEqual([
      {
        text: "No activity yet · Claude's work shows here",
        style: { ...ROW, dimColor: true },
      },
      TAIL,
    ])
  })
})

describe('the card and the live view, row by row', () => {
  const rowsOf = (node: unknown) =>
    textsOf(node).map(({ text, style }) => [text, style.wrap])

  // Rule change: the next step was its own bold rows; now the paragraph's
  // rows are all plain, and only the heading is bold.
  test('each row of the card is a cut row of its own, plain, and a row that gave way is not drawn', () => {
    const card = {
      heading: '✓ YOUR TURN · 30s · 2 tools · 1 file',
      stats: null,
      text: 'One two three four. Five six seven.',
      rows: ['One two three', 'four. Five six', 'seven.'],
      files: null,
    }
    const tree = bandTree(UI, { kind: 'plain', status: null, card })
    expect(rowsOf(tree)).toEqual([
      ['✓ YOUR TURN · 30s · 2 tools · 1 file', 'truncate-end'],
      ['One two three', 'truncate-end'],
      ['four. Five six', 'truncate-end'],
      ['seven.', 'truncate-end'],
    ])
    const bold = textsOf(tree).filter(({ style }) => style.bold === true)
    expect(bold.map(({ text }) => text)).toEqual([
      '✓ YOUR TURN · 30s · 2 tools · 1 file',
    ])
  })

  test('each row under the banner is a cut row of its own', () => {
    const status = {
      tone: 'waiting' as const,
      headline: 'locks in 3s',
      current: ['one two', 'three four'],
      before: ['→ five six', 'seven'],
    }
    const tree = bandTree(UI, { kind: 'plain', status, card: null })
    expect(rowsOf(tree)).toEqual([
      ['locks in 3s', 'truncate-end'],
      ['one two', 'truncate-end'],
      ['three four', 'truncate-end'],
      ['→ five six', 'truncate-end'],
      ['seven', 'truncate-end'],
    ])
  })
})

describe('the mode row', () => {
  const GAME = {
    cells: [2, 4, ...new Array<number>(14).fill(0)],
    score: 0,
    best: 0,
    isOver: false,
    hasWon: false,
    moves: 0,
  }
  // What the full band draws, top to bottom, beside the board or under it:
  // the board with the card, then the mode row, if any.
  const partsOf = (mode: ModeView, direction: 'row' | 'column') =>
    (
      bandTree(UI, {
        kind: 'full',
        direction,
        status: null,
        card: {
          heading: '✓ YOUR TURN · 30s · 2 tools',
          stats: null,
          text: 'Ran the command.',
          rows: ['Ran the command.'],
          files: null,
        },
        board: boardOf(GAME, 1),
        boardKey: 'board-1',
        count: 0,
        frame: 'dim',
        mode,
      }) as unknown as Node
    ).children.filter(
      child => child !== null && child !== undefined && child !== false,
    )
  const modeRow = (mode: ModeView, direction: 'row' | 'column') => {
    const parts = partsOf(mode, direction)
    expect(parts).toHaveLength(2)
    return parts[1]
  }
  const DIM = { wrap: 'truncate-end', dimColor: true }
  const GAME_ROW = { wrap: 'truncate-end', color: 'cyan', bold: true }

  for (const direction of ['row', 'column'] as const) {
    // Rule change: with nothing to say, behind the card, the mode row isn't
    // drawn at all, not even blank, so the band is a row shorter.
    test(`with nothing to say there's no mode row, not even blank (${direction})`, () => {
      const parts = partsOf({ line: '', isActive: false }, direction)
      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({
        type: 'Box',
        props: { flexDirection: direction },
      })
      // Nor does it move into the board or the card: what's drawn above the
      // mode row is the same with one or without.
      expect(parts[0]).toEqual(
        partsOf(
          { line: '▶ click the board to play', isActive: false },
          direction,
        )[0],
      )
    })

    // Exactly one text, so nothing around it can give it more rows.
    test(`any other mode row is one cut row of text (${direction})`, () => {
      for (const [line, style] of [
        ['○ playable while Claude works', DIM],
        ['▶ click the board to play', DIM],
        ['▶ click the board for a new game', DIM],
      ] as const) {
        expect(modeRow({ line, isActive: false }, direction)).toEqual({
          type: 'Text',
          props: style,
          children: [line],
        })
      }
      for (const line of [
        '● GAME · arrows play · Tab to type',
        '● GAME · finish your move · Tab to type',
        '⌨ keys are in the game · Tab to type',
      ]) {
        expect(modeRow({ line, isActive: true }, direction)).toEqual({
          type: 'Text',
          props: GAME_ROW,
          children: [line],
        })
      }
    })
  }
})
