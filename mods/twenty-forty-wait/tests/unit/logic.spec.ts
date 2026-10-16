import { describe, expect, test } from 'bun:test'

import {
  BOARD_BACKLOG,
  BOARD_COLUMNS,
  EMPTY_GAME,
  INITIAL_MODEL,
  afterDialog,
  afterFault,
  afterGame,
  afterBoardPost,
  afterHandoff,
  afterPrompt,
  afterRestore,
  afterSummary,
  afterTick,
  afterToggle,
  afterToolCall,
  afterToolDone,
  afterTurnEnd,
  afterTurnStart,
  bandOf,
  bandRowsOf,
  bestOf,
  boardKeyOf,
  boardOf,
  boardPostOf,
  callOf,
  cardOf,
  elapsedText,
  fadeOf,
  gameOf,
  handoffOf,
  isDealt,
  isLocked,
  isReadFirst,
  isTicking,
  isTimeShown,
  modeOf,
  modelOf,
  rowsTakenOf,
  paragraphOf,
  placeholderOf,
  statusOf,
  summaryOf,
  summaryRequestOf,
  toggleNoteOf,
  toolSucceeded,
  turnKeyOf,
  writeOf,
} from '../../hooks/logic'
import { played } from '../../hooks/game'
import type {
  BoardInput,
  BoardPost,
  CardView,
  Room,
  TurnEnd,
} from '../../hooks/logic'
import type { Game, Model } from '../../types'

const GAME: Game = {
  cells: [2, 4, 0, 0, 8, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 2048],
  score: 1200,
  best: 3000,
  isOver: false,
  hasWon: true,
  moves: 140,
}

// Always the first empty cell, and always a 2.
const first = () => 0

function modelWith(change: Partial<Model>): Model {
  return { ...INITIAL_MODEL, ...change }
}

describe('modelOf', () => {
  test('anything that is not a model reads as the initial model', () => {
    for (const raw of [undefined, null, 'model', 42, [], true]) {
      expect(modelOf(raw)).toEqual(INITIAL_MODEL)
    }
  })

  test('a valid model is read back unchanged', () => {
    const model = modelWith({
      isOn: true,
      isSeeded: true,
      mode: 'game',
      game: GAME,
      board: { epoch: 4, count: 17 },
      hasStrayKey: true,
      turn: {
        ...INITIAL_MODEL.turn,
        turnId: 't1',
        phase: 'done',
        startedAt: 1000,
        endedAt: 5000,
        tools: 3,
        current: null,
        recent: [{ tool: 'Bash', target: 'Run the tests' }],
        files: ['/repo/a.ts'],
        reason: 'answer',
        summary: 'Fixed it.',
        next: 'Run the tests.',
        lockAt: 5000,
        isShown: true,
      },
    })
    expect(modelOf(model)).toEqual(model)
  })

  test('each field that does not fit falls back on its own, the rest is kept', () => {
    const model = modelOf({
      isOn: true,
      mode: 'paused',
      board: { epoch: 3, count: -1 },
      turn: {
        turnId: 't9',
        phase: 'asking',
        tools: 2,
        reason: 'timeout',
        current: 'Bash',
        recent: [{ tool: 'Read', target: 'a.ts' }, 5, { tool: 1, target: 'x' }],
        files: ['a.ts', 3, null],
        lockAt: -5,
      },
    })
    expect(model.isOn).toBe(true)
    expect(model.mode).toBe('input')
    expect(model.board).toEqual({ epoch: 3, count: 0 })
    expect(model.turn.turnId).toBe('t9')
    expect(model.turn.phase).toBe('idle')
    expect(model.turn.tools).toBe(2)
    expect(model.turn.reason).toBe('')
    expect(model.turn.current).toBeNull()
    expect(model.turn.recent).toEqual([{ tool: 'Read', target: 'a.ts' }])
    expect(model.turn.files).toEqual(['a.ts'])
    expect(model.turn.lockAt).toBe(0)
    expect(model.game).toEqual(EMPTY_GAME)
  })

  test('the initial model it falls back to cannot be changed by a caller', () => {
    const fallback = modelOf(undefined)
    expect(() => {
      fallback.game.cells[0] = 4
    }).toThrow()
    expect(() => {
      fallback.turn.recent.push({ tool: 'Bash', target: 'x' })
    }).toThrow()
    expect(modelOf(undefined).game.cells[0]).toBe(0)
    expect(modelOf(undefined).turn.recent).toEqual([])
  })

  test('a model written before newer fields existed reads as valid, with their defaults', () => {
    const model = modelOf({ isOn: true, game: GAME, mode: 'game' })
    expect(model).toEqual({
      ...INITIAL_MODEL,
      isOn: true,
      game: GAME,
      mode: 'game',
    })
  })

  test('only true counts as true', () => {
    const model = modelOf({ isOn: 'true', hasStrayKey: 1, isFaulted: {} })
    expect(model.isOn).toBe(false)
    expect(model.hasStrayKey).toBe(false)
    expect(model.isFaulted).toBe(false)
  })

  test('counts must be whole, not negative, and safe to count on from', () => {
    for (const epoch of [
      1.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3',
      2 ** 53,
    ]) {
      expect(modelOf({ board: { epoch, count: 0 } }).board.epoch).toBe(0)
    }
  })
})

describe('gameOf', () => {
  test('a kept game is read back whole', () => {
    expect(gameOf(GAME)).toEqual(GAME)
  })

  test('anything that is not a game reads as an empty one', () => {
    for (const raw of [undefined, null, 'game', 7, []]) {
      expect(gameOf(raw)).toEqual(EMPTY_GAME)
    }
  })

  test('a board that is not 16 tiles is dropped, and the best score kept', () => {
    const boards = [
      GAME.cells.slice(1),
      [...GAME.cells, 0],
      [3, ...GAME.cells.slice(1)],
      [-2, ...GAME.cells.slice(1)],
      ['2', ...GAME.cells.slice(1)],
      [1, ...GAME.cells.slice(1)],
      [2 ** 53 - 1, ...GAME.cells.slice(1)],
      new Array(16),
    ]
    for (const cells of boards) {
      expect(gameOf({ ...GAME, cells })).toEqual({ ...EMPTY_GAME, best: 3000 })
    }
  })

  test('an empty game it falls back to cannot be changed by a caller', () => {
    const fallback = gameOf(null)
    expect(() => {
      fallback.cells[0] = 2
    }).toThrow()
    expect(gameOf(null).cells[0]).toBe(0)
  })

  test('whether the game is over comes from the board, not from what was kept', () => {
    const dead = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2]
    expect(gameOf({ ...GAME, cells: dead, isOver: false }).isOver).toBe(true)
    expect(gameOf({ ...GAME, isOver: true }).isOver).toBe(false)
  })

  test('a board too large for any real game is dropped, so play stays within exact numbers', () => {
    const huge = [2 ** 52, 2 ** 52, ...new Array<number>(14).fill(0)]
    expect(gameOf({ ...GAME, cells: huge }).cells).toEqual(EMPTY_GAME.cells)
  })

  test('the best score is never below the game score', () => {
    expect(gameOf({ ...GAME, score: 5000, best: 100 }).best).toBe(5000)
  })

  test('a score, best or move count that is not a count reads as zero', () => {
    const game = gameOf({ ...GAME, score: -4, best: 'x', moves: 2.5 })
    expect(game.score).toBe(0)
    expect(game.best).toBe(0)
    expect(game.moves).toBe(0)
  })
})

describe('bestOf', () => {
  test('the higher score wins, whichever side it is on', () => {
    expect(bestOf(4000, 1200)).toBe(4000)
    expect(bestOf(1200, 4000)).toBe(4000)
  })

  test('a kept value that is not a score counts as none', () => {
    for (const kept of [undefined, null, 'x', -5, 1.5, {}]) {
      expect(bestOf(kept, 700)).toBe(700)
    }
  })
})

describe('afterToggle', () => {
  test('from off it turns on, with the keys at the prompt, and keeps the choice', () => {
    const before = modelWith({
      mode: 'game',
      hasStrayKey: true,
      board: { epoch: 2, count: 5 },
    })
    const step = afterToggle(before)
    expect(step.model.isOn).toBe(true)
    expect(step.model.isSeeded).toBe(true)
    expect(step.model.mode).toBe('input')
    expect(step.model.hasStrayKey).toBe(false)
    expect(step.model.board).toEqual({ epoch: 2, count: 5 })
    expect(step.effects).toEqual([{ kind: 'save', key: 'isOn', value: true }])
  })

  test('from on it turns off, gives the keys back and retires the board', () => {
    const before = modelWith({
      isOn: true,
      mode: 'game',
      hasStrayKey: true,
      board: { epoch: 2, count: 5 },
    })
    const step = afterToggle(before)
    expect(step.model.isOn).toBe(false)
    expect(step.model.mode).toBe('input')
    expect(step.model.hasStrayKey).toBe(false)
    expect(step.model.board).toEqual({ epoch: 3, count: 0 })
    expect(step.effects).toEqual([{ kind: 'save', key: 'isOn', value: false }])
  })

  test('the game is left as it was; switching off keeps the turn, switching on starts from an idle one', () => {
    const before = modelWith({
      isOn: true,
      game: GAME,
      turn: {
        ...INITIAL_MODEL.turn,
        turnId: 't5',
        phase: 'done',
        tools: 6,
        reason: 'answer',
        lockAt: 9000,
      },
    })
    const off = afterToggle(before).model
    const on = afterToggle(off).model
    expect(off.game).toEqual(GAME)
    expect(on.game).toEqual(GAME)
    expect(off.turn).toEqual(before.turn)
    expect(on.turn).toEqual(INITIAL_MODEL.turn)
  })
})

describe('afterRestore', () => {
  test('a session that already has its on/off keeps it, whatever the store says', () => {
    const on = modelWith({ isOn: true, isSeeded: true })
    const off = modelWith({ isOn: false, isSeeded: true })
    expect(afterRestore(on, { isOn: false, best: 0 }, first).model.isOn).toBe(
      true,
    )
    expect(afterRestore(off, { isOn: true, best: 0 }, first).model.isOn).toBe(
      false,
    )
  })

  test('a session with no on/off yet takes it from the store, on only if last switched on', () => {
    const fresh = modelWith({ isOn: true })
    const seeded = afterRestore(fresh, { isOn: true, best: 0 }, first).model
    expect(seeded.isOn).toBe(true)
    expect(seeded.isSeeded).toBe(true)
    for (const isOn of [false, undefined, 'true', 1]) {
      expect(afterRestore(fresh, { isOn, best: 0 }, first).model.isOn).toBe(
        false,
      )
    }
  })

  test('the best score is the higher of the kept one and the model one', () => {
    const model = modelWith({ game: { ...EMPTY_GAME, best: 500 } })
    expect(
      afterRestore(model, { isOn: false, best: 2048 }, first).model.game.best,
    ).toBe(2048)
    expect(
      afterRestore(model, { isOn: false, best: 100 }, first).model.game.best,
    ).toBe(500)
    expect(
      afterRestore(model, { isOn: false, best: 'x' }, first).model.game.best,
    ).toBe(500)
  })

  test('a reload gives the keys back to the prompt and retires the board, keeping the game and turn', () => {
    const before = modelWith({
      isOn: true,
      mode: 'game',
      hasStrayKey: true,
      board: { epoch: 7, count: 12 },
      game: GAME,
      turn: { ...INITIAL_MODEL.turn, turnId: 't4', phase: 'running' },
    })
    const after = afterRestore(before, { isOn: true, best: 0 }, first).model
    expect(after.mode).toBe('input')
    expect(after.hasStrayKey).toBe(false)
    expect(after.board).toEqual({ epoch: 8, count: 0 })
    expect(after.game).toEqual(GAME)
    expect(after.turn).toEqual(before.turn)
  })

  test('a fresh session deals two tiles and keeps the best score', () => {
    const after = afterRestore(
      INITIAL_MODEL,
      { isOn: false, best: 4096 },
      first,
    ).model.game
    expect(after.cells.filter(value => value !== 0)).toHaveLength(2)
    expect(after.score).toBe(0)
    expect(after.moves).toBe(0)
    expect(after.best).toBe(4096)
  })

  test('a session whose board was dropped or is empty gets a new game, seeded or not', () => {
    const dropped = modelOf({
      isSeeded: true,
      game: { ...GAME, cells: [3, ...GAME.cells.slice(1)] },
    })
    for (const before of [dropped, modelWith({ isSeeded: true })]) {
      const game = afterRestore(before, { isOn: true, best: 0 }, first).model
        .game
      expect(game.cells.filter(value => value !== 0)).toHaveLength(2)
    }
  })

  test('a reload does not deal: the game stays exactly as it was, game over included', () => {
    const over = {
      ...GAME,
      cells: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2],
      isOver: true,
    }
    for (const game of [GAME, over]) {
      const before = modelWith({ isSeeded: true, game })
      expect(
        afterRestore(before, { isOn: true, best: 0 }, first).model.game,
      ).toEqual(game)
    }
  })

  test('restoring writes nothing back', () => {
    expect(
      afterRestore(INITIAL_MODEL, { isOn: true, best: 9 }, first).effects,
    ).toEqual([])
  })
})

describe('isDealt', () => {
  test('a board has tiles once dealt, and play, a finished game or a reload never takes the last away', () => {
    expect(isDealt(EMPTY_GAME)).toBe(false)
    expect(isDealt(INITIAL_MODEL.game)).toBe(false)
    const dealt = afterRestore(INITIAL_MODEL, { isOn: true, best: 0 }, first)
      .model.game
    expect(isDealt(dealt)).toBe(true)
    const lone = { ...EMPTY_GAME, cells: [2, 2, ...EMPTY_GAME.cells.slice(2)] }
    expect(isDealt(played(lone, 'left', first))).toBe(true)
    const over = {
      ...GAME,
      cells: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2],
      isOver: true,
    }
    expect(isDealt(over)).toBe(true)
    const reloaded = afterRestore(
      modelWith({ isSeeded: true, game: GAME }),
      { isOn: true, best: 0 },
      first,
    ).model.game
    expect(isDealt(reloaded)).toBe(true)
  })
})

describe('toggleNoteOf', () => {
  test('says whether the band is on, and how to turn it off', () => {
    expect(toggleNoteOf(modelWith({ isOn: true }))).toBe(
      'Twenty Forty-Wait on. Run /fortywait again to turn it off.',
    )
    expect(toggleNoteOf(INITIAL_MODEL)).toBe('Twenty Forty-Wait off.')
  })
})

describe('afterGame', () => {
  test('takes the played game, and keeps the best score when it rises', () => {
    const before = modelWith({ game: { ...GAME, best: 3000 } })
    const step = afterGame(before, { ...GAME, score: 3500, best: 3500 })
    expect(step.model.game.best).toBe(3500)
    expect(step.effects).toEqual([{ kind: 'save', key: 'best', value: 3500 }])
  })

  test('never lowers the best score, and saves only a best not reached before', () => {
    const before = modelWith({ game: { ...GAME, best: 5000 } })
    const older = afterGame(before, { ...GAME, best: 3500 })
    expect(older.model.game.best).toBe(5000)
    expect(older.effects).toEqual([])
    const again = afterGame(older.model, { ...GAME, best: 5000 })
    expect(again.effects).toEqual([])
  })

  test('writes nothing when the best score did not rise', () => {
    const before = modelWith({ game: GAME })
    const step = afterGame(before, { ...GAME, score: 1300, moves: 141 })
    expect(step.model.game.moves).toBe(141)
    expect(step.effects).toEqual([])
  })
})

