import type { Game } from '../types'

/** A direction the tiles slide in. */
export type Move = 'left' | 'right' | 'up' | 'down'

/** A source of random numbers in [0, 1), passed in so the rules stay pure. */
export type Random = () => number

const SIDE = 4

// For each move, the board's lines as cell indexes, each listed from the edge
// the tiles slide toward.
const LINES: Record<Move, number[][]> = {
  left: rows(),
  right: rows().map(row => [...row].reverse()),
  up: columns(),
  down: columns().map(column => [...column].reverse()),
}

/** A new game: two tiles on an empty board, with the best score carried over. */
export function newGame(best: number, random: Random): Game {
  const empty = new Array<number>(SIDE * SIDE).fill(0)
  return {
    cells: spawned(spawned(empty, random), random),
    score: 0,
    best,
    isOver: false,
    hasWon: false,
    moves: 0,
  }
}

/**
 * The board with one new tile in a random empty cell: a 2 nine times in ten,
 * otherwise a 4. A full board comes back as it was.
 */
export function spawned(cells: readonly number[], random: Random): number[] {
  const empty = cells.flatMap((value, at) => (value === 0 ? [at] : []))
  const next = [...cells]
  const at = empty[indexOf(random(), empty.length)]
  if (at !== undefined) next[at] = random() < 0.9 ? 2 : 4
  return next
}

/** Whether any move would change the board: an empty cell, or two equal tiles side by side. */
export function canMove(cells: readonly number[]): boolean {
  return [...rows(), ...columns()].some(line =>
    line.some((at, k) => {
      const value = cells[at] ?? 0
      const after = line[k + 1]
      return value === 0 || (after !== undefined && cells[after] === value)
    }),
  )
}

/**
 * The game after a move. Tiles slide toward the move's edge, and each pair of
 * equal tiles meeting there merges once into their sum, which is added to the
 * score. Then a new tile appears. A move that changes nothing returns the very
 * same game, with no new tile and no move counted, and so does any move on a
 * finished game.
 */
export function played(game: Game, move: Move, random: Random): Game {
  if (game.isOver) return game
  const cells = [...game.cells]
  let gained = 0
  for (const line of LINES[move]) {
    const result = slid(line.map(at => game.cells[at] ?? 0))
    line.forEach((at, k) => {
      cells[at] = result.values[k] ?? 0
    })
    gained += result.gained
  }
  if (cells.every((value, at) => value === game.cells[at])) return game
  const next = spawned(cells, random)
  const score = game.score + gained
  return {
    cells: next,
    score,
    best: Math.max(game.best, score),
    isOver: !canMove(next),
    hasWon: game.hasWon || next.some(value => value >= 2048),
    moves: game.moves + 1,
  }
}

// One line slid toward its first cell: equal neighbours merge once, left to
// right, so 2 2 2 2 becomes 4 4 and never 8.
function slid(line: readonly number[]): { values: number[]; gained: number } {
  const tiles = line.filter(value => value !== 0)
  const values: number[] = []
  let gained = 0
  for (let k = 0; k < tiles.length; k++) {
    const value = tiles[k] ?? 0
    if (tiles[k + 1] === value) {
      values.push(value * 2)
      gained += value * 2
      k++
    } else {
      values.push(value)
    }
  }
  while (values.length < line.length) values.push(0)
  return { values, gained }
}

function rows(): number[][] {
  return range(SIDE).map(row => range(SIDE).map(column => row * SIDE + column))
}

function columns(): number[][] {
  return range(SIDE).map(column => range(SIDE).map(row => row * SIDE + column))
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, k) => k)
}

// A random number turned into an index below `count`, even when the source
// strays outside [0, 1).
function indexOf(random: number, count: number): number {
  if (!Number.isFinite(random)) return 0
  return Math.min(count - 1, Math.max(0, Math.floor(random * count)))
}
