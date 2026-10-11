/** One tool call as the band names it: the tool and what it works on. */
export type Activity = { tool: string; target: string }

/** Why a turn stopped, as Claude Code reports it; empty before any stop. */
export type StopReason = 'answer' | 'aborted' | 'refusal' | 'error' | ''

/** The main loop's current or last turn. */
export type Turn = {
  turnId: string
  phase: 'idle' | 'running' | 'done'
  startedAt: number
  endedAt: number
  tools: number
  current: Activity | null
  recent: Activity[]
  files: string[]
  reason: StopReason
  /** Whether the turn ended with an answer, not an empty one. */
  hasAnswer: boolean
  /** The model's summary of what Claude did, or empty for the placeholder. */
  summary: string
  /** The next step the summary gives the person; set with `summary`. */
  next: string
  /** When the board locks; 0 once the lock has taken effect, so it holds. */
  lockAt: number
  isShown: boolean
}

/** A 2048 game: 16 cells in rows, 0 for an empty cell. */
export type Game = {
  cells: number[]
  score: number
  best: number
  isOver: boolean
  hasWon: boolean
  moves: number
}

/** Where the keys go: the game, or the prompt. */
export type Mode = 'game' | 'input'

/** Everything the band shows and decides on, kept as one value. */
export type Model = {
  isOn: boolean
  /** Whether this session's on/off is settled; until then the store seeds it. */
  isSeeded: boolean
  turn: Turn
  mode: Mode
  game: Game
  board: { epoch: number; count: number }
  hasStrayKey: boolean
  isFaulted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'twenty-forty-wait': { model: Shaped<Model>; now: number }
  }
}