// The WCAG contrast ratio, worked out here on its own so the board's colours
// are checked against an independent sum.
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16)
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      const c = v / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0)
  }
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const VALUES = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 131072]
// The fade before the lock, at each of its 1 s steps and just before the end.
const FADES = [0, 0.2, 0.4, 0.6, 0.8, 0.99]
const LOCKED_GREY = '#4a4a4a'

function boardOfValues(values: number[]): Game {
  const cells = new Array<number>(16).fill(0)
  values.forEach((value, at) => {
    cells[at] = value
  })
  return { ...EMPTY_GAME, cells }
}

describe('boardOf', () => {
  test('draws the 16 cells row by row, with the scores and whether the game is over', () => {
    const board = boardOf({ ...GAME, isOver: true }, 0)
    expect(board.tiles).toHaveLength(16)
    expect(board.tiles.map(tile => tile.text)).toEqual(
      GAME.cells.map(value => (value === 0 ? '·' : String(value))),
    )
    expect(board.score).toBe(1200)
    expect(board.best).toBe(3000)
    expect(board.isOver).toBe(true)
  })

  // Rule change: the fade now runs all the way to the locked grey, which has
  // a test of its own; this holds for every step before the lock.
  test('every tile label reads clearly on its tile, at every fade before the lock (contrast at least 4.5:1)', () => {
    for (const fade of FADES) {
      const board = boardOf(boardOfValues(VALUES), fade)
      for (const tile of board.tiles.filter(t => !t.isEmpty)) {
        expect(contrast(tile.color, tile.background)).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    }
  })

  test('tiles carry their own colours, so they read the same on a dark or a light theme; empty cells take the theme colours', () => {
    const board = boardOf(boardOfValues(VALUES), 0)
    for (const tile of board.tiles) {
      if (tile.isEmpty) {
        expect(tile).toEqual({
          text: '·',
          background: '',
          color: '',
          isEmpty: true,
        })
      } else {
        expect(tile.background).toMatch(/^#[0-9a-f]{6}$/)
        expect(tile.color).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  // Rule change: tiles used to turn only part of the way toward a mid grey,
  // keeping their colours apart; now they dim step by step to one dark grey,
  // and the numbers tell values apart.
  test('each 1 s step of the fade brings every tile a fifth of the way to the locked grey', () => {
    const two = (fade: number) =>
      boardOf(boardOfValues([2]), fade).tiles[0]?.background
    expect([0, 0.2, 0.4, 0.6, 0.8, 1].map(two)).toEqual([
      '#eee4da',
      '#cdc5bd',
      '#aca6a0',
      '#8c8884',
      '#6b6967',
      LOCKED_GREY,
    ])
    // Every value takes the same straight steps from its own colour, and its
    // label is plain black or white until the lock.
    const toward = (hex: string, amount: number) => {
      const n = Number.parseInt(hex.slice(1), 16)
      return `#${[16, 8, 0]
        .map(shift => (n >> shift) & 255)
        .map(v => Math.round(v + (0x4a - v) * amount))
        .map(v => v.toString(16).padStart(2, '0'))
        .join('')}`
    }
    const own = boardOf(boardOfValues(VALUES), 0).tiles
    for (const fade of [0.2, 0.4, 0.6, 0.8, 0.99]) {
      const tiles = boardOf(boardOfValues(VALUES), fade).tiles
      expect(VALUES.map((value, at) => [value, tiles[at]?.background])).toEqual(
        VALUES.map((value, at) => [
          value,
          toward(own[at]?.background ?? '', fade),
        ]),
      )
      for (const tile of tiles.filter(t => !t.isEmpty)) {
        expect(['#000000', '#ffffff']).toContain(tile.color)
      }
    }
  })

  test('locked or idle, every tile is the same dark grey with a light grey number that still reads (at least 3:1)', () => {
    const locked = boardOf(boardOfValues(VALUES), 1).tiles
    for (const tile of locked.filter(t => !t.isEmpty)) {
      expect([tile.background, tile.color]).toEqual([LOCKED_GREY, '#9a9a9a'])
      expect(contrast(tile.color, tile.background)).toBeGreaterThanOrEqual(3)
    }
    expect(locked.slice(0, VALUES.length).map(tile => tile.text)).toEqual(
      VALUES.map(value => (value < 1_000_000 ? String(value) : '2^17')),
    )
  })

  test('a fade outside 0 to 1, or not a number, is held to the range', () => {
    const game = boardOfValues([2, 2048])
    expect(boardOf(game, -3)).toEqual(boardOf(game, 0))
    expect(boardOf(game, 5)).toEqual(boardOf(game, 1))
    expect(boardOf(game, Number.NaN)).toEqual(boardOf(game, 0))
  })

  test('no value is ever undefined, whatever the session state held', () => {
    const kept: unknown[] = [
      undefined,
      null,
      {},
      { game: null },
      { game: { cells: 'board', score: 'x' } },
      { game: { cells: new Array(16), score: -1, best: Number.NaN } },
      { game: { ...GAME, cells: [...GAME.cells.slice(0, 15), 3] } },
      { game: GAME },
    ]
    const defined = (value: unknown): boolean =>
      value !== undefined &&
      (typeof value !== 'number' || Number.isFinite(value)) &&
      (typeof value !== 'object' ||
        value === null ||
        Object.values(value).every(defined))
    for (const raw of kept) {
      for (const fade of [Number.NaN, -1, 0, 0.5, 1, 2]) {
        const board = boardOf(modelOf(raw).game, fade)
        expect(board.tiles).toHaveLength(16)
        expect(defined(board)).toBe(true)
      }
    }
  })
})

// A session with the band on, at time 0.
const ON = modelWith({ isOn: true, isSeeded: true, game: GAME })

// A reply long enough to be summarized: 200 characters or more.
const REPLY =
  'I fixed the parser so it accepts trailing commas in arrays and objects, ' +
  'and added a test for each case to the parser suite; all of them pass. ' +
  'Next, run the migration on staging and check that the import job ends.'

function started(model: Model = ON, at = 1000, turnId = 't1'): Model {
  return afterTurnStart(model, { turnId, at }).model
}

function ended(model: Model, change: Partial<TurnEnd> = {}): Model {
  return afterTurnEnd(model, {
    turnId: 't1',
    reason: 'answer',
    answer: REPLY,
    durationMs: 0,
    at: 31_000,
    ...change,
  }).model
}

// The handed-back turn a summary is for.
function keyOf(model: Model): { turnId: string; endedAt: number } {
  return { turnId: model.turn.turnId, endedAt: model.turn.endedAt }
}

describe('afterTurnStart', () => {
  test('a turn of the main loop runs live, from when it started', () => {
    const turn = started().turn
    expect(turn.phase).toBe('running')
    expect(turn.turnId).toBe('t1')
    expect(turn.startedAt).toBe(1000)
    expect(turn.tools).toBe(0)
    expect(turn.isShown).toBe(true)
  })

  test('a new turn, the person’s or an automated one, lifts the lock and keeps the keys at the prompt', () => {
    const locked = ended(started(), { at: 3000 })
    expect(isLocked(locked, 3000)).toBe(true)
    const next = started(locked, 9000, 't2')
    expect(isLocked(next, 9000)).toBe(false)
    expect(next.turn.phase).toBe('running')
    expect(next.mode).toBe('input')
  })

  test('the game stays on when a turn starts while playing', () => {
    expect(started({ ...ON, mode: 'game' }).mode).toBe('game')
  })

  test('subagent turns, and any turn while the band is off, change nothing', () => {
    expect(
      afterTurnStart(ON, { turnId: 's', at: 5, agentId: 'a1' }).model,
    ).toBe(ON)
    const off = { ...ON, isOn: false }
    expect(afterTurnStart(off, { turnId: 't', at: 5 }).model).toBe(off)
  })
})

describe('afterToolCall', () => {
  test('each call becomes the current one, the two before it stay in view, and the count goes up', () => {
    let model = started()
    for (const [tool, path] of [
      ['Read', '/repo/a.ts'],
      ['Grep', '/repo'],
      ['Edit', '/repo/src/app/main.ts'],
      ['Read', '/repo/b.ts'],
    ] as const) {
      model = afterToolCall(model, {
        tool,
        input: { file_path: path },
        at: 2000,
      }).model
    }
    expect(model.turn.tools).toBe(4)
    expect(model.turn.current).toEqual({ tool: 'Read', target: '/repo/b.ts' })
    expect(model.turn.recent.map(call => call.tool)).toEqual([
      'Grep',
      'Edit',
      'Read',
    ])
  })

  test('switched on mid-turn, the band starts following the turn at its next call', () => {
    const model = afterToolCall(afterToggle({ ...ON, isOn: false }).model, {
      tool: 'Bash',
      input: { description: 'Run the tests' },
      at: 7000,
    }).model
    expect(model.turn.phase).toBe('running')
    expect(model.turn.startedAt).toBe(7000)
    expect(model.turn.tools).toBe(1)
  })

  test('calls after the turn ended, or while off, change nothing', () => {
    const done = ended(started())
    expect(
      afterToolCall(done, { tool: 'Read', input: {}, at: 40_000 }).model,
    ).toBe(done)
    const off = { ...started(), isOn: false }
    expect(
      afterToolCall(off, { tool: 'Read', input: {}, at: 2000 }).model,
    ).toBe(off)
  })
})

describe('callOf', () => {
  test('Bash shows its description, never the command', () => {
    const call = callOf('Bash', {
      command: 'rm -rf build && make',
      description: 'Rebuild from scratch',
    })
    expect(call).toEqual({ tool: 'Bash', target: 'Rebuild from scratch' })
    const bare = callOf('Bash', { command: 'rm -rf build && make' })
    expect(bare.target).toBe('a shell command')
    expect(JSON.stringify(bare)).not.toContain('rm -rf')
  })

  test('file tools show the last two parts of the path', () => {
    expect(callOf('Edit', { file_path: '/repo/src/app/main.ts' }).target).toBe(
      '…/app/main.ts',
    )
    expect(callOf('Read', { file_path: 'a.ts' }).target).toBe('a.ts')
  })

  test('a target is one line, cut to fit the band', () => {
    const target = callOf('Grep', {
      pattern: `${'x'.repeat(100)}\nmore`,
    }).target
    expect(target).not.toContain('\n')
    expect(target.length).toBeLessThanOrEqual(72)
    expect(callOf('Read', null).target).toBe('')
  })
})

describe('afterToolDone', () => {
  const edit = (model: Model, path: string, isOk = true) =>
    afterToolDone(model, {
      turn: turnKeyOf(model),
      tool: 'Edit',
      input: { file_path: path },
      isOk,
    }).model

  test('a file counts as changed once an edit to it succeeds, and only once', () => {
    let model = started()
    model = edit(model, '/repo/a.ts')
    model = edit(model, '/repo/a.ts')
    model = edit(model, '/repo/b.ts', false)
    model = afterToolDone(model, {
      turn: turnKeyOf(model),
      tool: 'Read',
      input: { file_path: '/repo/c.ts' },
      isOk: true,
    }).model
    expect(model.turn.files).toEqual(['/repo/a.ts'])
  })

  test('nothing counts after the turn ended', () => {
    const done = ended(started())
    expect(edit(done, '/repo/a.ts')).toBe(done)
  })
})

describe('afterTurnEnd', () => {
  test('every way a turn stops hands it back: the board locks', () => {
    for (const reason of ['answer', 'aborted', 'refusal', 'error', 'timeout']) {
      const model = ended(started(), { reason })
      expect(isLocked(model, model.turn.lockAt)).toBe(true)
    }
  })

  test('a turn of 10 s or longer that ended on its own fades for 5 s, still playable, then locks', () => {
    const model = ended(started({ ...ON, mode: 'game' }, 1000), { at: 11_000 })
    expect(model.turn.lockAt).toBe(16_000)
    expect(model.mode).toBe('game')
    expect(isLocked(model, 15_999)).toBe(false)
    expect(isLocked(model, 16_000)).toBe(true)
  })

  test('a shorter turn locks at once, and so does an interrupted one, however long', () => {
    const playing = started({ ...ON, mode: 'game' }, 1000)
    const short = ended(playing, { at: 10_999 })
    expect(isLocked(short, 10_999)).toBe(true)
    expect(short.mode).toBe('input')
    const interrupted = ended(playing, {
      at: 60_000,
      reason: 'aborted',
    })
    expect(isLocked(interrupted, 60_000)).toBe(true)
    expect(interrupted.mode).toBe('input')
    expect(interrupted.board.epoch).toBe(playing.board.epoch + 1)
    const long = ended(started({ ...ON, mode: 'game' }, 1000), { at: 11_000 })
    expect(isLocked(long, 11_000)).toBe(false)
  })

  test('a long turn that ends in input mode locks at once, and is still summarized', () => {
    const end = {
      turnId: 't1',
      reason: 'answer',
      answer: REPLY,
      durationMs: 0,
      at: 60_000,
    }
    const step = afterTurnEnd(started(ON, 1000), end)
    expect(isLocked(step.model, 60_000)).toBe(true)
    expect(step.model.turn.lockAt).toBe(0)
    expect(step.effects.map(effect => effect.kind)).toEqual(['summarize'])
    const playing = afterTurnEnd(started({ ...ON, mode: 'game' }, 1000), end)
    expect(isLocked(playing.model, 60_000)).toBe(false)
    expect(playing.effects.map(effect => effect.kind)).toEqual(['summarize'])
  })

  test('at the lock the keys go to the prompt and the board is retired', () => {
    const playing = started({
      ...ON,
      mode: 'game',
      hasStrayKey: true,
      board: { epoch: 4, count: 9 },
    })
    const model = ended(playing, { at: 2000 })
    expect(model.mode).toBe('input')
    expect(model.hasStrayKey).toBe(false)
    expect(model.board).toEqual({ epoch: 5, count: 0 })
  })

  test('the card keeps how the turn ended, and whether there was an answer, never the answer itself', () => {
    const model = ended(started(), { answer: 'SECRET PLAN', reason: 'refusal' })
    expect(model.turn.reason).toBe('refusal')
    expect(model.turn.hasAnswer).toBe(true)
    expect(JSON.stringify(model)).not.toContain('SECRET PLAN')
    expect(ended(started(), { answer: '  ' }).turn.hasAnswer).toBe(false)
  })

  test('a turn whose start was not seen is timed from its duration', () => {
    const step = afterTurnEnd(ON, {
      turnId: 't1',
      reason: 'answer',
      answer: REPLY,
      durationMs: 30_000,
      at: 50_000,
    })
    expect(step.model.turn.startedAt).toBe(20_000)
    // Long by its duration: summarized. Idle, the game never had the keys,
    // so there is no move to finish and it locks at once.
    expect(step.effects.map(effect => effect.kind)).toEqual(['summarize'])
    expect(isLocked(step.model, 50_000)).toBe(true)
  })

  test('subagent turns, and turns while off, change nothing', () => {
    const running = started()
    expect(
      afterTurnEnd(running, {
        turnId: 's',
        reason: 'answer',
        answer: '',
        durationMs: 1,
        at: 9,
        agentId: 'a',
      }).model,
    ).toBe(running)
    const off = { ...running, isOn: false }
    expect(ended(off)).toBe(off)
  })
})

describe('afterTick, fadeOf, isTicking', () => {
  const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 })

  test('the board fades from 0 to 1 over the 5 s, and is 1 once locked', () => {
    expect(fadeOf(fading, 21_000)).toBe(0)
    expect(fadeOf(fading, 23_500)).toBe(0.5)
    expect(fadeOf(fading, 26_000)).toBe(1)
    expect(fadeOf(fading, 90_000)).toBe(1)
    expect(fadeOf(started(), 5000)).toBe(0)
  })

  test('when the lock comes due, a board that had the keys gives them up', () => {
    expect(afterTick(fading, 25_999).model).toBe(fading)
    const after = afterTick(fading, 26_000).model
    expect(after.mode).toBe('input')
    expect(after.board.epoch).toBe(fading.board.epoch + 1)
    const input = { ...fading, mode: 'input' as const }
    const inputAfter = afterTick(input, 26_000).model
    expect(inputAfter.mode).toBe('input')
    expect(inputAfter.board).toEqual(input.board)
    expect(afterTick(after, 27_000).model).toBe(after)
  })

  test('the clock runs while a turn runs and until a lock, and not otherwise', () => {
    expect(isTicking(started(), 5000)).toBe(true)
    expect(isTicking(fading, 25_000)).toBe(true)
    expect(isTicking(fading, 26_000)).toBe(false)
    expect(isTicking(ON, 0)).toBe(false)
    expect(isTicking({ ...started(), isOn: false }, 5000)).toBe(false)
  })

  test('once the game lets go of the keys the fade is over, even before the lock is committed', () => {
    const left = { ...fading, mode: 'input' as const }
    expect(left.turn.lockAt).toBe(26_000)
    expect(isLocked(left, 23_500)).toBe(true)
    expect(isTicking(left, 23_500)).toBe(false)
    expect(fadeOf(left, 23_500)).toBe(1)
    expect(isLocked(fading, 23_500)).toBe(false)
    expect(fadeOf(fading, 23_500)).toBe(0.5)
  })

  test('nothing locks or fades while the band is off', () => {
    const off = { ...fading, isOn: false }
    expect(isLocked(off, 99_000)).toBe(false)
    expect(fadeOf(off, 99_000)).toBe(0)
  })
})

describe('a lock across a reload or a switch-off', () => {
  test('a reload keeps the lock and the card', () => {
    const locked = ended(started(), { at: 3000 })
    const reloaded = afterRestore(
      modelOf(locked),
      { isOn: true, best: 0 },
      first,
    ).model
    expect(isLocked(reloaded, 3000)).toBe(true)
    expect(reloaded.turn).toEqual(locked.turn)
  })

  test('a reload keeps a running, fading or idle turn as it was, and an off band off', () => {
    const kept = { isOn: true, best: 0 }
    const running = started(ON, 1000)
    expect(afterRestore(running, kept, first).model.turn).toEqual(running.turn)
    const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 31_000 })
    const reloaded = afterRestore(fading, kept, first).model
    expect(reloaded.turn).toEqual(fading.turn)
    expect(reloaded.turn.lockAt).toBe(36_000)
    expect(afterRestore(ON, kept, first).model.turn).toEqual(ON.turn)
    const off = { ...ended(started(ON, 1000)), isOn: false }
    const restored = afterRestore(off, kept, first).model
    expect(restored.isOn).toBe(false)
    expect(bandOf(restored, 40_000, { columns: 100, maxRows: 48 }).kind).toBe(
      'none',
    )
  })

  test('switching off and on again starts from an idle turn, with no stale lock', () => {
    const locked = ended(started(), { at: 3000 })
    const again = afterToggle(afterToggle(locked).model).model
    expect(again.turn.phase).toBe('idle')
    expect(isLocked(again, 3000)).toBe(false)
  })
})

describe('afterDialog, afterFault, afterHandoff', () => {
  test('a permission prompt or question gives the keys to the dialog: input mode, board retired, nothing locked', () => {
    const playing = started({
      ...ON,
      mode: 'game',
      board: { epoch: 2, count: 3 },
    })
    const model = afterDialog(playing).model
    expect(model.mode).toBe('input')
    expect(model.board).toEqual({ epoch: 3, count: 0 })
    expect(model.turn).toEqual(playing.turn)
    expect(isLocked(model, 99_000)).toBe(false)
    const off = { ...playing, isOn: false }
    expect(afterDialog(off).model).toBe(off)
  })

  test('a fault stops the board drawing and gives the keys to the prompt; a reload or switching on clears it', () => {
    const faulted = afterFault({ ...ON, mode: 'game' }).model
    expect(faulted.isFaulted).toBe(true)
    expect(faulted.mode).toBe('input')
    expect(faulted.board.epoch).toBe(ON.board.epoch + 1)
    expect(
      afterRestore(faulted, { isOn: true, best: 0 }, first).model.isFaulted,
    ).toBe(false)
    const off = afterToggle(faulted).model
    expect(afterToggle(off).model.isFaulted).toBe(false)
  })

  test('a handoff the band asked for while drawing takes the keys back only from the board it saw', () => {
    const playing = {
      ...ON,
      mode: 'game' as const,
      board: { epoch: 6, count: 1 },
    }
    const handed = afterHandoff(playing, 6).model
    expect(handed.mode).toBe('input')
    expect(handed.board.epoch).toBe(7)
    expect(afterHandoff(playing, 5).model).toBe(playing)
    expect(afterHandoff(handed, 6).model).toBe(handed)
  })
})

describe('summaryOf and afterSummary', () => {
  test('a summary is two lines, what Claude did and the next step, and only when answered', () => {
    expect(
      summaryOf({
        isAnswered: true,
        text: '  Fixed the parser.\n\nRun the tests next. ',
      }),
    ).toEqual({ line: 'Fixed the parser.', next: 'Run the tests next.' })
    for (const result of [
      { isAnswered: false, text: 'Fixed it.\nRun it.' },
      { isAnswered: true, text: '   ' },
      { isAnswered: true, text: 'Fixed the parser and run the tests.' },
      { isAnswered: true, text: 'Fixed it.\nRun it.\nThen ship it.' },
      { isAnswered: true },
      null,
      'Fixed it.\nRun it.',
    ]) {
      expect(summaryOf(result)).toBeNull()
    }
  })

  test('a summary’s words are not judged: a next step that says nothing is needed is kept', () => {
    for (const next of [
      'No further action is needed.',
      'Nothing needed.',
      'You’re all set.',
    ]) {
      expect(
        summaryOf({ isAnswered: true, text: `Fixed the parser.\n${next}` }),
      ).toEqual({ line: 'Fixed the parser.', next })
    }
  })

  test('list marks and a "Next:" label are dropped', () => {
    expect(
      summaryOf({
        isAnswered: true,
        text: '1. Fixed the parser.\n2. Next step: run the tests.',
      }),
    ).toEqual({ line: 'Fixed the parser.', next: 'run the tests.' })
    expect(
      summaryOf({
        isAnswered: true,
        text: '- Fixed it.\n• Next: review the diff.',
      }),
    ).toEqual({ line: 'Fixed it.', next: 'review the diff.' })
    expect(
      summaryOf({
        isAnswered: true,
        text: 'Gist: fixed the parser.\nNext step: run the tests.',
      }),
    ).toEqual({ line: 'fixed the parser.', next: 'run the tests.' })
  })

  test('each line of up to 200 characters is kept whole; a longer one is refused', () => {
    const long = `${'a'.repeat(183)} Review the diff.`
    expect(long.length).toBe(200)
    expect(summaryOf({ isAnswered: true, text: `${long}\nRun it.` })).toEqual({
      line: long,
      next: 'Run it.',
    })
    expect(
      summaryOf({ isAnswered: true, text: `${long}a\nRun it.` }),
    ).toBeNull()
    expect(
      summaryOf({ isAnswered: true, text: `Fixed it.\n${long}a` }),
    ).toBeNull()
    // Counted in characters, so an emoji is one.
    const emoji = `${'😀'.repeat(183)} Review the diff.`
    expect(summaryOf({ isAnswered: true, text: `${emoji}\nRun it.` })).toEqual({
      line: emoji,
      next: 'Run it.',
    })
  })

  test('a summary lands only on the turn it was made for, while it is still the one handed back', () => {
    const answer = (text: string) => ({ isAnswered: true, text })
    const done = ended(started())
    const turn = afterSummary(
      done,
      keyOf(done),
      answer('Fixed it.\nReview the diff.'),
    ).model.turn
    expect([turn.summary, turn.next]).toEqual(['Fixed it.', 'Review the diff.'])
    expect(
      afterSummary(done, { ...keyOf(done), turnId: 't0' }, answer('Old.\nOld.'))
        .model,
    ).toBe(done)
    expect(
      afterSummary(done, { ...keyOf(done), endedAt: 1 }, answer('Old.\nOld.'))
        .model,
    ).toBe(done)
    const next = started(done, 40_000, 't2')
    expect(afterSummary(next, keyOf(done), answer('Late.\nLate.')).model).toBe(
      next,
    )
    const off = { ...done, isOn: false }
    expect(afterSummary(off, keyOf(done), answer('Off.\nOff.')).model).toBe(off)
  })
})

describe('placeholderOf and cardOf', () => {
  test('each way of stopping has its own line, ending in the next step', () => {
    const line = (reason: string, answer = 'x') =>
      placeholderOf(ended(started(), { reason, answer }).turn)
    expect(line('answer')).toBe('Claude finished — your turn: read the reply.')
    expect(line('aborted', '')).toBe('Interrupted — your turn.')
    expect(line('refusal')).toBe(
      'Claude declined — your turn: read why and rephrase.',
    )
    expect(line('error')).toBe(
      'Stopped on an error — your turn: check the transcript.',
    )
    expect(line('answer', '')).toBe('Stopped without a reply — your turn.')
    expect(line('mystery')).toBe('Stopped without a reply — your turn.')
  })

  test('the card shows how long, how many calls and files, and the summary over the placeholder', () => {
    let model = started(ON, 1000)
    model = afterToolCall(model, {
      tool: 'Edit',
      input: { file_path: '/repo/src/a.ts' },
      at: 2000,
    }).model
    model = afterToolDone(model, {
      turn: turnKeyOf(model),
      tool: 'Edit',
      input: { file_path: '/repo/src/a.ts' },
      isOk: true,
    }).model
    model = ended(model, { at: 126_000 })
    const card = cardOf(model.turn)
    expect(card.heading).toBe('✓ YOUR TURN')
    expect(card.stats).toBe('2m 05s · 1 tool call · 1 file changed')
    // Rule change: the summary is one paragraph, the placeholder whole.
    expect(card.text).toBe('Claude finished — your turn: read the reply.')
    expect(card.files).toBe('…/src/a.ts')
    const summarized = afterSummary(model, keyOf(model), {
      isAnswered: true,
      text: 'Edited a.ts.\ntest it.',
    }).model
    expect(cardOf(summarized.turn).text).toBe('Edited a.ts. Test it.')
  })
})

describe('statusOf', () => {
  test('a running turn shows the time, the count, the current call and the two before it', () => {
    let model = started(ON, 1000)
    for (const tool of ['Read', 'Grep', 'Bash']) {
      model = afterToolCall(model, {
        tool,
        input: { description: `${tool} it` },
        at: 2000,
      }).model
    }
    const status = statusOf(model, 66_000)
    expect(status.headline).toBe('● Claude is working · 1m 05s · 3 tool calls')
    expect(status.current).toEqual(['Bash  Bash it'])
    expect(status.before).toEqual(['Read  Read it', 'Grep  Grep it'])
  })

  test('before its first call a turn shows thinking', () => {
    expect(statusOf(started(), 2000).current).toEqual(['thinking…'])
  })

  test('while a long turn fades, the band says Claude is waiting and when the board locks', () => {
    const model = ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 })
    expect(statusOf(model, 22_200).headline).toContain('locks in 4s')
  })

  test('before any turn the band says so plainly, with no stale activity', () => {
    const status = statusOf(ON, 0)
    expect(status.headline).toBe("No activity yet · Claude's work shows here")
    expect(status.current).toEqual([])
    expect(status.before).toEqual([])
  })
})

