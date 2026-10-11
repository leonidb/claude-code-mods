import { describe, expect, test } from 'bun:test'

import { canMove, newGame, played, spawned } from '../../hooks/game'
import type { Move } from '../../hooks/game'
import type { Game } from '../../types'

// Always the first empty cell, and always a 2.
const first = () => 0

// Random numbers taken in turn from a list, so a test can say where a tile
// lands and what it is.
function sequence(...values: number[]) {
  let at = 0
  return () => values[at++ % values.length] ?? 0
}

function gameWith(cells: number[], change: Partial<Game> = {}): Game {
  return {
    cells,
    score: 0,
    best: 0,
    isOver: false,
    hasWon: false,
    moves: 0,
    ...change,
  }
}

// A board whose first row is `row` and is otherwise empty.
function rowBoard(row: number[]): number[] {
  return [...row, ...new Array<number>(12).fill(0)]
}

describe('newGame', () => {
  test('starts with two tiles, no score and no moves, and keeps the best score', () => {
    const game = newGame(512, first)
    expect(game.cells).toHaveLength(16)
    expect(game.cells.filter(value => value !== 0)).toHaveLength(2)
    expect(game.score).toBe(0)
    expect(game.moves).toBe(0)
    expect(game.best).toBe(512)
    expect(game.isOver).toBe(false)
    expect(game.hasWon).toBe(false)
  })
})

describe('spawned', () => {
  test('puts a 2 nine times in ten and a 4 otherwise', () => {
    const cells = [0, ...new Array<number>(15).fill(8)]
    expect(spawned(cells, sequence(0, 0))[0]).toBe(2)
    expect(spawned(cells, sequence(0, 0.8999))[0]).toBe(2)
    expect(spawned(cells, sequence(0, 0.9))[0]).toBe(4)
    expect(spawned(cells, sequence(0, 0.9999))[0]).toBe(4)
  })

  test('every empty cell is as likely as any other', () => {
    const cells = [0, 2, 0, 2, 0, ...new Array<number>(11).fill(2)]
    const landed = (random: number) =>
      spawned(cells, sequence(random, 0)).findIndex(
        (value, at) => value !== cells[at],
      )
    expect([0, 0.33].map(landed)).toEqual([0, 0])
    expect([0.34, 0.66].map(landed)).toEqual([2, 2])
    expect([0.67, 0.9999].map(landed)).toEqual([4, 4])
  })

  test('leaves a full board as it is, and never changes the board it was given', () => {
    const full = Object.freeze(new Array<number>(16).fill(2))
    expect(spawned(full, first)).toEqual([...full])
    const open = Object.freeze([0, ...new Array<number>(15).fill(2)])
    expect(spawned(open, first)[0]).toBe(2)
  })

  test('still picks an empty cell when the random source strays out of range', () => {
    const cells = [0, 2, 2, 0, ...new Array<number>(12).fill(2)]
    for (const random of [-1, 1, 7, Number.NaN]) {
      const next = spawned(cells, sequence(random, 0))
      expect(next.filter(value => value === 0)).toHaveLength(1)
    }
  })
})

describe('played', () => {
  test('each pair of equal tiles merges once, toward the edge', () => {
    const cases: [number[], number[]][] = [
      [
        [2, 2, 2, 2],
        [4, 4],
      ],
      [
        [2, 2, 4, 0],
        [4, 4],
      ],
      [
        [4, 4, 8, 0],
        [8, 8],
      ],
      [[2, 0, 2, 0], [4]],
      [[0, 0, 0, 2], [2]],
      [
        [2, 4, 2, 4],
        [2, 4, 2, 4],
      ],
      [
        [8, 8, 8, 0],
        [16, 8],
      ],
    ]
    for (const [row, slid] of cases) {
      const after = played(gameWith(rowBoard(row)), 'left', sequence(0.99, 0))
      expect(after.cells.slice(0, slid.length)).toEqual(slid)
    }
  })

  test('slides in all four directions', () => {
    const middle = new Array<number>(16).fill(0)
    middle[5] = 2
    const edges: Record<Move, number> = { left: 4, right: 7, up: 1, down: 13 }
    for (const move of ['left', 'right', 'up', 'down'] as const) {
      const after = played(gameWith(middle), move, sequence(0.99, 0))
      expect(after.cells[edges[move]]).toBe(2)
      expect(after.cells[5]).not.toBe(2)
    }
  })

  test('adds each merged tile to the score, and the best follows the score up', () => {
    const before = gameWith(rowBoard([2, 2, 4, 4]), { score: 10, best: 12 })
    const after = played(before, 'left', first)
    expect(after.score).toBe(10 + 4 + 8)
    expect(after.best).toBe(22)
    const lower = played(
      gameWith(rowBoard([2, 2, 0, 0]), { best: 1000 }),
      'left',
      first,
    )
    expect(lower.best).toBe(1000)
  })

  test('a move changes the board, adds one new tile and counts one move', () => {
    const before = gameWith(rowBoard([0, 0, 0, 2]))
    const after = played(before, 'left', sequence(0, 0))
    expect(after.cells.filter(value => value !== 0)).toHaveLength(2)
    expect(after.moves).toBe(1)
  })

  test('a move that changes nothing returns the same game: no new tile, no move counted', () => {
    const cells = Object.freeze(rowBoard([2, 4, 0, 0])) as number[]
    const before = Object.freeze(gameWith(cells, { moves: 3 }))
    expect(played(before, 'left', first)).toBe(before)
    expect(played(before, 'up', first)).toBe(before)
    expect(before.moves).toBe(3)
  })

  test('the same moves with the same random numbers give the same game, whenever they are played', () => {
    const play = () =>
      (['left', 'down', 'right', 'up'] as const).reduce(
        (game, move) => played(game, move, sequence(0.3, 0.7, 0.1)),
        newGame(0, sequence(0.2, 0.4, 0.6, 0.8)),
      )
    expect(play()).toEqual(play())
  })

  test('the game is over when no move can change the board, and it no longer moves', () => {
    // The last empty cell fills on this move, and no two neighbours are equal.
    const before = gameWith([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 0, 4, 8, 16])
    const after = played(before, 'left', first)
    expect(after.cells.slice(12)).toEqual([4, 8, 16, 2])
    expect(after.isOver).toBe(true)
    expect(canMove(after.cells)).toBe(false)
    expect(played(after, 'right', first)).toBe(after)
  })

  test('reaching 2048 wins, and the win stays', () => {
    const won = played(gameWith(rowBoard([1024, 1024, 0, 0])), 'left', first)
    expect(won.hasWon).toBe(true)
    const later = played(
      gameWith(
        won.cells.map(value => (value === 2048 ? 0 : value)),
        { hasWon: true },
      ),
      'right',
      first,
    )
    expect(later.hasWon).toBe(true)
  })
})

describe('canMove', () => {
  test('a board with an empty cell or two equal neighbours can move', () => {
    const full = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2]
    expect(canMove(full)).toBe(false)
    expect(canMove([0, ...full.slice(1)])).toBe(true)
    expect(canMove([2, 2, ...full.slice(2)])).toBe(true)
  })

  test('two equal tiles side by side, alone on a full board, can move, upright or across', () => {
    const upright = [
      2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2, 4, 8, 16, 32, 4,
    ]
    const across = [
      2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2, 8, 16, 32, 4, 4,
    ]
    const neither = [
      2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2, 8, 16, 32, 64, 4,
    ]
    expect(canMove(upright)).toBe(true)
    expect(canMove(across)).toBe(true)
    expect(canMove(neither)).toBe(false)
  })
})