describe('elapsedText', () => {
  test('reads seconds, then minutes and seconds', () => {
    expect(elapsedText(0)).toBe('0s')
    expect(elapsedText(59_999)).toBe('59s')
    expect(elapsedText(60_000)).toBe('1m 00s')
    expect(elapsedText(125_000)).toBe('2m 05s')
    expect(elapsedText(-5)).toBe('0s')
    expect(elapsedText(Number.NaN)).toBe('0s')
  })
})

describe('bandOf', () => {
  const wide = { columns: 100, maxRows: 48, isFullscreen: false }

  test('off, the band draws nothing', () => {
    expect(bandOf({ ...ON, isOn: false }, 0, wide)).toEqual({ kind: 'none' })
  })

  test('wide, the board sits beside the live view; narrow, they stack', () => {
    const row = bandOf(started(), 2000, wide)
    expect(row.kind === 'full' && row.direction).toBe('row')
    const column = bandOf(started(), 2000, { ...wide, columns: 63 })
    expect(column.kind === 'full' && column.direction).toBe('column')
  })

  test('locked, the card replaces the live view; the board shows fully faded', () => {
    const band = bandOf(ended(started(), { at: 3000 }), 3000, wide)
    expect(band.kind).toBe('full')
    if (band.kind !== 'full') return
    expect(band.status).toBeNull()
    expect(band.card?.heading).toBe('✓ YOUR TURN')
    expect(band.board.tiles.find(tile => !tile.isEmpty)?.background).not.toBe(
      boardOf(GAME, 0).tiles.find(tile => !tile.isEmpty)?.background,
    )
  })

  test('the band fits a third of the main screen, or the whole fullscreen slot; otherwise it shrinks to one line', () => {
    const kind = (columns: number, maxRows: number, isFullscreen?: boolean) =>
      bandOf(started(), 2000, { columns, maxRows, isFullscreen }).kind
    // Wide: an 8-row band.
    expect([7, 8, 12, 24, 48].map(rows => kind(100, rows, true))).toEqual([
      'minimized',
      'full',
      'full',
      'full',
      'full',
    ])
    expect([8, 12, 14, 24, 48].map(rows => kind(100, rows, false))).toEqual([
      'minimized',
      'minimized',
      'minimized',
      'full',
      'full',
    ])
    expect(kind(100, 24)).toBe('full')
    expect(kind(100, 23)).toBe('minimized')
    // Narrow: a 13-row band.
    expect([8, 12, 13, 24, 48].map(rows => kind(60, rows, true))).toEqual([
      'minimized',
      'minimized',
      'full',
      'full',
      'full',
    ])
    expect(kind(60, 39)).toBe('full')
    expect(kind(60, 38)).toBe('minimized')
  })

  test('shrunk to one line, the band still says what is going on and how to bring it back', () => {
    const tight = { columns: 100, maxRows: 7, isFullscreen: true }
    const running = bandOf(started(), 2000, tight)
    expect(running).toMatchObject({
      kind: 'minimized',
      tone: 'working',
      head: '● Claude is working · 1s · 0 tool calls',
      tail: ' · more rows show the game',
    })
    const locked = bandOf(ended(started(), { at: 3000 }), 3000, tight)
    expect(locked).toMatchObject({
      kind: 'minimized',
      tone: 'card',
      head: '✓ YOUR TURN',
      // Rule change: the hint comes right after the state, then the card's
      // paragraph, so the band cuts the paragraph rather than the hint.
      tail: ' · more rows show the game · Claude finished — your turn: read the reply.',
    })
    // With a summary, the line carries the whole paragraph too.
    const done = ended(started(), { at: 3000 })
    const summarized = afterSummary(done, keyOf(done), {
      isAnswered: true,
      text: 'Fixed the parser.\nRun the tests.',
    }).model
    expect(bandOf(summarized, 3000, tight)).toMatchObject({
      kind: 'minimized',
      tail: ' · more rows show the game · Fixed the parser. Run the tests.',
    })
  })

  test('at 80 columns the card’s one line shows the whole hint, and the band cuts only the paragraph', () => {
    const done = ended(started(), { at: 3000 })
    const line = (turn: Model) => {
      const view = bandOf(turn, 3000, {
        columns: 80,
        maxRows: 7,
        isFullscreen: true,
      })
      return view.kind === 'minimized' ? `${view.head}${view.tail}` : ''
    }
    const summarized = afterSummary(done, keyOf(done), {
      isAnswered: true,
      text: `${'word '.repeat(30).trim()}\nRun the tests.`,
    }).model
    for (const model of [done, summarized]) {
      expect(line(model).slice(0, 80)).toContain(' · more rows show the game')
    }
  })

  test('the paragraph follows the hint only with a column to spare, so the cut’s ellipsis never lands on the hint', () => {
    const done = ended(started(), { at: 3000 })
    const tail = (columns: number) => {
      const view = bandOf(done, 3000, {
        columns,
        maxRows: 7,
        isFullscreen: true,
      })
      return view.kind === 'minimized' ? view.tail : ''
    }
    // The heading and the hint take exactly 37 columns.
    expect(tail(36)).toBe(' · more rows show the game')
    expect(tail(37)).toBe(' · more rows show the game')
    expect(tail(38)).toBe(
      ' · more rows show the game · Claude finished — your turn: read the reply.',
    )
  })
})

describe('turn tracking holds up under awkward event orders', () => {
  test('a turn followed from mid-way is timed by its real length, not by when the band saw it', () => {
    let model = afterToggle({ ...ON, isOn: false }).model
    model = afterToolCall(model, { tool: 'Read', input: {}, at: 58_000 }).model
    model = ended(
      { ...model, mode: 'game' },
      { at: 60_000, durationMs: 60_000 },
    )
    expect(model.turn.endedAt - model.turn.startedAt).toBe(60_000)
    expect(isLocked(model, 60_000)).toBe(false)
    expect(isLocked(model, 65_000)).toBe(true)
  })

  test('a subagent working after the main turn ended does not start a turn the band would never end', () => {
    const model = afterToolCall(afterToggle({ ...ON, isOn: false }).model, {
      tool: 'Bash',
      input: {},
      at: 5000,
      agentId: 'a1',
    }).model
    expect(model.turn.phase).toBe('idle')
  })

  test('a turn whose start was missed, ending after a fade’s lock came due, locks at once', () => {
    // The game was on when t1 ended at 21 s; its lock came due at 26 s, but
    // nothing committed it before t2, whose start went unseen, ended.
    const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 })
    const next = ended(fading, { turnId: 't2', at: 41_000, durationMs: 10_000 })
    expect(next.turn.turnId).toBe('t2')
    expect(next.mode).toBe('input')
    expect(next.board.epoch).toBe(fading.board.epoch + 1)
    expect(isLocked(next, 41_000)).toBe(true)
  })

  test('a finished game locks at once when the turn ends, and the move that finishes it ends the fade', () => {
    const over = { ...GAME, isOver: true }
    const finished = ended(started({ ...ON, mode: 'game', game: over }, 1000), {
      at: 21_000,
    })
    expect(isLocked(finished, 21_000)).toBe(true)
    expect(finished.mode).toBe('input')
    expect(finished.turn.lockAt).toBe(0)
    const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 })
    expect(isLocked(fading, 22_000)).toBe(false)
    expect(isLocked({ ...fading, game: over }, 22_000)).toBe(true)
  })

  test('a late end of an older turn does not end the turn now running', () => {
    const second = started(started(ON, 1000, 't1'), 2000, 't2')
    expect(ended(second, { turnId: 't1', at: 3000 })).toBe(second)
  })

  test('a repeated start of the running turn keeps its work', () => {
    let model = started(ON, 1000, 't1')
    model = afterToolCall(model, { tool: 'Read', input: {}, at: 2000 }).model
    expect(started(model, 3000, 't1')).toBe(model)
  })

  test('a new turn first hands back a lock that came due before it started', () => {
    const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 11_000 })
    const next = started(fading, 16_001, 't2')
    expect(next.mode).toBe('input')
    expect(next.board.epoch).toBe(fading.board.epoch + 1)
  })

  test('a lock that took effect holds even if the clock steps back', () => {
    const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 11_000 })
    const locked = afterTick(fading, 16_000).model
    expect(isLocked(locked, 15_000)).toBe(true)
    expect(isTicking(locked, 15_000)).toBe(false)
    const quick = ended(started(), { at: 3000 })
    expect(isLocked(quick, 2000)).toBe(true)
  })

  test('a clock that is not a number never shows up as NaN', () => {
    const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 })
    expect(Number.isFinite(fadeOf(fading, Number.NaN))).toBe(true)
    expect(JSON.stringify(statusOf(fading, Number.NaN))).not.toContain('NaN')
    expect(
      JSON.stringify(bandOf(fading, Number.NaN, { columns: 100, maxRows: 48 })),
    ).not.toContain('NaN')
  })

  test('the live view shows at most the two calls before the current one, whatever was kept', () => {
    const recent = ['A', 'B', 'C', 'D', 'E'].map(tool => ({ tool, target: '' }))
    const model = modelOf({ ...started(), turn: { ...started().turn, recent } })
    expect(statusOf(model, 2000).before).toEqual(['C', 'D'])
  })
})

describe('edits and the card, strictly', () => {
  test('every edit tool counts its file once the edit succeeds', () => {
    let model = started()
    for (const [tool, input] of [
      ['Write', { file_path: '/repo/w.ts' }],
      ['MultiEdit', { file_path: '/repo/m.ts' }],
      ['NotebookEdit', { notebook_path: '/repo/n.ipynb' }],
    ] as const) {
      model = afterToolDone(model, {
        turn: turnKeyOf(model),
        tool,
        input,
        isOk: true,
      }).model
    }
    expect(model.turn.files).toEqual([
      '/repo/w.ts',
      '/repo/m.ts',
      '/repo/n.ipynb',
    ])
  })

  test('each way of stopping locks at its own deadline: at once if short or interrupted, after the fade if long', () => {
    for (const reason of ['answer', 'refusal', 'error']) {
      const short = ended(started({ ...ON, mode: 'game' }, 1000), {
        reason,
        at: 5000,
      })
      expect(isLocked(short, 5000)).toBe(true)
      const long = ended(started({ ...ON, mode: 'game' }, 1000), {
        reason,
        at: 11_000,
      })
      expect(isLocked(long, 15_999)).toBe(false)
      expect(isLocked(long, 16_000)).toBe(true)
    }
  })

  test('a summary that is not a usable one never reaches the card', () => {
    const done = ended(started())
    for (const result of [
      { isAnswered: true, text: '   ' },
      { isAnswered: true, text: 'Fixed it.\nTest it.\nShip it.' },
      { isAnswered: false, text: 'Fixed it.\nTest it.' },
      'Fixed it.\nTest it.',
    ]) {
      expect(afterSummary(done, keyOf(done), result).model).toBe(done)
    }
  })

  test('a summary of the running turn is not taken: only a turn handed back gets one', () => {
    const running = started()
    expect(
      afterSummary(running, keyOf(running), {
        isAnswered: true,
        text: 'Too early.\nRun it.',
      }).model,
    ).toBe(running)
  })

  test('a summary kept in the session is checked again when read back', () => {
    const done = ended(started())
    const kept = modelOf({
      ...done,
      turn: { ...done.turn, summary: 'Fixed it.', next: 'a'.repeat(201) },
    })
    expect(cardOf(kept.turn).text).toBe(
      'Claude finished — your turn: read the reply.',
    )
  })

  test('a summary line too long for the card is refused rather than cut, so its next step is never lost', () => {
    expect(
      summaryOf({
        isAnswered: true,
        text: `${'word '.repeat(60)}Review the diff.\nRun it.`,
      }),
    ).toBeNull()
  })

  test('file names with line breaks stay on one line of the card', () => {
    let model = started()
    model = afterToolDone(model, {
      turn: turnKeyOf(model),
      tool: 'Write',
      input: { file_path: '/repo/a\nb.ts' },
      isOk: true,
    }).model
    expect(cardOf(ended(model).turn).files).not.toContain('\n')
  })
})

describe('the band, strictly', () => {
  test('after a fault the band draws nothing', () => {
    const faulted = afterFault(started({ ...ON, mode: 'game' })).model
    expect(bandOf(faulted, 2000, { columns: 100, maxRows: 48 })).toEqual({
      kind: 'none',
    })
  })

  test('the board sits beside the live view from exactly 64 columns', () => {
    const at = (columns: number) => {
      const band = bandOf(started(), 2000, {
        columns,
        maxRows: 48,
        isFullscreen: true,
      })
      return band.kind === 'full' ? band.direction : band.kind
    }
    expect(at(64)).toBe('row')
    expect(at(63)).toBe('column')
  })

  test('locked, the board is drawn fully faded', () => {
    const locked = ended(started(), { at: 3000 })
    const band = bandOf(locked, 3000, { columns: 100, maxRows: 48 })
    expect(band.kind === 'full' && band.board).toEqual(boardOf(locked.game, 1))
  })
})

describe('the card: one paragraph', () => {
  // Rule change: a placeholder used to split into what happened and an arrowed
  // next step on a row of its own; now it shows whole, as one paragraph.
  test('each placeholder shows whole, as one paragraph', () => {
    const card = (reason: string, answer = 'x') =>
      cardOf(ended(started(), { reason, answer }).turn)
    expect(
      [
        card('answer'),
        card('aborted', ''),
        card('refusal'),
        card('error'),
        card('answer', ''),
      ].map(each => [each.text, each.rows]),
    ).toEqual(
      [
        'Claude finished — your turn: read the reply.',
        'Interrupted — your turn.',
        'Claude declined — your turn: read why and rephrase.',
        'Stopped on an error — your turn: check the transcript.',
        'Stopped without a reply — your turn.',
      ].map(text => [text, [text]]),
    )
  })

  test('the gist and the next step run together as two sentences, with no arrow', () => {
    const done = ended(started(ON, 1000), { at: 31_000 })
    const summarized = (text: string) =>
      afterSummary(done, keyOf(done), { isAnswered: true, text }).model.turn
    const card = cardOf(summarized('Fixed the parser.\nRun the tests.'))
    expect(card.text).toBe('Fixed the parser. Run the tests.')
    expect(card.rows.join(' ')).toBe(card.text)
    expect(card.rows.some(row => row.startsWith('→'))).toBe(false)
    // Each part becomes a sentence: a capital first, a full stop last unless
    // it already ends in one, a mark or an ellipsis.
    expect(paragraphOf(summarized('fixed the parser\nrun the tests'))).toBe(
      'Fixed the parser. Run the tests.',
    )
    expect(paragraphOf(summarized('Found two bugs!\nShould I fix both?'))).toBe(
      'Found two bugs! Should I fix both?',
    )
    expect(
      paragraphOf(
        summarized('Stopped halfway…\nRead the log (it ends "done.")'),
      ),
    ).toBe('Stopped halfway… Read the log (it ends "done.")')
    // The first letter is found after an opening quote or bracket, whole
    // even past the basic plane; any closing mark may follow the stop.
    expect(paragraphOf(summarized('"fixed it," it says\nreview it'))).toBe(
      '"Fixed it," it says. Review it.',
    )
    expect(paragraphOf(summarized('échec du test\n𐐨𐐯𐐻 it run'))).toBe(
      'Échec du test. 𐐀𐐯𐐻 it run.',
    )
    expect(paragraphOf(summarized('Found {done.}\nSaid «done.»'))).toBe(
      'Found {done.} Said «done.»',
    )
    expect(paragraphOf(summarized('2 tests failed\nfix them'))).toBe(
      '2 tests failed. Fix them.',
    )
    // An arrow Haiku puts before the next step is dropped, as a list mark.
    expect(paragraphOf(summarized('Fixed it.\n→ Run the tests.'))).toBe(
      'Fixed it. Run the tests.',
    )
    expect(paragraphOf(summarized('Fixed it.\n-> Run the tests.'))).toBe(
      'Fixed it. Run the tests.',
    )
  })

  test('a repeated end of the turn already handed back changes nothing, so a lock never restarts its fade', () => {
    const locked = afterTick(
      ended(started({ ...ON, mode: 'game' }, 1000), { at: 11_000 }),
      16_000,
    ).model
    expect(ended(locked, { at: 20_000, durationMs: 30_000 })).toBe(locked)
  })
})

describe('what the shell asks of the model', () => {
  test('a tool call succeeded when it was neither refused nor an error', () => {
    expect(toolSucceeded({ result: 'ok' })).toBe(true)
    expect(toolSucceeded({ result: 'x', isError: true })).toBe(false)
    expect(toolSucceeded({ deny: 'no' })).toBe(false)
    expect(toolSucceeded(undefined)).toBe(false)
  })

  test('drawing asks to hand back the board only when the game held the keys and no board is drawn', () => {
    const playing = {
      ...started(),
      mode: 'game' as const,
      board: { epoch: 4, count: 0 },
    }
    const room = { columns: 100, maxRows: 48 }
    expect(handoffOf(playing, bandOf(playing, 2000, room))).toBeNull()
    expect(
      handoffOf(playing, bandOf(playing, 2000, { ...room, maxRows: 8 })),
    ).toBe(4)
    expect(
      handoffOf(playing, bandOf(playing, 2000, { ...room, hasSurvey: true })),
    ).toBe(4)
    expect(
      handoffOf(started(), bandOf(started(), 2000, { ...room, maxRows: 8 })),
    ).toBeNull()
  })

  test('a survey takes the band: nothing of the mod is drawn', () => {
    expect(
      bandOf(started(), 2000, { columns: 100, maxRows: 48, hasSurvey: true }),
    ).toEqual({ kind: 'none' })
  })

  test('the live view says how to draw its first row: working, waiting or idle', () => {
    expect(statusOf(started(), 2000).tone).toBe('working')
    expect(
      statusOf(
        ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 }),
        22_000,
      ).tone,
    ).toBe('waiting')
    expect(statusOf(ON, 0).tone).toBe('idle')
  })
})

describe('what the shell asks of the model: faults, fences and time', () => {
  test('a faulted band needs no clock', () => {
    const faulted = afterFault(started()).model
    expect(isTicking(faulted, 2000)).toBe(false)
  })

  test('a tool call keeps the key of the turn it ran in, and only that turn counts its edit', () => {
    const first = started(ON, 1000, 't1')
    const key = turnKeyOf(first)
    expect(key).toEqual({ turnId: 't1', startedAt: 1000 })
    const second = started(ended(first, { at: 2000 }), 3000, 't2')
    const late = afterToolDone(second, {
      tool: 'Write',
      input: { file_path: '/repo/late.ts' },
      isOk: true,
      turn: key,
    }).model
    expect(late).toBe(second)
    expect(turnKeyOf(ON)).toBeNull()
    expect(turnKeyOf({ ...first, isOn: false })).toBeNull()
  })

  test('time is kept only while the band is on', () => {
    expect(isTimeShown(ON)).toBe(true)
    expect(isTimeShown({ ...ON, isOn: false })).toBe(false)
  })
})

describe('what the shell asks of the model: a stopped band and a turn’s key', () => {
  test('a faulted band keeps no time', () => {
    expect(isTimeShown(afterFault(ON).model)).toBe(false)
  })

  test('a tool call’s turn key tells apart turns with the same id that started at different times', () => {
    const adopted = afterToolCall(afterToggle({ ...ON, isOn: false }).model, {
      tool: 'Read',
      input: {},
      at: 5000,
    }).model
    const key = turnKeyOf(adopted)
    expect(key).toEqual({ turnId: '', startedAt: 5000 })
    const later = { ...adopted, turn: { ...adopted.turn, startedAt: 9000 } }
    const done = afterToolDone(later, {
      tool: 'Write',
      input: { file_path: '/repo/a.ts' },
      isOk: true,
      turn: key,
    }).model
    expect(done).toBe(later)
  })
})

// Board input: a post from the board drawn now, numbered on from what the
// model acknowledged.
function key(name: string, mods: Partial<BoardInput> = {}): BoardInput {
  return {
    kind: 'key',
    key: name,
    ctrl: false,
    shift: false,
    meta: false,
    ...mods,
  } as BoardInput
}

const CLICK: BoardInput = { kind: 'click' }

function posted(
  model: Model,
  inputs: (BoardInput | null)[],
  at = 5000,
  element = boardKeyOf(model),
): ReturnType<typeof afterBoardPost> {
  const post: BoardPost = { count: model.board.count + inputs.length, inputs }
  return afterBoardPost(model, element, post, at, first)
}

// The band on, a turn running, the game holding the keys under board 3.
const PLAYING = modelWith({
  ...started(),
  mode: 'game',
  board: { epoch: 3, count: 5 },
})

describe('the board’s key and its posts', () => {
  test('the board is keyed by its epoch', () => {
    expect(boardKeyOf(PLAYING)).toBe('board-3')
    expect(boardKeyOf(afterDialog(PLAYING).model)).toBe('board-4')
  })

  test('a post reads back with its count, its clicks and its keys', () => {
    expect(
      boardPostOf({
        count: 9,
        inputs: [
          { kind: 'click' },
          { kind: 'key', key: 'left' },
          { kind: 'key', key: 'tab', shift: true, meta: false },
        ],
      }),
    ).toEqual({
      count: 9,
      inputs: [
        { kind: 'click' },
        { kind: 'key', key: 'left', ctrl: false, shift: false, meta: false },
        { kind: 'key', key: 'tab', ctrl: false, shift: true, meta: false },
      ],
    })
  })

  test('a key whose modifiers are not plain flags is no input, never a bare key', () => {
    expect(
      boardPostOf({
        count: 3,
        inputs: [
          { kind: 'key', key: 'left', ctrl: 'yes' },
          { kind: 'key', key: 'tab', shift: 1 },
          { kind: 'key', key: 'up', meta: null },
        ],
      }),
    ).toEqual({ count: 3, inputs: [null, null, null] })
  })

  test('an entry that is no input keeps its place, as null', () => {
    expect(
      boardPostOf({
        count: 3,
        inputs: [{ kind: 'scroll' }, 'up', { kind: 'key' }],
      }),
    ).toEqual({ count: 3, inputs: [null, null, null] })
  })

  test('data that is no post reads as null', () => {
    const many = new Array(BOARD_BACKLOG + 1).fill({ kind: 'click' })
    for (const data of [
      undefined,
      'click',
      { count: 1 },
      { count: 1, inputs: 'click' },
      { count: 1.5, inputs: [] },
      { count: -1, inputs: [] },
      { count: '2', inputs: [] },
      { count: 1, inputs: [{ kind: 'click' }, { kind: 'click' }] },
      { count: Number.MAX_SAFE_INTEGER + 2, inputs: [] },
      { count: many.length, inputs: many },
    ]) {
      expect(boardPostOf(data)).toBeNull()
    }
  })
})

describe('into the game: a click on the board', () => {
  const input = { ...PLAYING, mode: 'input' as const, hasStrayKey: true }

  test('a click enters the game, and the count is acknowledged', () => {
    const after = posted(input, [CLICK]).model
    expect(after.mode).toBe('game')
    expect(after.hasStrayKey).toBe(false)
    expect(after.board).toEqual({ epoch: 3, count: 6 })
    expect(after.game).toBe(input.game)
  })

  test('a click and arrows in one post enter and play, in order', () => {
    const after = posted(input, [CLICK, key('left')]).model
    expect(after.mode).toBe('game')
    expect(after.game.moves).toBe(GAME.moves + 1)
  })

  test('a click while the game has the keys changes nothing but the count', () => {
    const after = posted(PLAYING, [CLICK]).model
    expect({ ...after, board: PLAYING.board }).toEqual(PLAYING)
    expect(after.board.count).toBe(6)
  })

  test('a click on a finished game deals a new one with the best score kept, from either mode', () => {
    const over = { ...GAME, isOver: true, best: 5000 }
    for (const mode of ['input', 'game'] as const) {
      const step = posted({ ...PLAYING, mode, game: over }, [CLICK])
      expect(step.model.mode).toBe('game')
      expect(step.model.game.isOver).toBe(false)
      expect(step.model.game.score).toBe(0)
      expect(step.model.game.best).toBe(5000)
      expect(step.model.game.cells.filter(value => value > 0)).toHaveLength(2)
      expect(step.effects).toEqual([])
    }
  })
})

describe('a locked board stays locked', () => {
  // A long turn that ended with the game on: it fades until 26 s.
  const fading = ended(
    started({ ...ON, mode: 'game', board: { epoch: 3, count: 0 } }, 1000),
    {
      at: 21_000,
    },
  )
  // Locked at 26 s, which retired the board that had the keys.
  const locked = afterTick(fading, 26_000).model

  test('a click on a locked board retires it and hands the keys straight back', () => {
    const after = posted(locked, [CLICK], 27_000).model
    expect(after.mode).toBe('input')
    expect(after.board).toEqual({ epoch: 5, count: 0 })
    expect(isLocked(after, 27_000)).toBe(true)
  })

  test('a click on a locked, finished game deals nothing', () => {
    const over = { ...locked, game: { ...GAME, isOver: true } }
    expect(posted(over, [CLICK], 27_000).model.game).toBe(over.game)
  })

  test('arrows play while the turn’s end fades, and not once the lock is due', () => {
    expect(posted(fading, [key('left')], 25_999).model.game.moves).toBe(
      GAME.moves + 1,
    )
    const late = posted(fading, [key('left')], 26_000).model
    expect(late.game).toBe(fading.game)
    expect(late.mode).toBe('input')
    expect(late.board).toEqual({ epoch: 4, count: 0 })
  })

  test('a click while the fade plays keeps the game on, and a click from input mode doesn’t enter it', () => {
    const kept = posted(fading, [CLICK], 23_000).model
    expect(kept.mode).toBe('game')
    expect(isLocked(kept, 23_000)).toBe(false)
    const left = { ...fading, mode: 'input' as const }
    const after = posted(left, [CLICK, key('left')], 23_000).model
    expect(after.mode).toBe('input')
    expect(after.game).toBe(fading.game)
    expect(after.board).toEqual({ epoch: 4, count: 0 })
    expect(isLocked(after, 23_000)).toBe(true)
  })
})

describe('out of the game: Tab on the board', () => {
  test('Tab hands the keys to the prompt at once and retires the board', () => {
    const after = posted({ ...PLAYING, hasStrayKey: true }, [key('tab')]).model
    expect(after.mode).toBe('input')
    expect(after.hasStrayKey).toBe(false)
    expect(after.board).toEqual({ epoch: 4, count: 0 })
    expect(after.game).toBe(PLAYING.game)
  })

  test('what came after Tab in the same post is dropped with the retired board', () => {
    const after = posted(PLAYING, [key('tab'), CLICK, key('left')]).model
    expect(after.mode).toBe('input')
    expect(after.game).toBe(PLAYING.game)
    expect(after.board).toEqual({ epoch: 4, count: 0 })
  })

  test('a key while the model gives the prompt the keys hands them back', () => {
    const input = { ...PLAYING, mode: 'input' as const }
    const after = posted(input, [key('left')]).model
    expect(after.mode).toBe('input')
    expect(after.board.epoch).toBe(4)
    expect(after.game).toBe(input.game)
  })
})

describe('in the game: arrows play, every other key only shows how to leave', () => {
  test('each arrow plays its own move', () => {
    const board = {
      ...PLAYING,
      game: {
        ...EMPTY_GAME,
        cells: [2, 0, 0, 4, 0, 0, 0, 0, 0, 8, 0, 0, 16, 0, 0, 0],
      },
    }
    const results = (['left', 'right', 'up', 'down'] as const).map(name => {
      const after = posted(board, [key(name)]).model
      expect(after.game.cells).toEqual(played(board.game, name, first).cells)
      expect(after.mode).toBe('game')
      return after.game.cells.join()
    })
    expect(new Set(results).size).toBe(4)
  })

  test('Claude Code’s shortcuts, letters and dictation change only the hint', () => {
    for (const input of [
      key('tab', { shift: true }),
      key('o', { ctrl: true }),
      key('r', { ctrl: true }),
      key('pageup'),
      key('pagedown'),
      key('a'),
      key('7'),
      key('return'),
      key(' '),
      key('please run the tests'),
      key('left', { shift: true }),
      key('up', { ctrl: true }),
      key('down', { meta: true }),
    ]) {
      const after = posted(PLAYING, [input]).model
      expect({ ...after, hasStrayKey: false, board: PLAYING.board }).toEqual(
        PLAYING,
      )
      expect(after.hasStrayKey).toBe(true)
      expect(after.board.count).toBe(6)
    }
  })

  test('the next arrow clears the hint, even one that moves nothing', () => {
    const stray = { ...PLAYING, hasStrayKey: true }
    expect(posted(stray, [key('left')]).model.hasStrayKey).toBe(false)
    const stuck = {
      ...stray,
      game: { ...GAME, cells: [2, ...new Array(15).fill(0)] },
    }
    const after = posted(stuck, [key('left')]).model
    expect(after.hasStrayKey).toBe(false)
    expect(after.game).toBe(stuck.game)
  })

  test('a best that rises over several moves is kept once, at its height', () => {
    const rising = {
      ...PLAYING,
      game: {
        ...EMPTY_GAME,
        cells: [2, 2, 2, 2, ...new Array(12).fill(0)],
        score: 100,
        best: 100,
      },
    }
    const step = posted(rising, [key('left'), key('left')])
    expect(step.model.game.score).toBe(116)
    expect(step.effects).toEqual([{ kind: 'save', key: 'best', value: 116 }])
  })
})

describe('only the board drawn now is heard, and each input once', () => {
  test('a post from a retired board changes nothing', () => {
    expect(posted(PLAYING, [key('left')], 5000, 'board-2').model).toBe(PLAYING)
    expect(posted(PLAYING, [key('left')], 5000, 'other').model).toBe(PLAYING)
  })

  test('a backlog sent again applies once', () => {
    const once = posted(PLAYING, [key('left'), key('up')]).model
    const again = afterBoardPost(
      once,
      'board-3',
      { count: 8, inputs: [key('left'), key('up'), key('tab')] },
      5000,
      first,
    ).model
    expect(again.game).toBe(once.game)
    expect(again.mode).toBe('input')
  })

  test('a post with nothing new changes nothing at all', () => {
    const post = { count: 5, inputs: [key('left'), key('up')] }
    expect(afterBoardPost(PLAYING, 'board-3', post, 5000, first).model).toBe(
      PLAYING,
    )
  })

  test('an entry that is no input is counted and changes nothing', () => {
    const after = posted(PLAYING, [null, null]).model
    expect({ ...after, board: PLAYING.board }).toEqual(PLAYING)
    expect(after.board.count).toBe(7)
  })

  test('while off or after a fault, the board is not heard', () => {
    const off = { ...PLAYING, mode: 'input' as const, isOn: false }
    expect(posted(off, [CLICK]).model).toBe(off)
    const faulted = { ...PLAYING, mode: 'input' as const, isFaulted: true }
    expect(posted(faulted, [CLICK]).model).toBe(faulted)
  })
})

describe('the exit Claude Code doesn’t report: the first edit or send in the prompt', () => {
  test('an edit or a typed send while the game has the keys shows input mode, and keeps the board', () => {
    for (const activity of [
      { kind: 'edit' as const },
      { kind: 'submit' as const, origin: 'composer' },
    ]) {
      const after = afterPrompt(
        { ...PLAYING, hasStrayKey: true },
        activity,
      ).model
      expect(after.mode).toBe('input')
      expect(after.hasStrayKey).toBe(false)
      expect(after.board).toEqual(PLAYING.board)
    }
  })

  test('a click on the board right after still counts', () => {
    const after = afterPrompt(PLAYING, { kind: 'edit' }).model
    expect(posted(after, [CLICK]).model.mode).toBe('game')
  })

  test('a prompt from anywhere but the person’s typing says nothing about the keys', () => {
    for (const origin of [
      'task-notification',
      'scheduled-trigger',
      'peer',
      'plugin',
      'channel',
      'bridge',
      'sdk',
      '',
    ]) {
      expect(afterPrompt(PLAYING, { kind: 'submit', origin }).model).toBe(
        PLAYING,
      )
    }
  })

  test('in input mode an edit changes nothing', () => {
    const input = { ...PLAYING, mode: 'input' as const }
    expect(afterPrompt(input, { kind: 'edit' }).model).toBe(input)
  })
})

describe('switches the person didn’t make go to input mode and retire the board', () => {
  test('the lock, a dialog, a reload, a fault, switching off and a handoff each do', () => {
    const fading = ended(
      started({ ...ON, mode: 'game', board: { epoch: 3, count: 2 } }),
      {
        at: 21_000,
      },
    )
    const playing = { ...PLAYING, hasStrayKey: true }
    for (const after of [
      afterTick(fading, 26_000).model,
      afterDialog(playing).model,
      afterRestore(playing, { isOn: true, best: 0 }, first).model,
      afterFault(playing).model,
      afterToggle(playing).model,
      afterHandoff(playing, 3).model,
    ]) {
      expect(after.mode).toBe('input')
      expect(after.hasStrayKey).toBe(false)
      expect(after.board).toEqual({ epoch: 4, count: 0 })
    }
  })
})

describe('the mode row and the look', () => {
  const room = { columns: 100, maxRows: 48 }

  test('each mode has its label, and only the game is highlighted', () => {
    expect(modeOf(PLAYING, 5000)).toEqual({
      line: '● GAME · arrows play · Tab to type',
      isActive: true,
    })
    expect(modeOf({ ...PLAYING, hasStrayKey: true }, 5000)).toEqual({
      line: '⌨ keys are in the game · Tab to type',
      isActive: true,
    })
    expect(modeOf({ ...PLAYING, mode: 'input' }, 5000)).toEqual({
      line: '▶ click the board to play',
      isActive: false,
    })
  })

  test('on a finished game, input mode says a click deals a new one', () => {
    const over = {
      ...PLAYING,
      mode: 'input' as const,
      game: { ...GAME, isOver: true },
    }
    expect(modeOf(over, 5000)).toEqual({
      line: '▶ click the board for a new game',
      isActive: false,
    })
    // Rule change: behind the card the row has nothing to say, so it isn't
    // drawn; the card says it.
    const locked = ended(started({ ...ON, game: over.game }), { at: 21_000 })
    expect(modeOf(locked, 26_000).line).toBe('')
  })

  test('during the fade the row says to finish the move; at the lock it has nothing to say, also before the lock is committed', () => {
    const fading = ended(started({ ...ON, mode: 'game' }), { at: 21_000 })
    expect(modeOf(fading, 25_999)).toEqual({
      line: '● GAME · finish your move · Tab to type',
      isActive: true,
    })
    // It already says how to leave, so a stray key keeps the move to finish.
    expect(modeOf({ ...fading, hasStrayKey: true }, 25_999).line).toBe(
      '● GAME · finish your move · Tab to type',
    )
    // Rule change: behind the card the row has nothing to say, so it isn't
    // drawn; the card says it.
    expect(modeOf(fading, 26_000)).toEqual({ line: '', isActive: false })
  })

  // Rule change: behind the card the row said the keys were back in the
  // prompt; now it has nothing to say, so it isn't drawn, as the card already
  // says it's your turn.
  test('behind the card the row has nothing to say; idle, with no card, it says the board waits for Claude', () => {
    const locked = ended(started(ON, 1000), { at: 21_000 })
    expect(isLocked(locked, 21_000)).toBe(true)
    expect(modeOf(locked, 21_000)).toEqual({ line: '', isActive: false })
    const idle = afterToggle({ ...ON, isOn: false }).model
    expect(isLocked(idle, 21_000)).toBe(false)
    expect(modeOf(idle, 21_000)).toEqual({
      line: '○ playable while Claude works',
      isActive: false,
    })
  })

  test('the full band carries the mode row', () => {
    const view = bandOf(PLAYING, 5000, room)
    expect(view.kind === 'full' && view.mode.line).toBe(
      '● GAME · arrows play · Tab to type',
    )
  })

  test('input mode never greys the tiles; only a turn’s end does', () => {
    const game = bandOf(PLAYING, 5000, room)
    const input = bandOf({ ...PLAYING, mode: 'input' }, 5000, room)
    expect(game.kind === 'full' && input.kind === 'full').toBe(true)
    if (game.kind === 'full' && input.kind === 'full') {
      expect(input.board).toEqual(game.board)
      expect(input.board).toEqual(boardOf(PLAYING.game, 0))
    }
  })

  test('with no board drawn, nothing says the game has the keys', () => {
    const view = bandOf(PLAYING, 5000, { columns: 100, maxRows: 8 })
    expect(view.kind).toBe('minimized')
    expect(JSON.stringify(view)).not.toContain('GAME')
  })
})

describe('board input across numbering, gaps and a retired board', () => {
  test('a post that starts past the next number lost inputs, maybe a Tab, so the keys go back', () => {
    const arrows = new Array<BoardInput>(BOARD_BACKLOG).fill(key('left'))
    const step = afterBoardPost(
      PLAYING,
      'board-3',
      { count: 70, inputs: arrows },
      5000,
      first,
    )
    expect(step.model.mode).toBe('input')
    expect(step.model.board).toEqual({ epoch: 4, count: 0 })
    expect(step.model.game).toBe(PLAYING.game)
  })

  test('a post that ends before the count acknowledged changes nothing', () => {
    const post = { count: 3, inputs: [key('left'), key('tab')] }
    expect(afterBoardPost(PLAYING, 'board-3', post, 5000, first).model).toBe(
      PLAYING,
    )
  })

  test('a post that overlaps what was counted applies only what is new', () => {
    const post = { count: 7, inputs: [key('tab'), key('left'), key('right')] }
    const after = afterBoardPost(PLAYING, 'board-3', post, 5000, first).model
    expect(after.mode).toBe('game')
    expect(after.game).toEqual(
      afterGame(PLAYING, played(played(GAME, 'left', first), 'right', first))
        .model.game,
    )
    expect(after.board.count).toBe(7)
  })

  test('keys sent with Ctrl, Meta or Shift stay stray all the way from the post', () => {
    const post = boardPostOf({
      count: 8,
      inputs: [
        { kind: 'key', key: 'left', ctrl: true },
        { kind: 'key', key: 'tab', meta: true },
        { kind: 'key', key: 'up', shift: true },
      ],
    })
    expect(post).not.toBeNull()
    if (post === null) return
    const after = afterBoardPost(PLAYING, 'board-3', post, 5000, first).model
    expect(after.mode).toBe('game')
    expect(after.hasStrayKey).toBe(true)
    expect(after.game).toBe(PLAYING.game)
    expect(after.board).toEqual({ epoch: 3, count: 8 })
  })

  test('across Tab: the best earned before it is kept, the rest dropped, and the new board counts from 1', () => {
    const rising = {
      ...PLAYING,
      game: {
        ...EMPTY_GAME,
        cells: [2, 2, ...new Array(14).fill(0)],
        score: 10,
        best: 10,
      },
    }
    const post = {
      count: 9,
      inputs: [key('left'), key('tab'), CLICK, key('left')],
    }
    const step = afterBoardPost(rising, 'board-3', post, 5000, first)
    expect(step.effects).toEqual([{ kind: 'save', key: 'best', value: 14 }])
    expect(step.model.mode).toBe('input')
    expect(step.model.game.moves).toBe(1)
    expect(step.model.board).toEqual({ epoch: 4, count: 0 })
    expect(afterBoardPost(step.model, 'board-3', post, 5000, first).model).toBe(
      step.model,
    )
    const fresh = afterBoardPost(
      step.model,
      'board-4',
      { count: 1, inputs: [CLICK] },
      5000,
      first,
    )
    expect(fresh.model.mode).toBe('game')
    expect(fresh.model.board).toEqual({ epoch: 4, count: 1 })
  })
})

describe('the board as drawn in the band', () => {
  test('the fit rule counts 8 rows wide and 13 narrow: a 7-row board, a 5-row card, and the mode row', () => {
    expect(bandRowsOf('row')).toBe(8)
    expect(bandRowsOf('column')).toBe(13)
    expect(BOARD_COLUMNS).toBe(29)
  })

  test('the caption under the board gives the scores, and says when the game is over', () => {
    expect(boardOf(GAME, 0).caption).toBe('score 1200 · best 3000')
    expect(boardOf({ ...GAME, isOver: true }, 0).caption).toBe(
      'game over · score 1200 · best 3000',
    )
    expect(boardOf(modelOf('junk').game, 0).caption).toBe('score 0 · best 0')
  })

  test('the full band names the board drawn now and the inputs it has counted', () => {
    const view = bandOf(PLAYING, 5000, { columns: 100, maxRows: 48 })
    expect(view.kind === 'full' && view.boardKey).toBe('board-3')
    expect(view.kind === 'full' && view.count).toBe(5)
  })
})

describe('keeping the best score across sessions', () => {
  const best = (value: number) => ({
    kind: 'save' as const,
    key: 'best' as const,
    value,
  })
  const isOn = { kind: 'save' as const, key: 'isOn' as const, value: true }

  test('a best is written only above what is stored', () => {
    expect(writeOf(best(500), { isRead: true, value: 400 })).toEqual(best(500))
    expect(writeOf(best(500), { isRead: true, value: undefined })).toEqual(
      best(500),
    )
    expect(writeOf(best(500), { isRead: true, value: 'junk' })).toEqual(
      best(500),
    )
    expect(writeOf(best(500), { isRead: true, value: 500 })).toBeNull()
    expect(writeOf(best(500), { isRead: true, value: 9999 })).toBeNull()
  })

  test('a best is never written over a store that could not be read', () => {
    expect(writeOf(best(500), { isRead: false })).toBeNull()
  })

  test('on and off is this session’s own choice, always written', () => {
    expect(writeOf(isOn, { isRead: true, value: false })).toEqual(isOn)
    expect(writeOf(isOn, { isRead: true, value: true })).toEqual(isOn)
    expect(writeOf(isOn, { isRead: false })).toEqual(isOn)
  })
})

describe('the board stays inside its frame and the band inside its body', () => {
  test('every tile label fits a 6-column tile; from 2^20 up a tile reads as a power of two', () => {
    for (let power = 1; power <= 30; power++) {
      const cells = [2 ** power, ...new Array(15).fill(0)]
      const tile = boardOf(
        modelOf({ ...INITIAL_MODEL, game: { cells } }).game,
        0,
      ).tiles[0]
      expect(tile?.text.length).toBeLessThanOrEqual(6)
    }
    const big = (value: number) =>
      boardOf({ ...EMPTY_GAME, cells: [value, ...new Array(15).fill(0)] }, 0)
        .tiles[0]?.text
    expect(big(524288)).toBe('524288')
    expect(big(1048576)).toBe('2^20')
    expect(big(2 ** 30)).toBe('2^30')
  })

  test('a body narrower than the board shows the band as one line', () => {
    const room = { maxRows: 48 }
    expect(bandOf(PLAYING, 5000, { ...room, columns: 28 }).kind).toBe(
      'minimized',
    )
    expect(bandOf(PLAYING, 5000, { ...room, columns: 29 }).kind).toBe('full')
  })

  test('only the best score reads the store before it is written', () => {
    expect(isReadFirst({ kind: 'save', key: 'best', value: 4 })).toBe(true)
    expect(isReadFirst({ kind: 'save', key: 'isOn', value: true })).toBe(false)
  })
})

describe('a best the store lacks is saved again at the next start or reload', () => {
  const kept = (best: unknown) => ({ isOn: true, best })
  const withBest = (best: number) => ({
    ...ON,
    game: { ...GAME, best, score: Math.min(GAME.score, best) },
  })

  test('a higher best than the store holds is saved again', () => {
    expect(afterRestore(withBest(16), kept(4), first).effects).toEqual([
      { kind: 'save', key: 'best', value: 16 },
    ])
    expect(afterRestore(withBest(16), kept(undefined), first).effects).toEqual([
      { kind: 'save', key: 'best', value: 16 },
    ])
  })

  test('a best the store already holds, or beats, is not written again', () => {
    expect(afterRestore(withBest(16), kept(16), first).effects).toEqual([])
    expect(afterRestore(withBest(16), kept(99), first).effects).toEqual([])
    expect(afterRestore(INITIAL_MODEL, kept(undefined), first).effects).toEqual(
      [],
    )
  })
})

// The colour a terminal limited to 256 colours shows for a #rrggbb: its
// nearest in the 6×6×6 cube, or on the grey ramp for a grey.
function in256(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const levels = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
  const toHex = (channels: number[]) =>
    '#' + channels.map(v => v.toString(16).padStart(2, '0')).join('')
  if (r === g && g === b) {
    const v =
      r < 8 ? 0 : r > 248 ? 255 : 8 + Math.round(((r - 8) / 247) * 24) * 10
    return toHex([v, v, v])
  }
  return toHex([r, g, b].map(v => levels[Math.round((v / 255) * 5)] ?? 0))
}

describe('tiles on a terminal with only 256 colours', () => {
  const tileOfValue = (value: number, fade = 0) =>
    boardOf({ ...EMPTY_GAME, cells: [value, ...new Array(15).fill(0)] }, fade)
      .tiles[0]

  test('every value keeps a shade of its own', () => {
    const shades = VALUES.map(value =>
      in256(tileOfValue(value)?.background ?? ''),
    )
    // 4096 and 131072 are both past 2048: one dark shade.
    expect(new Set(shades).size).toBe(VALUES.length - 1)
  })

  test('over the fade every value from 2 to 2048 changes shade at least twice, and the lock is a shade of its own', () => {
    const shown = VALUES.slice(0, 11).map(value => {
      const shades = [0, 0.2, 0.4, 0.6, 0.8].map(fade =>
        in256(tileOfValue(value, fade)?.background ?? ''),
      )
      const changes = shades.slice(1).filter((shade, k) => shade !== shades[k])
      return [value, changes.length >= 2, in256(LOCKED_GREY) !== shades[4]]
    })
    expect(shown).toEqual(VALUES.slice(0, 11).map(value => [value, true, true]))
  })

  // A known limit: the mod can't know the colour depth, and its black or
  // white is chosen for truecolor, so at 256 colours a label can drop under
  // 4.5:1 during the fade. This floor keeps a palette change from making it
  // worse unnoticed.
  test('over the fade every label keeps at least 3:1 on its tile as such a terminal shows it', () => {
    for (const value of VALUES) {
      for (const fade of [0, 0.2, 0.4, 0.6, 0.8]) {
        const tile = tileOfValue(value, fade)
        expect([
          value,
          fade,
          contrast(tile?.color ?? '', in256(tile?.background ?? '')) >= 3,
        ]).toEqual([value, fade, true])
      }
    }
  })

  test('every label stays legible on its tile as such a terminal shows it', () => {
    for (const value of VALUES) {
      const tile = tileOfValue(value)
      expect(
        contrast(tile?.color ?? '', in256(tile?.background ?? '')),
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('asking the model for the card’s summary', () => {
  const summarized = (change: Partial<TurnEnd> = {}) =>
    afterTurnEnd(started(ON, 1000), {
      turnId: 't1',
      reason: 'answer',
      answer: REPLY,
      durationMs: 0,
      at: 31_000,
      ...change,
    }).effects

  test('a long turn that ended normally with a reply asks once, for that turn', () => {
    expect(summarized()).toEqual([
      {
        kind: 'summarize',
        turn: { turnId: 't1', endedAt: 31_000 },
        request: summaryRequestOf(REPLY),
      },
    ])
  })

  test('a reply under 200 characters is not sent: counted after trimming, in characters, not UTF-16 units', () => {
    const reply = (length: number) => 'w'.repeat(length)
    expect(summarized({ answer: reply(199) })).toEqual([])
    expect(summarized({ answer: reply(200) })).toHaveLength(1)
    expect(summarized({ answer: `  \n${reply(199)}\n  ` })).toEqual([])
    expect(summarized({ answer: `  ${reply(200)}  ` })).toHaveLength(1)
    // An emoji is two UTF-16 units but one character.
    expect(summarized({ answer: `${reply(198)}😀` })).toEqual([])
    expect(summarized({ answer: `${reply(199)}😀` })).toHaveLength(1)
    // Counted in code points, as the request is: an accent that combines with
    // its letter counts on its own.
    expect(summarized({ answer: 'e\u0301'.repeat(100) })).toHaveLength(1)
    expect(summarized({ answer: 'e\u0301'.repeat(99) })).toEqual([])
    // Not sent, the reply leaves the placeholder.
    const done = ended(started(ON, 1000), { answer: 'Done.' })
    expect(cardOf(done.turn).text).toBe(
      'Claude finished — your turn: read the reply.',
    )
  })

  test('a turn that was declined or stopped on an error asks nothing: its placeholder says why', () => {
    for (const reason of ['refusal', 'error']) {
      expect(summarized({ reason })).toEqual([])
    }
  })

  test('a short, interrupted or empty turn asks nothing', () => {
    expect(summarized({ at: 10_999 })).toEqual([])
    expect(summarized({ at: 11_000 })).toHaveLength(1)
    expect(summarized({ reason: 'aborted' })).toEqual([])
    expect(summarized({ answer: '  ' })).toEqual([])
    expect(summarized({ agentId: 'sub-1' })).toEqual([])
  })

  // Rule change: the summary can't be switched off; the band off is the only
  // way to send nothing. The same end, on, asks once.
  test('while the band is off, nothing is asked, even for a long turn with a long reply', () => {
    const end = {
      turnId: 't1',
      reason: 'answer',
      answer: REPLY,
      durationMs: 60_000,
      at: 61_000,
    }
    expect(afterTurnEnd(started(ON, 1000), end).effects).toHaveLength(1)
    const off = { ...started(ON, 1000), isOn: false }
    expect(afterTurnEnd(off, end).effects).toEqual([])
  })

  test('Haiku reads the whole reply up to 8,000 characters, with fixed instructions, and nothing else', () => {
    const request = summaryRequestOf('  Fixed the parser.  ')
    expect(request).toMatchObject({
      model: 'haiku',
      system:
        'You write one- or two-line status notes for a developer glancing back at their terminal.',
      maxTokens: 250,
      timeoutMs: 20_000,
    })
    expect(
      request.prompt.startsWith(
        'In two short lines (about 15 words each, under 200 characters in all), first give the gist',
      ),
    ).toBe(true)
    expect(request.prompt).toContain('never say nothing is needed')
    expect(
      request.prompt.endsWith(
        "The assistant's final reply:\n\nFixed the parser.",
      ),
    ).toBe(true)
    // Whole, and once, up to the bound.
    for (const length of [5000, 8000]) {
      const reply = `${'w'.repeat(length - 7)}THE END`
      const prompt = summaryRequestOf(reply).prompt
      expect(prompt.split(reply)).toHaveLength(2)
      expect(prompt).not.toContain('left out')
    }
    expect(summaryRequestOf('w'.repeat(8001)).prompt).toContain(
      '[… the middle of the reply is left out …]',
    )
  })

  test('the token budget holds two lines at the cap even in dense text, so an answer it cut off is too long to show', () => {
    // Dense text, paths and names and numbers, runs about 3 characters a
    // token; prose about 4.
    const { maxTokens } = summaryRequestOf('Fixed it.')
    const atTheCap = 2 * 200 + 1
    expect(maxTokens).toBeGreaterThanOrEqual(Math.ceil(atTheCap / 3))
    expect(maxTokens * 3).toBeGreaterThan(atTheCap)
  })

  test('a longer reply goes as its first 2,000 and last 6,000 characters with a mark between, never its middle', () => {
    // Digits the fixed words never use, so each part can be counted.
    const reply = `${'7'.repeat(2000)}${'8'.repeat(2000)}${'9'.repeat(6000)}`
    const prompt = summaryRequestOf(reply).prompt
    expect(prompt).toContain(
      `${'7'.repeat(2000)}\n\n[… the middle of the reply is left out …]\n\n${'9'.repeat(6000)}`,
    )
    expect(prompt).not.toContain('8')
    expect(prompt.split('7').length - 1).toBe(2000)
    expect(prompt.split('9').length - 1).toBe(6000)
    expect(prompt).toContain('The beginning and the end of the assistant')
  })

  test('the reply is cut between characters, never inside one', () => {
    // An emoji is two UTF-16 units: one sits on each cut.
    const reply = `${'a'.repeat(1999)}😀${'m'.repeat(3000)}😀${'t'.repeat(5999)}`
    const prompt = summaryRequestOf(reply).prompt
    expect(prompt).toContain(`${'a'.repeat(1999)}😀\n\n[…`)
    expect(prompt).toContain(`…]\n\n😀${'t'.repeat(5999)}`)
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        prompt,
      ),
    ).toBe(false)
  })
})

describe('the summary on the card and during the fade', () => {
  // Rule change: the fade showed the gist and an arrowed next step apart;
  // now it shows the card's paragraph, plain, with nothing under it.
  test('while the turn’s end fades, the status shows the card’s paragraph', () => {
    const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 })
    const before = statusOf(fading, 22_000)
    expect([before.current, before.before]).toEqual([
      ['Claude finished — your turn: read the reply.'],
      [],
    ])
    const summary = afterSummary(fading, keyOf(fading), {
      isAnswered: true,
      text: 'Fixed the parser.\nRun the tests.',
    }).model
    const after = statusOf(summary, 22_000)
    expect([after.current, after.before]).toEqual([
      ['Fixed the parser. Run the tests.'],
      [],
    ])
  })

  test('a kept summary is read again as a pair; anything else reads as none', () => {
    const turnWith = (summary: unknown, next: unknown) =>
      modelOf({
        ...INITIAL_MODEL,
        turn: { ...INITIAL_MODEL.turn, summary, next },
      }).turn
    expect(turnWith('Fixed it.', 'Run it.')).toMatchObject({
      summary: 'Fixed it.',
      next: 'Run it.',
    })
    for (const [summary, next] of [
      ['Fixed it.', ''],
      ['', 'Run it.'],
      ['Fixed it.', 'a'.repeat(201)],
      ['Fixed it.', undefined],
      [42, 'Run it.'],
    ]) {
      expect(turnWith(summary, next)).toMatchObject({ summary: '', next: '' })
    }
  })
})

describe('the summary: a stopped band, the exact request, and labels', () => {
  test('a turn ended while the band is stopped by a fault asks nothing', () => {
    const faulted = { ...started(ON, 1000), isFaulted: true }
    const end = {
      turnId: 't1',
      reason: 'answer',
      answer: 'Done.',
      durationMs: 0,
      at: 61_000,
    }
    expect(afterTurnEnd(faulted, end).effects).toEqual([])
  })

  // Rule change: one sentence added, keeping Haiku to what the reply says.
  test('the request is exactly the fixed instructions and the whole reply', () => {
    expect(summaryRequestOf('Fixed it.')).toEqual({
      model: 'haiku',
      system:
        'You write one- or two-line status notes for a developer glancing back at their terminal.',
      prompt:
        'In two short lines (about 15 words each, under 200 characters in all), ' +
        'first give the gist of what was done or found, then what the developer ' +
        'should do next: review, answer its question, test, decide. ' +
        "Use only what the reply says: don't add work, changes or results it doesn't mention. " +
        'There is always a next step; never say nothing is needed. Plain text, no markdown. ' +
        'Reply with exactly two lines: the gist on the first, the next step on the second. ' +
        'Keep each line under 120 characters.' +
        "\n\nThe assistant's final reply:\n\nFixed it.",
      maxTokens: 250,
      timeoutMs: 20_000,
    })
  })

  test('the effect names the turn by its id and its end', () => {
    const effects = afterTurnEnd(started(ON, 1000), {
      turnId: 't1',
      reason: 'answer',
      answer: REPLY,
      durationMs: 0,
      at: 31_000,
    }).effects
    expect(effects[0]).toMatchObject({
      turn: { turnId: 't1', endedAt: 31_000 },
    })
  })

  test('markdown emphasis and labels are dropped from the two lines', () => {
    expect(
      summaryOf({
        isAnswered: true,
        text: '**Summary:** Fixed the `parse` step.\n**Next:** Run the tests.',
      }),
    ).toEqual({ line: 'Fixed the parse step.', next: 'Run the tests.' })
    expect(
      summaryOf({
        isAnswered: true,
        text: '## Done: fixed parse_args.\nNext step: rerun it.',
      }),
    ).toEqual({ line: 'fixed parse_args.', next: 'rerun it.' })
  })
})

// Rule change: the next step was its own part, wrapped on rows of its own;
// now it is the paragraph's second sentence, wrapped with the gist.
describe('the next step wraps with the gist, beside or under the board', () => {
  const NEXT = 'Check that output to confirm the command finished.'
  const TEXT = `Ran the command. ${NEXT}`
  const lockedWith = (next: string) =>
    afterSummary(
      ended(started(ON, 1000), { at: 31_000 }),
      { turnId: 't1', endedAt: 31_000 },
      { isAnswered: true, text: `Ran the command.\n${next}` },
    ).model
  const cardAt = (columns: number, next = NEXT) => {
    const view = bandOf(lockedWith(next), 40_000, { columns, maxRows: 48 })
    if (view.kind !== 'full' || view.card === null) throw new Error('no card')
    return view.card
  }

  test('at 64 columns the paragraph shows whole on rows of the panel’s width', () => {
    const card = cardAt(64)
    expect(card.rows.join(' ')).toBe(TEXT)
    for (const row of card.rows) expect(row.length).toBeLessThanOrEqual(33)
    expect(card.rows).toHaveLength(3)
  })

  test('with room, it stays on one row', () => {
    expect(cardAt(120).rows).toEqual([TEXT])
  })

  test('under the board it wraps at the band’s width too', () => {
    expect(cardAt(50).rows).toEqual([
      'Ran the command. Check that output to confirm the',
      'command finished.',
    ])
  })

  test('a long next step takes the rows it needs, never cut', () => {
    const long =
      'Open the deployment dashboard and approve the production release then tell the team in the channel.'
    const card = cardAt(64, long)
    expect(card.rows.join(' ')).toBe(`Ran the command. ${long}`)
    for (const row of card.rows) expect(row.length).toBeLessThanOrEqual(33)
  })

  test('while the turn’s end fades, the paragraph wraps the same way, with nothing under it', () => {
    const fading = afterSummary(
      ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 }),
      { turnId: 't1', endedAt: 21_000 },
      { isAnswered: true, text: `Ran the command.\n${NEXT}` },
    ).model
    const view = bandOf(fading, 22_000, { columns: 64, maxRows: 48 })
    if (view.kind !== 'full' || view.status === null) throw new Error('no fade')
    expect(view.status.current).toEqual(cardAt(64).rows)
    expect(view.status.before).toEqual([])
  })
})

describe('the whole branch, seams', () => {
  test('once a turn is handed back, a late end of an older turn changes nothing', () => {
    const t1 = ended(started(ON, 1000, 't1'), { turnId: 't1', at: 31_000 })
    const t2 = ended(started(t1, 40_000, 't2'), { turnId: 't2', at: 70_000 })
    // t1 began at 50 s, before t2 was handed back at 70 s: it is stale.
    const late = afterTurnEnd(t2, {
      turnId: 't1',
      reason: 'answer',
      answer: 'Old.',
      durationMs: 30_000,
      at: 80_000,
    })
    expect(late.model).toBe(t2)
    expect(late.effects).toEqual([])
  })

  test('a turn that began after the hand-back, its start unseen, is handed back as usual', () => {
    const t1 = ended(started(ON, 1000, 't1'), { turnId: 't1', at: 31_000 })
    const t2 = ended(started(t1, 40_000, 't2'), { turnId: 't2', at: 70_000 })
    const unseen = afterTurnEnd(t2, {
      turnId: 't3',
      reason: 'answer',
      answer: 'New.',
      durationMs: 20_000,
      at: 100_000,
    }).model
    expect(unseen.turn).toMatchObject({
      turnId: 't3',
      phase: 'done',
      endedAt: 100_000,
    })
  })
})

describe('the look of each state', () => {
  const room = { columns: 100, maxRows: 48 }
  const tight = { columns: 100, maxRows: 7, isFullscreen: true }
  const fading = ended(started({ ...ON, mode: 'game' }, 1000), { at: 21_000 })
  // Each state, with its moment: Claude working with the keys in the prompt
  // or in the game, the fade with the game on, the lock after a stop, and
  // idle before any turn.
  const STATES = {
    'working, input': { model: started(ON, 1000), at: 5000 },
    'working, game': {
      model: { ...started(ON, 1000), mode: 'game' as const },
      at: 5000,
    },
    fade: { model: fading, at: 23_000 },
    locked: { model: ended(started(ON, 1000), { at: 21_000 }), at: 22_000 },
    idle: { model: ON, at: 0 },
  }
  const look = (name: keyof typeof STATES) => {
    const { model, at } = STATES[name]
    const view = bandOf(model, at, room)
    if (view.kind !== 'full') throw new Error(`${name}: not the full band`)
    return {
      status: view.status && [view.status.tone, view.status.headline],
      heading: view.card?.heading,
      frame: view.frame,
      tiles: view.board.tiles,
      mode: view.mode,
      fade: fadeOf(model, at),
    }
  }

  test('each state has its status line, frame, tiles and mode row', () => {
    expect(look('working, input')).toEqual({
      status: ['working', '● Claude is working · 4s · 0 tool calls'],
      heading: undefined,
      frame: 'dim',
      tiles: boardOf(GAME, 0).tiles,
      mode: { line: '▶ click the board to play', isActive: false },
      fade: 0,
    })
    expect(look('working, game')).toEqual({
      ...look('working, input'),
      frame: 'game',
      mode: { line: '● GAME · arrows play · Tab to type', isActive: true },
    })
    expect(look('fade')).toEqual({
      status: ['waiting', 'Claude is waiting for you · the board locks in 3s'],
      heading: undefined,
      frame: 'fade',
      tiles: boardOf(GAME, 0.4).tiles,
      mode: { line: '● GAME · finish your move · Tab to type', isActive: true },
      fade: 0.4,
    })
    expect(look('locked')).toEqual({
      status: null,
      heading: '✓ YOUR TURN',
      frame: 'dim',
      tiles: boardOf(GAME, 1).tiles,
      mode: { line: '', isActive: false },
      fade: 1,
    })
    expect(look('idle')).toEqual({
      status: ['idle', "No activity yet · Claude's work shows here"],
      heading: undefined,
      frame: 'dim',
      tiles: boardOf(GAME, 1).tiles,
      mode: { line: '○ playable while Claude works', isActive: false },
      fade: 1,
    })
  })

  test('the banner keeps its countdown at every width: shorter words where the full sentence won’t fit', () => {
    const banner = (columns: number) => {
      const view = bandOf(fading, 23_000, { columns, maxRows: 48 })
      return view.kind === 'full' && view.status?.headline
    }
    // Beside the board the panel is the width less 31 columns.
    expect(banner(80)).toBe('Claude is waiting for you · the board locks in 3s')
    expect(banner(79)).toBe('Claude is waiting · locks in 3s')
    expect(banner(64)).toBe('Claude is waiting · locks in 3s')
    // Under the board the band's full width is the panel's.
    expect(banner(63)).toBe('Claude is waiting for you · the board locks in 3s')
    expect(banner(49)).toBe('Claude is waiting for you · the board locks in 3s')
    expect(banner(48)).toBe('Claude is waiting · locks in 3s')
    expect(banner(31)).toBe('Claude is waiting · locks in 3s')
    expect(banner(30)).toBe('locks in 3s')
  })

  test('shrunk to one line during the fade, the banner fits the band’s width the same way', () => {
    const head = (columns: number, isFullscreen = false) => {
      const view = bandOf(fading, 23_000, {
        columns,
        maxRows: isFullscreen ? 7 : 20,
        isFullscreen,
      })
      return view.kind === 'minimized' && view.head
    }
    // Rule change: the form is chosen from the width the hint leaves, its
    // 26 columns after the banner.
    expect(head(75)).toBe('Claude is waiting for you · the board locks in 3s')
    expect(head(74)).toBe('Claude is waiting · locks in 3s')
    expect(head(57)).toBe('Claude is waiting · locks in 3s')
    expect(head(56)).toBe('locks in 3s')
    expect(head(29)).toBe('locks in 3s')
    expect(head(56, true)).toBe('locks in 3s')
    expect(head(57, true)).toBe('Claude is waiting · locks in 3s')
    expect(head(74, true)).toBe('Claude is waiting · locks in 3s')
    expect(head(75, true)).toBe(
      'Claude is waiting for you · the board locks in 3s',
    )
    expect(head(100, true)).toBe(
      'Claude is waiting for you · the board locks in 3s',
    )
  })

  test('at 60 columns the fade’s one line shows the 31-character banner and the whole hint', () => {
    const view = bandOf(fading, 23_000, { columns: 60, maxRows: 20 })
    if (view.kind !== 'minimized') throw new Error('not one line')
    expect(view.head).toBe('Claude is waiting · locks in 3s')
    expect(`${view.head}${view.tail}`).toBe(
      'Claude is waiting · locks in 3s · more rows show the game',
    )
    expect(`${view.head}${view.tail}`.length).toBeLessThanOrEqual(60)
  })

  test('the banner counts down, and the frame leaves the fade the moment the board locks', () => {
    const at = (now: number) => bandOf(fading, now, room)
    const first = at(21_000)
    const last = at(25_999)
    expect(first.kind === 'full' && first.status?.headline).toBe(
      'Claude is waiting for you · the board locks in 5s',
    )
    expect(last.kind === 'full' && last.status?.headline).toBe(
      'Claude is waiting for you · the board locks in 1s',
    )
    expect(last.kind === 'full' && last.frame).toBe('fade')
    const locked = at(26_000)
    expect(locked.kind === 'full' && locked.frame).toBe('dim')
    const left = bandOf({ ...fading, mode: 'input' }, 23_000, room)
    expect(left.kind === 'full' && left.frame).toBe('dim')
  })

  test('shrunk to one line, each state leads with its own words, in its own tone', () => {
    const line = (name: keyof typeof STATES) => {
      const { model, at } = STATES[name]
      const view = bandOf(model, at, tight)
      return view.kind === 'minimized' && [view.tone, view.head, view.tail]
    }
    expect(line('working, input')).toEqual([
      'working',
      '● Claude is working · 4s · 0 tool calls',
      ' · more rows show the game',
    ])
    expect(line('fade')).toEqual([
      'waiting',
      'Claude is waiting for you · the board locks in 3s',
      ' · more rows show the game',
    ])
    expect(line('locked')).toEqual([
      'card',
      '✓ YOUR TURN',
      ' · more rows show the game · Claude finished — your turn: read the reply.',
    ])
    expect(line('idle')).toEqual([
      'idle',
      "No activity yet · Claude's work shows here",
      ' · more rows show the game',
    ])
  })
})

describe('the card wraps the summary over the rows it has', () => {
  // Gists the shape check accepts: about 100 characters a part, and longer.
  const GIST = {
    line: 'Rewrote the config loader to read every profile at start; the stale cache bug is now fully fixed.',
    next: 'Run the integration tests against staging, then check that the profile switch works in the app.',
  }
  const LONG = {
    line: 'Moved the payment retries into a background queue with backoff, so failed charges no longer block the checkout pages.',
    next: 'Review the queue settings in config/payments.yml, then run the checkout tests before you merge the new branch.',
  }
  const SHORT = { line: 'Fixed the parser.', next: 'Run the tests.' }
  const textOf = (gist: { line: string; next: string }) =>
    `${gist.line} ${gist.next}`
  const summarized = (gist: { line: string; next: string }, model = ON) =>
    afterSummary(
      ended(started(model, 1000), { at: 31_000 }),
      { turnId: 't1', endedAt: 31_000 },
      { isAnswered: true, text: `${gist.line}\n${gist.next}` },
    ).model
  const cardAt = (gist: { line: string; next: string }, columns: number) => {
    const view = bandOf(summarized(gist), 40_000, { columns, maxRows: 48 })
    if (view.kind !== 'full' || view.card === null) throw new Error('no card')
    return view.card
  }
  const rowsIn = (card: CardView) =>
    1 +
    (card.stats === null ? 0 : 1) +
    card.rows.length +
    (card.files === null ? 0 : 1)

  test('at 80 columns, a gist of about 100 characters a part shows every word beside the board, on the usual card', () => {
    const card = cardAt(GIST, 80)
    expect(card.rows.join(' ')).toBe(textOf(GIST))
    for (const row of card.rows) expect(row.length).toBeLessThanOrEqual(80 - 31)
    expect([card.heading, card.stats !== null, card.files !== null]).toEqual([
      '✓ YOUR TURN',
      true,
      true,
    ])
    expect(rowsIn(card)).toBeLessThanOrEqual(7)
  })

  test('the paragraph gives way row by row: the files first, then the stats join the heading, then its end is cut', () => {
    // At 80 columns beside the board the panel is 49 wide and 7 rows high:
    // the heading, the stats, the paragraph and the files.
    const room = { width: 49, rows: 7 }
    // The rows a text needs, broken at spaces: counted here on its own.
    const needed = (text: string) =>
      text
        .split(' ')
        .reduce(
          ({ rows, used }, word) =>
            used === 0
              ? { rows, used: word.length }
              : used + 1 + word.length <= room.width
                ? { rows, used: used + 1 + word.length }
                : { rows: rows + 1, used: word.length },
          { rows: 1, used: 0 },
        ).rows
    const seen = new Set<number>()
    for (let words = 2; words <= 70; words++) {
      const card = cardOf(
        summarized({
          line: Array.from({ length: Math.ceil(words / 2) }, () => 'word').join(
            ' ',
          ),
          next: Array.from(
            { length: Math.floor(words / 2) },
            () => 'step',
          ).join(' '),
        }).turn,
        room,
      )
      const rows = needed(card.text)
      seen.add(Math.min(rows, 7))
      const look = {
        rows: card.rows.length,
        stats: card.stats !== null,
        files: card.files !== null,
        joined: card.heading !== '✓ YOUR TURN',
        cut: card.rows.some(row => row.length > room.width),
      }
      expect([rows, look]).toEqual([
        rows,
        rows <= 4
          ? { rows, stats: true, files: true, joined: false, cut: false }
          : rows === 5
            ? { rows, stats: true, files: false, joined: false, cut: false }
            : rows === 6
              ? { rows, stats: false, files: false, joined: true, cut: false }
              : {
                  rows: 6,
                  stats: false,
                  files: false,
                  joined: true,
                  cut: true,
                },
      ])
      // Cut or not, the whole paragraph is on the rows, in order.
      expect(card.rows.join(' ')).toBe(card.text)
    }
    expect([4, 5, 6, 7].every(rows => seen.has(rows))).toBe(true)
  })

  test('a longer gist joins the stats to the heading in short, and the card is still 7 rows', () => {
    const card = cardAt(LONG, 64)
    expect(card.files).toBeNull()
    expect(card.stats).toBeNull()
    expect(card.heading).toBe('✓ YOUR TURN · 30s · 0 tools · 0 files')
    expect(rowsIn(card)).toBeLessThanOrEqual(7)
    // One tool and one file read in the singular.
    let model = afterToolCall(started(ON, 1000), {
      tool: 'Write',
      input: { file_path: '/repo/a.ts' },
      at: 2000,
    }).model
    model = afterToolDone(model, {
      turn: turnKeyOf(model),
      tool: 'Write',
      input: { file_path: '/repo/a.ts' },
      isOk: true,
    }).model
    const done = afterSummary(
      ended(model, { at: 31_000 }),
      { turnId: 't1', endedAt: 31_000 },
      { isAnswered: true, text: `${LONG.line}\n${LONG.next}` },
    ).model
    expect(cardOf(done.turn, { width: 33, rows: 7 }).heading).toBe(
      '✓ YOUR TURN · 30s · 1 tool · 1 file',
    )
  })

  test('a short gist keeps the usual card', () => {
    const card = cardAt(SHORT, 80)
    expect(card.heading).toBe('✓ YOUR TURN')
    expect(card.stats).toBe('30s · 0 tool calls · 0 files changed')
    expect(card.files).toBe('')
    expect(card.rows).toEqual(['Fixed the parser. Run the tests.'])
  })

  // Rule change: the two parts used to share the rows, each cut on its own;
  // now the one paragraph runs on and its end is cut where the band ends it.
  test('where the paragraph doesn’t fit, its end is cut where the band ends it', () => {
    const card = cardAt(
      {
        line: 'word '.repeat(39).trim(),
        next: 'step '.repeat(39).trim(),
      },
      64,
    )
    expect(card.stats).toBeNull()
    expect(rowsIn(card)).toBe(7)
    expect(card.rows.at(-1)?.length).toBeGreaterThan(64 - 31)
    expect(card.rows.join(' ')).toBe(card.text)
  })

  test('during the fade the paragraph wraps the same way under the banner, every word shown', () => {
    const fading = summarized(GIST, { ...ON, mode: 'game' })
    const view = bandOf(fading, 32_000, { columns: 80, maxRows: 48 })
    if (view.kind !== 'full' || view.status === null) throw new Error('no fade')
    expect(view.status.current.join(' ')).toBe(textOf(GIST))
    expect(view.status.before).toEqual([])
    for (const row of view.status.current) {
      expect(row.length).toBeLessThanOrEqual(80 - 31)
    }
  })

  test('a long gist with a short next step still ends on the next step, every word shown', () => {
    const gist = {
      line: 'Moved the payment retries into a background queue with backoff, so failed charges no longer block the checkout pages, receipts or the nightly refund jobs.',
      next: 'Run the tests.',
    }
    const card = cardAt(gist, 64)
    expect(card.stats).toBeNull()
    expect(card.files).toBeNull()
    expect(card.rows.join(' ')).toBe(textOf(gist))
    for (const row of card.rows) expect(row.length).toBeLessThanOrEqual(33)
    expect(card.rows.join(' ').endsWith('Run the tests.')).toBe(true)
    expect(card.rows.at(-1)?.length).toBeLessThanOrEqual(33)
    expect(rowsIn(card)).toBeLessThanOrEqual(7)
  })

  test('at every width, for every gist the shape check accepts, neither the card nor the fade takes more rows than the band has', () => {
    const gists = [
      SHORT,
      GIST,
      LONG,
      { line: 'a'.repeat(125), next: 'b'.repeat(125) },
      { line: 'a'.repeat(200), next: 'b'.repeat(200) },
      {
        line: 'word '.repeat(40).trim(),
        next: 'step '.repeat(40).trim(),
      },
      {
        line: 'word '.repeat(25).trim(),
        next: 'step '.repeat(25).trim(),
      },
    ]
    for (const gist of gists) {
      expect(
        summaryOf({ isAnswered: true, text: `${gist.line}\n${gist.next}` }),
      ).not.toBeNull()
      const locked = summarized(gist)
      const fading = summarized(gist, { ...ON, mode: 'game' })
      for (let columns = 29; columns <= 200; columns++) {
        const room = { columns, maxRows: 200 }
        const card = bandOf(locked, 40_000, room)
        const fade = bandOf(fading, 32_000, room)
        if (card.kind !== 'full' || card.card === null)
          throw new Error('no card')
        if (fade.kind !== 'full' || fade.status === null)
          throw new Error('no fade')
        const side = card.direction === 'row' ? 7 : 5
        expect(rowsIn(card.card)).toBeLessThanOrEqual(side)
        expect(
          1 + fade.status.current.length + fade.status.before.length,
        ).toBeLessThanOrEqual(side)
      }
    }
  })
})

describe('other mods’ content above the band', () => {
  const ENGINE = { type: 'engine', ref: 1 }
  const el = (type: string, ...children: unknown[]) => ({ type, children })
  const column = (...children: unknown[]) => ({
    ...el('Box', ...children),
    props: { flexDirection: 'column' },
  })

  test('a text takes its lines wrapped, a column the sum, a row the tallest, anything else a row', () => {
    const four = el('Text', 'one two three four')
    expect(
      rowsTakenOf(el('Text', 'a\nb', el('Text', 'x'.repeat(25))), 10),
    ).toBe(4)
    expect(rowsTakenOf(column(four, el('Button'), ENGINE), 9)).toBe(4)
    expect(rowsTakenOf(el('Box', four, el('Button')), 9)).toBe(3)
    expect(rowsTakenOf([el('Text', 'a'), 'b'], 40)).toBe(2)
    expect(rowsTakenOf(ENGINE, 40)).toBe(0)
  })

  test('under others the game has the rows left by the same fit, and with none left nothing', () => {
    const room = { columns: 100, maxRows: 10, isFullscreen: true }
    const kindAt = (change: Partial<Room>) =>
      bandOf(started(), 2000, { ...room, ...change }).kind
    expect(kindAt({ others: 2 })).toBe('full')
    expect(kindAt({ others: 9 })).toBe('minimized')
    expect(kindAt({ others: 10 })).toBe('none')
    expect(kindAt({ maxRows: 30, isFullscreen: false, others: 7 })).toBe(
      'minimized',
    )
    // With no others, as before, even with no row at all.
    expect(kindAt({ maxRows: 0 })).toBe('minimized')
    expect(kindAt({ others: 0 })).toBe('full')
  })
})
