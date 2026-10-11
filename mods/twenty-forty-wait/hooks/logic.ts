import type { Activity, Game, Mode, Model, StopReason, Turn } from '../types'
import { canMove, newGame, played } from './game'
import type { Move, Random } from './game'

// Types and constants

/**
 * The shape tag the model is kept under in `$.state`. A value kept under
 * another tag reads as absent. Bump it only for a change `modelOf` can't read
 * (an added field keeps the tag and gets its default), and only in a release.
 */
export const MODEL_SHAPE = 'model/1'

/** Cells on the 4×4 board. */
export const CELLS = 16

// More than any real game can hold, and far below where numbers stop being
// exact: merges never raise the sum, so play stays exact from any board kept.
const MAX_BOARD_SUM = 2 ** 30

/** A game with no tiles, before the first ones are dealt. */
export const EMPTY_GAME: Game = frozen({
  cells: new Array<number>(CELLS).fill(0),
  score: 0,
  best: 0,
  isOver: false,
  hasWon: false,
  moves: 0,
})

/** No turn seen yet. */
export const IDLE_TURN: Turn = frozen({
  turnId: '',
  phase: 'idle',
  startedAt: 0,
  endedAt: 0,
  tools: 0,
  current: null,
  recent: [],
  files: [],
  reason: '',
  hasAnswer: false,
  summary: '',
  next: '',
  lockAt: 0,
  isShown: false,
})

/** The model of a fresh install: off, idle, keys with the prompt. */
export const INITIAL_MODEL: Model = frozen({
  isOn: false,
  isSeeded: false,
  turn: IDLE_TURN,
  mode: 'input',
  game: EMPTY_GAME,
  board: { epoch: 0, count: 0 },
  hasStrayKey: false,
  isFaulted: false,
})

/** A value to keep across sessions, written after the model is committed. */
export type SaveEffect =
  | { kind: 'save'; key: 'isOn'; value: boolean }
  | { kind: 'save'; key: 'best'; value: number }

/**
 * A call to the model for a handed-back turn's summary, exactly as it is to
 * be sent; its result comes back into `afterSummary` for that turn.
 */
export type SummarizeEffect = {
  kind: 'summarize'
  turn: SummaryKey
  request: {
    model: string
    system: string
    prompt: string
    maxTokens: number
    timeoutMs: number
  }
}

/** Work a transition asks the shell to do once the model is committed. */
export type Effect = SaveEffect | SummarizeEffect

/** What a transition returns: the next model, and the effects to carry out. */
export type Step = { model: Model; effects: Effect[] }

const PHASES: readonly Turn['phase'][] = ['idle', 'running', 'done']
const REASONS: readonly StopReason[] = [
  'answer',
  'aborted',
  'refusal',
  'error',
  '',
]
const MODES: readonly Mode[] = ['game', 'input']

/** A turn this long or longer fades before it locks; a shorter one locks at once. */
export const LONG_TURN_MS = 10_000

/** How long a long turn's board stays playable while it fades. */
export const FADE_MS = 5_000

// The current call and the two before it.
const RECENT = 3
// Long enough to read, short enough for one line of the band.
const TARGET_LENGTH = 72
// The most characters in each line of a summary. Haiku is asked for under
// 120, and a line somewhat over that still shows: the card wraps it and gives
// way for it, and cuts the end only where the panel has no room left.
const SUMMARY_PART = 200
// Room for two lines at the cap even in dense text (paths, names, numbers,
// about 3 characters a token), so an answer cut off by the budget is always
// longer than two such lines, and refused rather than shown cut.
const SUMMARY_TOKENS = 250
// The reply the summary is made from: whole up to this many characters, and
// past it its beginning and its end, where it says what was done, what was
// found and what is asked.
const SUMMARY_WHOLE = 8000
const SUMMARY_HEAD = 2000
// A shorter reply is as quick to read as its summary would be, and a summary
// of it could only restate it or add to it: it isn't sent.
const SUMMARY_MIN = 200
const SUMMARY_TAIL = 6000
const SUMMARY_SYSTEM =
  'You write one- or two-line status notes for a developer glancing back at ' +
  'their terminal.'
const SUMMARY_ASK =
  'In two short lines (about 15 words each, under 200 characters in all), ' +
  'first give the gist of what was done or found, then what the developer ' +
  'should do next: review, answer its question, test, decide. Use only what ' +
  "the reply says: don't add work, changes or results it doesn't mention. " +
  'There is ' +
  'always a next step; never say nothing is needed. Plain text, no markdown. ' +
  'Reply with exactly two lines: the gist on the first, the next step on the ' +
  'second. Keep each line under 120 characters.'
const EDIT_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]

// Reading state

/**
 * The model from whatever `$.state` holds. Every field is checked, and one
 * that doesn't fit falls back to its initial value, so a value written by
 * older code, or by a forgotten shape bump, can never break the band.
 */
export function modelOf(raw: unknown): Model {
  if (!isRecord(raw)) return INITIAL_MODEL
  const board = isRecord(raw.board) ? raw.board : {}
  return {
    isOn: raw.isOn === true,
    isSeeded: raw.isSeeded === true,
    turn: turnOf(raw.turn),
    mode: oneOf(raw.mode, MODES, INITIAL_MODEL.mode),
    game: gameOf(raw.game),
    board: { epoch: countOf(board.epoch), count: countOf(board.count) },
    hasStrayKey: raw.hasStrayKey === true,
    isFaulted: raw.isFaulted === true,
  }
}

/**
 * A game from a kept value. A board that isn't 16 tiles, each 0 or a power of
 * two from 2, or that holds more than any real game could, is dropped for an
 * empty one; the best score survives if it is a score, and is never lower than
 * the game's own score. Whether the game is over, or won, comes from the board
 * itself, whatever was kept.
 */
export function gameOf(raw: unknown): Game {
  if (!isRecord(raw)) return EMPTY_GAME
  const best = countOf(raw.best)
  const cells = tilesOf(raw.cells)
  if (
    cells === null ||
    cells.reduce((sum, value) => sum + value, 0) > MAX_BOARD_SUM
  ) {
    return { ...EMPTY_GAME, best }
  }
  const score = countOf(raw.score)
  return {
    cells,
    score,
    best: Math.max(best, score),
    isOver: !canMove(cells),
    hasWon: raw.hasWon === true || cells.some(value => value >= 2048),
    moves: countOf(raw.moves),
  }
}

/**
 * The best score to keep: the higher of the kept one and the current one. A
 * kept value that isn't a score counts as none, so the result is never below
 * either.
 */
export function bestOf(kept: unknown, current: number): number {
  return Math.max(countOf(kept), countOf(current))
}

/** What a store read gave: the value kept, or that it couldn't be read. */
export type StoreRead = { isRead: true; value: unknown } | { isRead: false }

/**
 * Whether what is stored must be read before this value is written: only for
 * the best score, which may only rise. On/off is written straight away.
 */
export function isReadFirst(effect: SaveEffect): boolean {
  switch (effect.key) {
    case 'isOn':
      return false
    case 'best':
      return true
  }
}

/**
 * What to write for a value to keep, given what the store holds now, or null
 * to write nothing. On/off is this session's own choice and always written.
 * The best score is written only when it beats what is stored, which another
 * session may have raised meanwhile, and never over a store that couldn't be
 * read, where it could lower a higher one.
 */
export function writeOf(
  effect: SaveEffect,
  stored: StoreRead,
): SaveEffect | null {
  switch (effect.key) {
    case 'isOn':
      return effect
    case 'best': {
      if (!stored.isRead) return null
      const value = bestOf(stored.value, effect.value)
      return value === stored.value ? null : { ...effect, value }
    }
  }
}

// On and off

/**
 * `/fortywait`: switches the band on or off and keeps the choice for later
 * sessions; the choice is this session's from now on. Either way the keys
 * belong to the prompt; switching off also retires the board, so a board
 * drawn before can't take keys again. The band doesn't follow turns while
 * off, so switching on starts from an idle turn, with no stale card, whose
 * board waits for the next turn; it also clears a fault.
 */
export function afterToggle(model: Model): Step {
  const isOn = !model.isOn
  return {
    model: {
      ...model,
      isOn,
      isSeeded: true,
      mode: 'input',
      hasStrayKey: false,
      board: isOn ? model.board : retired(model.board),
      turn: isOn ? IDLE_TURN : model.turn,
      isFaulted: isOn ? false : model.isFaulted,
    },
    effects: [{ kind: 'save', key: 'isOn', value: isOn }],
  }
}

/**
 * A session starts, or the mod reloads. The session's own on/off stands; only
 * a session that has none yet takes it from the store, on if it was last
 * switched on. The best score is the higher of the kept one and the model's,
 * and a best the store doesn't have yet (its save failed) is saved again.
 * A session with no game yet gets a new one; a reload keeps the game as it
 * was, with no new tile. A reload also drops any board that held the keys, so
 * the keys are the prompt's and the board is retired, and new code gets a
 * fresh chance after a fault; the turn, and any lock, carry on.
 */
export function afterRestore(
  model: Model,
  kept: { isOn: unknown; best: unknown },
  random: Random,
): Step {
  const best = bestOf(kept.best, model.game.best)
  return {
    model: {
      ...model,
      isOn: model.isSeeded ? model.isOn : kept.isOn === true,
      isSeeded: true,
      mode: 'input',
      hasStrayKey: false,
      isFaulted: false,
      board: retired(model.board),
      game: dealt({ ...model.game, best }, random),
    },
    effects:
      best > bestOf(kept.best, 0)
        ? [{ kind: 'save', key: 'best', value: best }]
        : [],
  }
}

/** What `/fortywait` answers. */
export function toggleNoteOf(model: Model): string {
  return model.isOn
    ? 'Twenty Forty-Wait on. Run /fortywait again to turn it off.'
    : 'Twenty Forty-Wait off.'
}

// Turn and hand-back

/** A turn of the main loop starting, as the shell saw it. */
export type TurnStart = { turnId: string; at: number; agentId?: string }

/** A tool call, from the main loop or a subagent, as the shell saw it. */
export type ToolCall = {
  tool: string
  input: unknown
  at: number
  agentId?: string
}

/** Which turn a tool call ran in: its id and when it started. */
export type TurnKey = { turnId: string; startedAt: number }

/**
 * A tool call that has returned: whether it succeeded, and the turn it was
 * called in (null if none was running).
 */
export type ToolDone = {
  tool: string
  input: unknown
  isOk: boolean
  turn: TurnKey | null
}

/** A turn ending, as the shell saw it. */
export type TurnEnd = {
  turnId: string
  reason: string
  answer: string
  durationMs: number
  at: number
  agentId?: string
}

/**
 * A turn of the main loop starts, the person's or an automated one: the band
 * shows it live, and any lock lifts. A lock that came due before the start is
 * handed back first. The mode stays as it was otherwise. A repeated start of
 * the running turn, subagent turns, and turns while the band is off change
 * nothing.
 */
export function afterTurnStart(model: Model, start: TurnStart): Step {
  if (
    !model.isOn ||
    start.agentId !== undefined ||
    (model.turn.phase === 'running' && model.turn.turnId === start.turnId)
  ) {
    return unchanged(model)
  }
  const at = timeOf(start.at)
  return {
    model: {
      ...locked(model, at),
      turn: {
        ...IDLE_TURN,
        turnId: start.turnId,
        phase: 'running',
        startedAt: at,
        isShown: true,
      },
    },
    effects: [],
  }
}

/**
 * A tool call while a turn runs: it becomes the current call, the two before
 * it stay in view, and the count goes up. Subagents' calls count as the
 * turn's work. A main-loop call with no turn seen (the band was switched on
 * mid-turn) starts following the turn from here; a subagent's never does,
 * since it may outlive the turn.
 */
export function afterToolCall(model: Model, call: ToolCall): Step {
  const isAdopted = model.turn.phase === 'idle' && call.agentId === undefined
  if (!model.isOn || (model.turn.phase !== 'running' && !isAdopted)) {
    return unchanged(model)
  }
  const activity = callOf(call.tool, call.input)
  const turn = isAdopted
    ? {
        ...IDLE_TURN,
        phase: 'running' as const,
        startedAt: timeOf(call.at),
        isShown: true,
      }
    : model.turn
  return {
    model: {
      ...model,
      turn: {
        ...turn,
        tools: turn.tools + 1,
        current: activity,
        recent: [...turn.recent, activity].slice(-RECENT),
      },
    },
    effects: [],
  }
}

/**
 * Whether a tool call's result is a success: not refused and not an error.
 */
export function toolSucceeded(result: unknown): boolean {
  return (
    isRecord(result) && result.deny === undefined && result.isError !== true
  )
}

/** The running turn's key, which a tool call keeps to report back to; null when none runs. */
export function turnKeyOf(model: Model): TurnKey | null {
  return model.isOn && model.turn.phase === 'running'
    ? { turnId: model.turn.turnId, startedAt: model.turn.startedAt }
    : null
}

/**
 * A tool call returned. A file counts as changed only once an edit to it has
 * succeeded, each file counts once, and only for the turn the call ran in:
 * a call that outlives its turn changes nothing.
 */
export function afterToolDone(model: Model, done: ToolDone): Step {
  const input = isRecord(done.input) ? done.input : {}
  const path = input.file_path ?? input.notebook_path
  const running = turnKeyOf(model)
  if (
    running === null ||
    done.turn === null ||
    done.turn.turnId !== running.turnId ||
    done.turn.startedAt !== running.startedAt ||
    !done.isOk ||
    !EDIT_TOOLS.includes(done.tool) ||
    typeof path !== 'string' ||
    model.turn.files.includes(path)
  ) {
    return unchanged(model)
  }
  return {
    model: {
      ...model,
      turn: { ...model.turn, files: [...model.turn.files, path] },
    },
    effects: [],
  }
}

/**
 * The main loop's turn ends, for any reason: the turn is handed back. A turn of
 * 10 s or longer that ended on its own while the game has the keys, and isn't
 * over, fades for 5 s, the game still playable, and then locks; any other turn
 * locks at once (see `isLocked`): a shorter or interrupted one, one that ends
 * in input mode or on a finished game. At the lock the keys go to the prompt
 * and the board is retired. The turn's length is the longer of what the band
 * saw and what Claude Code reports, so a turn followed from mid-way is timed
 * whole. A long turn that ended normally with a reply asks the model, once, for
 * the card's summary. The late end of an older turn (one that began before the
 * turn handed back ended), a repeated end, subagent turns, and turns while the
 * band is off change nothing; a turn that began after, whose start went unseen,
 * is handed back as usual, after any lock that came due before it.
 */
export function afterTurnEnd(model: Model, end: TurnEnd): Step {
  const isRunning = model.turn.phase === 'running'
  if (
    !model.isOn ||
    end.agentId !== undefined ||
    (isRunning &&
      model.turn.turnId !== '' &&
      model.turn.turnId !== end.turnId) ||
    (model.turn.phase === 'done' &&
      (end.turnId === model.turn.turnId ||
        timeOf(end.at) - timeOf(end.durationMs) < model.turn.endedAt))
  ) {
    return unchanged(model)
  }
  const at = timeOf(end.at)
  const length = Math.max(
    isRunning ? at - model.turn.startedAt : 0,
    timeOf(end.durationMs),
  )
  const reason = oneOf(end.reason, REASONS, '')
  const isLong = length >= LONG_TURN_MS && reason !== 'aborted'
  // A lock that came due before this end is handed back first, so a fade
  // whose lock wasn't committed yet never carries the game into another.
  const due = locked(model, at)
  const ended: Model = {
    ...due,
    turn: {
      ...due.turn,
      turnId: end.turnId,
      phase: 'done',
      startedAt: Math.max(0, at - length),
      endedAt: at,
      current: null,
      reason,
      hasAnswer: end.answer.trim().length > 0,
      summary: '',
      next: '',
      lockAt: isLong ? at + FADE_MS : at,
      isShown: true,
    },
  }
  // Only a turn that ended normally with a reply long enough to need one: for
  // any other stop the reason is the news, and its placeholder already says
  // what to do. The reply is counted as the request reads it, in code points.
  const isSummarized =
    !model.isFaulted &&
    isLong &&
    reason === 'answer' &&
    Array.from(end.answer.trim()).length >= SUMMARY_MIN
  return {
    model: locked(ended, at),
    effects: isSummarized
      ? [
          {
            kind: 'summarize',
            turn: { turnId: end.turnId, endedAt: at },
            request: summaryRequestOf(end.answer),
          },
        ]
      : [],
  }
}

/**
 * Time passes: once a fading turn's lock is due, the lock takes effect and
 * holds from then on, and a board that had the keys gives them to the prompt.
 */
export function afterTick(model: Model, now: number): Step {
  return { model: locked(model, timeOf(now)), effects: [] }
}

/**
 * Whether the board is locked behind the your-turn card: a turn handed back,
 * once its fade is over, and at once while the game doesn't have the keys or
 * is over. The fade is only for finishing a move, so a turn that ends in
 * input mode or on a finished game locks as it ends, and leaving the game, or
 * the move that ends it, ends the fade.
 */
export function isLocked(model: Model, now: number): boolean {
  return (
    model.isOn &&
    model.turn.phase === 'done' &&
    model.turn.isShown &&
    (timeOf(now) >= model.turn.lockAt ||
      model.mode !== 'game' ||
      model.game.isOver)
  )
}

/**
 * Whether the board can be played: while a turn runs, and while a turn's end
 * fades with the game still on. Idle, before any turn or since the band was
 * switched on, and once locked, it can't be entered: the game is for the
 * wait, and Claude isn't working.
 */
export function isPlayable(model: Model, now: number): boolean {
  return (
    model.isOn &&
    (model.turn.phase === 'running' ||
      (model.turn.phase === 'done' &&
        model.turn.isShown &&
        !isLocked(model, now)))
  )
}

/**
 * How far the board has faded, from 0 to 1: 0 while a turn runs, rising over
 * a turn's end in the game, and 1 while the board can't be played, idle or
 * locked. Off, nothing is drawn, and it is 0.
 */
export function fadeOf(model: Model, now: number): number {
  if (!model.isOn || model.turn.phase === 'running') return 0
  if (!isPlayable(model, now)) return 1
  return Math.min(
    1,
    Math.max(0, 1 - (model.turn.lockAt - timeOf(now)) / FADE_MS),
  )
}

/**
 * Whether the band needs the clock: while the board can be played, a turn
 * runs or its end fades in the game. A faulted band draws nothing and needs
 * none.
 */
export function isTicking(model: Model, now: number): boolean {
  return !model.isFaulted && isPlayable(model, now)
}

/** Whether the band shows the time at all, so time is worth keeping: on, and not stopped by a fault. */
export function isTimeShown(model: Model): boolean {
  return model.isOn && !model.isFaulted
}

// Lifecycle

/**
 * Claude Code shows a permission prompt or a question: the dialog takes the
 * keys, so they leave the board and the board is retired. While a turn runs
 * nothing locks, and the turn's end hands back as usual; during a turn's end,
 * leaving the game ends the fade (see `isLocked`).
 */
export function afterDialog(model: Model): Step {
  if (!model.isOn) return unchanged(model)
  return { model: toPrompt(model), effects: [] }
}

/**
 * A part of the mod failed: the band stops drawing the board, the keys go to
 * the prompt and the board is retired, so nothing can keep them.
 */
export function afterFault(model: Model): Step {
  return { model: { ...toPrompt(model), isFaulted: true }, effects: [] }
}

/**
 * The band found, while drawing, that the board can't keep the keys (it has
 * no room, or a survey took the band) and drew it out. If the game still held
 * the keys under the board it saw, they go to the prompt and that board is
 * retired; otherwise the request is stale and changes nothing.
 */
export function afterHandoff(model: Model, epochSeen: number): Step {
  return model.mode === 'game' && model.board.epoch === epochSeen
    ? { model: toPrompt(model), effects: [] }
    : unchanged(model)
}

// Mode and board input

/** The board widget's key under the current epoch; input counts only from it. */
export function boardKeyOf(model: Model): string {
  return `board-${model.board.epoch}`
}

/** One input the board saw: a click on it, or a key while it had the keys. */
export type BoardInput =
  | { kind: 'click' }
  | { kind: 'key'; key: string; ctrl: boolean; shift: boolean; meta: boolean }

/**
 * What the board posts: every input not yet acknowledged, oldest first, and
 * the number of the last one. The board numbers its inputs on from the count
 * it was last acknowledged, so an input sent again keeps its number and
 * counts once. An entry that is no input is null: it takes its number and
 * changes nothing.
 */
export type BoardPost = { count: number; inputs: (BoardInput | null)[] }

/** The most inputs the board keeps unacknowledged, and so sends in one post. */
export const BOARD_BACKLOG = 64

/** The post the board sent, or null when the data isn't one. */
export function boardPostOf(data: unknown): BoardPost | null {
  if (!isRecord(data) || !Array.isArray(data.inputs)) return null
  const inputs: unknown[] = data.inputs
  const count = data.count
  return typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count >= inputs.length &&
    inputs.length <= BOARD_BACKLOG
    ? { count, inputs: Array.from(inputs, inputOf) }
    : null
}

/**
 * The board posted. A lock that came due takes effect first. Only the board
 * drawn now is heard: a post from a retired board changes nothing, nor does
 * an input counted before, so a backlog sent again applies once. A post that
 * starts past the next number lost inputs the board couldn't keep, maybe a
 * Tab, so the keys go back to the prompt and the board is retired. Inputs
 * apply in order until one hands the keys back, which retires the board and
 * drops the rest; otherwise the count acknowledged moves to the post's last.
 *
 * - A click enters the game, and a click on a finished game deals a new one,
 *   while the board can be played: a turn runs, or its end fades in the
 *   game. A click on the board otherwise, idle or locked, can't be refused,
 *   since it moves the keys itself, so the board is retired and the keys go
 *   straight back.
 * - In the game, the arrows play, also while a turn's end fades; Tab hands
 *   the keys back. Any other key, Claude Code's shortcuts included, only
 *   shows how to leave.
 * - A key while the model says the prompt has the keys means the board got
 *   them unseen: they go back, so the band and the keys agree again.
 */
export function afterBoardPost(
  model: Model,
  element: string,
  post: BoardPost,
  now: number,
  random: Random,
): Step {
  const due = locked(model, now)
  if (!due.isOn || due.isFaulted || element !== boardKeyOf(due)) {
    return unchanged(due)
  }
  const first = post.count - post.inputs.length + 1
  if (first > due.board.count + 1) return { model: toPrompt(due), effects: [] }
  let current = due
  let effects: Effect[] = []
  for (const [k, input] of post.inputs.entries()) {
    if (input === null || first + k <= due.board.count) continue
    const step = afterInput(current, input, now, random)
    current = step.model
    effects = [
      ...effects.filter(
        kept =>
          !step.effects.some(
            e =>
              e.kind === 'save' && kept.kind === 'save' && e.key === kept.key,
          ),
      ),
      ...step.effects,
    ]
    if (current.board.epoch !== due.board.epoch) {
      return { model: current, effects }
    }
  }
  return post.count > current.board.count
    ? {
        model: { ...current, board: { ...current.board, count: post.count } },
        effects,
      }
    : { model: current, effects }
}

/** Activity in the prompt box: an edit, or a prompt submitted from somewhere. */
export type PromptActivity =
  { kind: 'edit' } | { kind: 'submit'; origin: string }

/**
 * The person used the prompt box while the model still gives the game the
 * keys: they left the board in a way Claude Code doesn't report (Esc, a click
 * on the prompt, Ctrl+C while idle, collapsing the band), and the band shows
 * input mode from now on; during a turn's end that also ends the fade. The
 * board isn't retired: the keys already left it, and a click on it right
 * after must still count while a turn runs. A prompt from anywhere but
 * the person's own typing (a notification, a peer, a plugin) says nothing
 * about the keys.
 */
export function afterPrompt(model: Model, activity: PromptActivity): Step {
  const isTyped = activity.kind === 'edit' || activity.origin === 'composer'
  if (model.mode !== 'game' || !isTyped) return unchanged(model)
  return {
    model: { ...model, mode: 'input', hasStrayKey: false },
    effects: [],
  }
}

// Card text

/** The model's summary for the card: what Claude did, and the next step. */
export type Summary = { line: string; next: string }

/**
 * Which handed-back turn a summary is for: its id and when it ended, so a
 * summary never lands on another turn, even one that reuses the id.
 */
export type SummaryKey = { turnId: string; endedAt: number }

/**
 * What the model is asked for a summary: its instructions, and Claude's final
 * reply, nothing else. A reply of up to 8,000 characters goes whole; a longer
 * one as its first 2,000 and last 6,000, with a mark where its middle is left
 * out, so nothing is sent twice. It is cut between characters, never inside
 * one. The token budget holds two lines at the cap even in dense text, so an
 * answer the budget cut off is always too long for the card to accept.
 */
export function summaryRequestOf(answer: string): SummarizeEffect['request'] {
  const characters = Array.from(answer.trim())
  const reply =
    characters.length <= SUMMARY_WHOLE
      ? `The assistant's final reply:\n\n${characters.join('')}`
      : "The beginning and the end of the assistant's final reply, with its " +
        `middle left out:\n\n${characters.slice(0, SUMMARY_HEAD).join('')}` +
        `\n\n[… the middle of the reply is left out …]\n\n` +
        characters.slice(-SUMMARY_TAIL).join('')
  return {
    model: 'haiku',
    system: SUMMARY_SYSTEM,
    prompt: `${SUMMARY_ASK}\n\n${reply}`,
    maxTokens: SUMMARY_TOKENS,
    timeoutMs: 20_000,
  }
}

/**
 * A summary from the model, fit for the card: answered, and exactly two
 * lines, the gist and the next step, each non-empty and at most 200
 * characters, for the card to wrap. Its words are not judged. Markdown
 * emphasis, list marks (arrows too) and labels such as "Gist:" or "Next:"
 * are dropped.
 * Otherwise null, and the card shows the placeholder.
 */
export function summaryOf(result: unknown): Summary | null {
  if (!isRecord(result) || result.isAnswered !== true) return null
  const lines = textOf(result.text)
    .split(/\r?\n/)
    .map(line =>
      line
        .replace(/\*\*|__|`/g, '')
        .replace(/^\s*(?:#+|[-*•→]|->|\d+[.)])\s+/, '')
        .replace(
          /^\s*(?:summary|gist|done|did|result|what (?:claude )?did|next(?:\s+step)?)\s*:\s*/i,
          '',
        )
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(line => line.length > 0)
  const [line = '', next = ''] = lines
  return lines.length !== 2 ||
    Array.from(line).length > SUMMARY_PART ||
    Array.from(next).length > SUMMARY_PART
    ? null
    : { line, next }
}

/**
 * The model's summary arrives for a turn. It is shown only if it is a usable
 * summary, the band is on, and that turn, by its id and end, is still the one
 * handed back, so a late summary never lands on another turn's card.
 */
export function afterSummary(
  model: Model,
  turn: SummaryKey,
  result: unknown,
): Step {
  const summary = summaryOf(result)
  return summary !== null &&
    model.isOn &&
    model.turn.phase === 'done' &&
    model.turn.turnId === turn.turnId &&
    model.turn.endedAt === turn.endedAt
    ? {
        model: {
          ...model,
          turn: { ...model.turn, summary: summary.line, next: summary.next },
        },
        effects: [],
      }
    : unchanged(model)
}

/**
 * The card's line when there is no summary: a fixed sentence for how the turn
 * ended, always ending in the next step. Claude's answer itself never shows.
 */
export function placeholderOf(turn: Turn): string {
  if (turn.reason === 'aborted') return 'Interrupted — your turn.'
  if (turn.reason === 'refusal') {
    return 'Claude declined — your turn: read why and rephrase.'
  }
  if (turn.reason === 'error') {
    return 'Stopped on an error — your turn: check the transcript.'
  }
  return turn.reason === 'answer' && turn.hasAnswer
    ? 'Claude finished — your turn: read the reply.'
    : 'Stopped without a reply — your turn.'
}

// View models

/**
 * The card shown when the turn is handed back, row by row: the heading, the
 * stats, the summary as one paragraph and the files changed. When the
 * paragraph needs more rows than are left, the files give way first, then
 * the stats join the heading, so the card never takes more rows than it has.
 */
export type CardView = {
  heading: string
  /** The stats row, or null once the stats joined the heading. */
  stats: string | null
  /** The paragraph, whole, and as drawn: word-wrapped to its rows. */
  text: string
  rows: string[]
  /** The files changed, or null once their row gave way. */
  files: string | null
}

/** Where the card or the live view is drawn: its width, and the rows it has. */
export type SideRoom = { width: number; rows: number }

// A side of any width, and a card's usual rows: the band cuts each row.
const WIDE: SideRoom = { width: Number.POSITIVE_INFINITY, rows: 5 }

/**
 * The live view of a turn, or the idle line before any turn. Its tone says
 * how the first row is drawn: plain while Claude works, as a banner while a
 * turn's end fades (the only time the band warns), and dim while idle. Then
 * come the rows that matter now, and dimmer ones under them.
 */
export type StatusView = {
  tone: 'working' | 'waiting' | 'idle'
  headline: string
  current: string[]
  before: string[]
}

/**
 * Where the band is drawn: its body columns, the rows the engine lets it take,
 * whether the terminal is fullscreen (unknown counts as not), and whether a
 * Claude Code survey holds the band.
 */
export type Room = {
  columns: number
  maxRows: number
  isFullscreen?: boolean
  hasSurvey?: boolean
}

/**
 * The band's bottom row: where the keys go and how to switch, or an empty
 * line when the card already says it, and then the row isn't drawn. This
 * row is highlighted while the game has the keys, and dimmed otherwise; the
 * tiles never dim for the mode, only for the turn: dimming step by step over
 * a turn's end, and grey while the board can't be played, idle or locked.
 */
export type ModeView = { line: string; isActive: boolean }

/**
 * How the board's frame is drawn: highlighted while the model gives the game
 * the keys, the fade's warning while a turn's end fades with the game on, and
 * dim otherwise. Like the mode row, it follows the mode the model knows, so
 * after Esc or a prompt click it changes at the first edit or send.
 */
export type Frame = 'game' | 'fade' | 'dim'

/**
 * The minimized band: one line whose head shows the state, drawn in its
 * tone as the full band draws it (the live view's first row, or the card's
 * heading), and a tail that says the rest needs more rows, then, on the
 * card's line, its paragraph.
 */
export type MinimizedView = {
  kind: 'minimized'
  tone: StatusView['tone'] | 'card'
  head: string
  tail: string
}

/**
 * What the band draws: nothing, one minimized line, the full band with the
 * board.
 */
export type BandView =
  | { kind: 'none' }
  | MinimizedView
  | {
      kind: 'full'
      direction: 'row' | 'column'
      status: StatusView | null
      card: CardView | null
      board: BoardView
      /** The board widget's key, and the count of its inputs acknowledged. */
      boardKey: string
      count: number
      frame: Frame
      mode: ModeView
    }

/** Body columns from which the board and the activity sit side by side. */
export const ROW_COLUMNS = 64

/** Columns between the board and the card or live view beside it. */
export const SIDE_GAP = 2

/** Columns the board takes: four 6-column tiles, a column between each, and its frame. */
export const BOARD_COLUMNS = 29

// Rows each part of the band takes, as the band draws them: the board in its
// frame with its caption row, the card or the live view, and the mode row,
// the band's bottom row.
const BOARD_ROWS = 7
const SIDE_ROWS = 5
const MODE_ROWS = 1

// What the one-line view says after the state: how to see the rest.
const ONE_LINE_HINT = ' · more rows show the game'

/**
 * The rows the full band takes: the board beside the card or live view, or
 * above it when narrow, and the mode row under both. Behind the card the band
 * draws no mode row and takes a row fewer, but the count keeps it, so the band
 * doesn't turn to one line and back as the card comes and goes.
 */
export function bandRowsOf(direction: 'row' | 'column'): number {
  const body =
    direction === 'row'
      ? Math.max(BOARD_ROWS, SIDE_ROWS)
      : BOARD_ROWS + SIDE_ROWS
  return body + MODE_ROWS
}

/**
 * The card for a turn handed back: how long it took and what it did, then
 * the summary as one paragraph, word-wrapped over the rows it needs in the
 * room's width, so it reads in full. Only when the paragraph needs more rows
 * than the heading, the stats and the files leave do the files give way, and
 * then the stats join the heading in short; where even that isn't enough,
 * the paragraph ends where the band cuts it.
 */
export function cardOf(turn: Turn, room: SideRoom = WIDE): CardView {
  const count = turn.files.length
  const elapsed = elapsedText(turn.endedAt - turn.startedAt)
  const text = paragraphOf(turn)
  const needed = rowsOf(text, room.width)
  const isFilesShown = needed <= room.rows - 3
  const isStatsJoined = needed > room.rows - 2
  const rows = wrapped(text, {
    width: room.width,
    rows: Math.max(1, room.rows - (isStatsJoined ? 1 : isFilesShown ? 3 : 2)),
  })
  return {
    heading: isStatsJoined
      ? `✓ YOUR TURN · ${elapsed} · ${plural(turn.tools, 'tool')} · ${plural(count, 'file')}`
      : '✓ YOUR TURN',
    stats: isStatsJoined
      ? null
      : `${elapsed} · ${plural(turn.tools, 'tool call')} · ${plural(count, 'file')} changed`,
    text,
    rows,
    files: isFilesShown
      ? turn.files.map(path => oneLine(shortPath(path))).join('  ')
      : null,
  }
}

/**
 * The summary as one plain paragraph: the gist, then the next step, each a
 * sentence of its own; or, with no summary, the placeholder for how the turn
 * ended, whole.
 */
export function paragraphOf(turn: Turn): string {
  return turn.summary.length > 0
    ? `${sentenceOf(turn.summary)} ${sentenceOf(turn.next)}`
    : placeholderOf(turn)
}

// A sentence: its first letter capitalized, after any opening quote or
// bracket, and a full stop unless it already ends in one, a question or
// exclamation mark or an ellipsis (closing quotes or brackets after it
// included).
function sentenceOf(text: string): string {
  const sentence = text.replace(
    /^([\p{Ps}\p{Pi}"']*)(\p{Ll})/u,
    (_, opening: string, letter: string) => opening + letter.toUpperCase(),
  )
  return /[.!?…][\p{Pe}\p{Pf}"']*$/u.test(sentence) ? sentence : `${sentence}.`
}

/**
 * The live view: idle before any turn, the running turn's work, or the wait
 * before a lock, its banner in the words that fit the room's width.
 */
export function statusOf(
  model: Model,
  now: number,
  room: SideRoom = WIDE,
): StatusView {
  const turn = model.turn
  if (turn.phase === 'running') {
    return {
      tone: 'working',
      headline: `● Claude is working · ${elapsedText(timeOf(now) - turn.startedAt)} · ${plural(turn.tools, 'tool call')}`,
      current: [
        turn.current === null
          ? 'thinking…'
          : `${turn.current.tool}  ${turn.current.target}`.trimEnd(),
      ],
      before: turn.recent
        .slice(0, -1)
        .slice(-(RECENT - 1))
        .map(call => `${call.tool}  ${call.target}`.trimEnd()),
    }
  }
  if (turn.phase === 'done' && turn.isShown) {
    const left = Math.max(1, Math.ceil((turn.lockAt - timeOf(now)) / 1000))
    // Under the banner, the paragraph wraps as on the card, over the rest.
    return {
      tone: 'waiting',
      headline: bannerOf(left, room.width),
      current: wrapped(paragraphOf(turn), {
        width: room.width,
        rows: Math.max(1, room.rows - 1),
      }),
      before: [],
    }
  }
  return {
    tone: 'idle',
    headline: "No activity yet · Claude's work shows here",
    current: [],
    before: [],
  }
}

/**
 * The band for this moment and this room. Off, after a fault, or while a
 * survey holds the band, it draws nothing. With room it
 * draws the board beside the live view or the card, or above it when narrow;
 * without room the whole band shrinks to one line.
 */
export function bandOf(model: Model, now: number, room: Room): BandView {
  if (!model.isOn || model.isFaulted || room.hasSurvey === true) {
    return { kind: 'none' }
  }
  const isCardShown = isLocked(model, now)
  const direction = room.columns >= ROW_COLUMNS ? 'row' : 'column'
  const isRoomy =
    fits(bandRowsOf(direction), room) && room.columns >= BOARD_COLUMNS
  if (!isRoomy) {
    // The hint comes right after the state, so the band cuts what follows it
    // rather than the hint. The fade's banner takes the form that leaves the
    // hint its room, and the card's paragraph follows only where there is a
    // column past the hint, so the cut's ellipsis never lands on it. Below
    // 37 columns, and on the working and idle lines, whose state is fixed,
    // the hint can still be cut.
    const status = statusOf(model, now, {
      width: room.columns - ONE_LINE_HINT.length,
      rows: SIDE_ROWS,
    })
    const heading = '✓ YOUR TURN'
    return isCardShown
      ? {
          kind: 'minimized',
          tone: 'card',
          head: heading,
          tail:
            room.columns > heading.length + ONE_LINE_HINT.length
              ? `${ONE_LINE_HINT} · ${paragraphOf(model.turn)}`
              : ONE_LINE_HINT,
        }
      : {
          kind: 'minimized',
          tone: status.tone,
          head: status.headline,
          tail: ONE_LINE_HINT,
        }
  }
  // Beside the board the card has the board's rows, so the board and the
  // card keep their height; under it, the card's own, at the band's width.
  const side: SideRoom =
    direction === 'row'
      ? { width: room.columns - BOARD_COLUMNS - SIDE_GAP, rows: BOARD_ROWS }
      : { width: room.columns, rows: SIDE_ROWS }
  return {
    kind: 'full',
    direction,
    status: isCardShown ? null : statusOf(model, now, side),
    card: isCardShown ? cardOf(model.turn, side) : null,
    board: boardOf(model.game, fadeOf(model, now)),
    boardKey: boardKeyOf(model),
    count: model.board.count,
    frame: frameOf(model, now),
    mode: modeOf(model, now),
  }
}

/** The board's frame: the game's while it has the keys, the fade's while a turn's end fades in the game, dim otherwise. */
export function frameOf(model: Model, now: number): Frame {
  if (model.mode !== 'game' || !isPlayable(model, now)) return 'dim'
  return model.turn.phase === 'done' ? 'fade' : 'game'
}

/**
 * The mode row: when the board can't be played, none behind the card, which
 * already says it's your turn, or that the board waits for Claude while idle;
 * in the game, the move to finish during a turn's end, which already says how
 * to leave, and otherwise the arrows, or how to leave after a stray key; or
 * the prompt, where a finished game says a click deals a new one.
 */
export function modeOf(model: Model, now: number): ModeView {
  if (!isPlayable(model, now)) {
    return {
      line: isLocked(model, now) ? '' : '○ playable while Claude works',
      isActive: false,
    }
  }
  if (model.mode !== 'game') {
    return {
      line: model.game.isOver
        ? '▶ click the board for a new game'
        : '▶ click the board to play',
      isActive: false,
    }
  }
  if (model.turn.phase === 'done') {
    return { line: '● GAME · finish your move · Tab to type', isActive: true }
  }
  return model.hasStrayKey
    ? { line: '⌨ keys are in the game · Tab to type', isActive: true }
    : { line: '● GAME · arrows play · Tab to type', isActive: true }
}

/**
 * The board whose keys drawing this view must hand back, by its epoch: the
 * game held them, but the board isn't drawn (minimized, off, faulted, or a
 * survey). Null when nothing needs handing back.
 */
export function handoffOf(model: Model, view: BandView): number | null {
  return model.mode === 'game' && view.kind !== 'full'
    ? model.board.epoch
    : null
}

/** A short line for a tool call: the tool and what it works on; Bash shows its description, never the command. */
export function callOf(tool: string, input: unknown): Activity {
  const given = isRecord(input) ? input : {}
  const text = (key: string) =>
    typeof given[key] === 'string' ? (given[key] as string) : undefined
  const path = text('file_path') ?? text('notebook_path') ?? text('path')
  const target =
    text('description') ??
    (path !== undefined ? shortPath(path) : undefined) ??
    (tool === 'Bash'
      ? 'a shell command'
      : (text('pattern') ?? text('url') ?? text('query') ?? ''))
  return { tool, target: firstLineOf(target).slice(0, TARGET_LENGTH) }
}

/** Elapsed time as people read it: 45s, 2m 05s. */
export function elapsedText(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

// The game

/**
 * The model with a game that came out of play. The best score never goes
 * down, and whenever it rises it is kept for later sessions.
 */
export function afterGame(model: Model, game: Game): Step {
  const best = Math.max(model.game.best, game.best, game.score)
  return {
    model: { ...model, game: { ...game, best } },
    effects:
      best > model.game.best
        ? [{ kind: 'save', key: 'best', value: best }]
        : [],
  }
}

// The board

/** One cell as the board draws it. An empty cell has no colours of its own. */
export type Tile = {
  text: string
  background: string
  color: string
  isEmpty: boolean
}

/** What the board draws: 16 tiles, row by row, the scores, and whether the game is over. */
export type BoardView = {
  tiles: Tile[]
  score: number
  best: number
  isOver: boolean
  /** The row under the board: the scores, and whether the game is over. */
  caption: string
}

/**
 * What the board widget is handed: its view, how its frame is drawn, and how
 * many of its inputs the model has counted, so it resends only the rest and
 * numbers on from there.
 */
export type BoardProps = BoardView & { frame: Frame; count: number }

// The classic 2048 tile colours, anything past 2048 dark. A few are nudged
// slightly (4, 16, 256, 512, 2048) so that a terminal with only 256 colours,
// which rounds each to its nearest, still gives every value a shade of its
// own.
const TILE_COLORS: Readonly<Record<number, string>> = frozen({
  2: '#eee4da',
  4: '#ede6c8',
  8: '#f2b179',
  16: '#e59563',
  32: '#f67c5f',
  64: '#f65e3b',
  128: '#edcf72',
  256: '#e5cc61',
  512: '#e5c84c',
  1024: '#edc53f',
  2048: '#edb22e',
})
const HIGH_TILE = '#3c3a32'
// Tiles blend toward this grey over a turn's end and reach it at the lock:
// every tile up to 2048 darkens, and the darker ones past it lighten a
// little. Locked and idle, every tile is this grey with its number in the
// lighter grey, so values are told apart by their numbers alone.
const LOCKED_GREY = '#4a4a4a'
const LOCKED_INK = '#9a9a9a'
const INKS = ['#000000', '#ffffff'] as const

/**
 * The board's view of a game. Tiles keep the classic colours and blend toward
 * a dark grey as `fade` goes from 0 to 1. Until then each tile's label is black
 * or white, whichever reads better on its tile, so it stays legible at every
 * step and on a dark or light theme; at 1, where the board can't be played,
 * every tile is that grey with a lighter grey label. Empty cells carry no
 * colours: they are drawn in the theme's own text colour. Every value is
 * defined, whatever the game held.
 */
export function boardOf(game: Game, fade: number): BoardView {
  const amount = Number.isFinite(fade) ? Math.min(1, Math.max(0, fade)) : 0
  const score = countOf(game.score)
  const best = countOf(game.best)
  const isOver = game.isOver === true
  return {
    tiles: Array.from({ length: CELLS }, (_, at) =>
      tileOf(game.cells[at], amount),
    ),
    score,
    best,
    isOver,
    caption: `${isOver ? 'game over · ' : ''}score ${score} · best ${best}`,
  }
}

// Helpers

function unchanged(model: Model): Step {
  return { model, effects: [] }
}

// One input from the board drawn now; see afterBoardPost.
function afterInput(
  model: Model,
  input: BoardInput,
  now: number,
  random: Random,
): Step {
  if (input.kind === 'click') {
    if (!isPlayable(model, now)) return { model: toPrompt(model), effects: [] }
    const playing = { ...model, mode: 'game' as const, hasStrayKey: false }
    if (model.game.isOver) {
      return afterGame(playing, newGame(model.game.best, random))
    }
    return model.mode === 'game' ? unchanged(model) : unchanged(playing)
  }
  if (model.mode !== 'game' || isTab(input)) {
    return { model: toPrompt(model), effects: [] }
  }
  const move = moveOf(input)
  if (move === null) {
    return model.hasStrayKey
      ? unchanged(model)
      : unchanged({ ...model, hasStrayKey: true })
  }
  const game = played(model.game, move, random)
  if (game === model.game) {
    return model.hasStrayKey
      ? unchanged({ ...model, hasStrayKey: false })
      : unchanged(model)
  }
  return afterGame({ ...model, hasStrayKey: false }, game)
}

// A key's modifiers are each absent, true or false; anything else makes the
// entry no input, so a malformed modified key can never pass for a bare one.
function inputOf(raw: unknown): BoardInput | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'click') return { kind: 'click' }
  if (raw.kind !== 'key' || typeof raw.key !== 'string') return null
  const flags = [raw.ctrl, raw.shift, raw.meta]
  if (!flags.every(flag => flag === undefined || typeof flag === 'boolean')) {
    return null
  }
  return {
    kind: 'key',
    key: raw.key,
    ctrl: raw.ctrl === true,
    shift: raw.shift === true,
    meta: raw.meta === true,
  }
}

const MOVES: readonly Move[] = ['up', 'down', 'left', 'right']

// The arrow a key plays: a bare arrow key. With a modifier it is no move.
function moveOf(input: Extract<BoardInput, { kind: 'key' }>): Move | null {
  const move = MOVES.find(name => name === input.key)
  return move !== undefined && !isModified(input) ? move : null
}

// Tab alone; Shift+Tab is Claude Code's, and does nothing in the game.
function isTab(input: Extract<BoardInput, { kind: 'key' }>): boolean {
  return input.key === 'tab' && !isModified(input)
}

function isModified(input: Extract<BoardInput, { kind: 'key' }>): boolean {
  return input.ctrl || input.shift || input.meta
}

// The keys to the prompt: input mode, no stray-key hint, the board retired.
function toPrompt(model: Model): Model {
  return {
    ...model,
    mode: 'input',
    hasStrayKey: false,
    board: retired(model.board),
  }
}

// Once the lock is due it takes effect: it holds from then on, even if the
// clock steps back (lockAt 0), and a board that still had the keys gives them
// up.
function locked(model: Model, now: number): Model {
  if (!isLocked(model, now) || model.turn.lockAt === 0) return model
  const latched = { ...model, turn: { ...model.turn, lockAt: 0 } }
  return model.mode === 'game' ? toPrompt(latched) : latched
}

// The band fits when its layout's rows fit its budget. In fullscreen the
// engine already keeps the band to the bottom slot, so the budget is all of
// `maxRows`; on the main screen `maxRows` is the whole terminal, of which the
// band takes at most a third, so Claude's output keeps the rest.
function fits(rows: number, room: Room): boolean {
  const budget =
    room.isFullscreen === true ? room.maxRows : Math.floor(room.maxRows / 3)
  return rows <= budget
}

// The fade's banner in the longest words that fit the width it has, so the
// countdown always shows: the full sentence, then a shorter one, then the
// countdown alone, which is cut only where nothing else would fit either.
function bannerOf(left: number, width: number): string {
  const forms = [
    `Claude is waiting for you · the board locks in ${left}s`,
    `Claude is waiting · locks in ${left}s`,
    `locks in ${left}s`,
  ]
  return forms.find(form => form.length <= width) ?? `locks in ${left}s`
}

// The rows a text takes broken at spaces in the width.
function rowsOf(text: string, width: number): number {
  return wrapped(text, { width, rows: Number.POSITIVE_INFINITY }).length
}

// A text broken at spaces into rows of the width, at most `rows` of them;
// whatever doesn't fit goes on the last row, where the band cuts it.
function wrapped(text: string, room: SideRoom): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ').filter(part => part.length > 0)) {
    if (row.length === 0) {
      row = word
    } else if (
      row.length + 1 + word.length <= room.width ||
      rows.length >= room.rows - 1
    ) {
      row = `${row} ${word}`
    } else {
      rows.push(row)
      row = word
    }
  }
  return [...rows, row]
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(part => part.length > 0)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

// Line breaks and other control characters become spaces.
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

function firstLineOf(text: string): string {
  return (text.split('\n')[0] ?? '').trim()
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function dealt(game: Game, random: Random): Game {
  return game.cells.some(value => value !== 0)
    ? game
    : newGame(game.best, random)
}

// The 16 tiles of a kept board, or null when it isn't one. Array.from reads
// holes as undefined, which is not a tile.
function tilesOf(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== CELLS) return null
  const values: unknown[] = Array.from(raw)
  return values.every(isTile) ? (values as number[]) : null
}

function tileOf(value: unknown, fade: number): Tile {
  if (value === 0 || !isTile(value)) {
    return { text: '·', background: '', color: '', isEmpty: true }
  }
  const tile = value as number
  const background = mixed(TILE_COLORS[tile] ?? HIGH_TILE, LOCKED_GREY, fade)
  return {
    text: tile < 1_000_000 ? String(tile) : `2^${Math.log2(tile)}`,
    background,
    color: fade >= 1 ? LOCKED_INK : inkOn(background),
    isEmpty: false,
  }
}

// Blends one #rrggbb colour toward another by `amount`, from 0 to 1.
function mixed(from: string, to: string, amount: number): string {
  const a = channelsOf(from)
  const b = channelsOf(to)
  return `#${a
    .map((value, k) => Math.round(value + ((b[k] ?? value) - value) * amount))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`
}

// The ink, black or white, with the higher contrast on a background.
function inkOn(background: string): string {
  const [dark, light] = INKS
  return contrastOf(dark, background) >= contrastOf(light, background)
    ? dark
    : light
}

// The WCAG contrast ratio of two colours, from 1 to 21.
function contrastOf(a: string, b: string): number {
  const [high, low] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

// WCAG relative luminance of a #rrggbb colour.
function luminanceOf(hex: string): number {
  const [r = 0, g = 0, b = 0] = channelsOf(hex).map(value => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function channelsOf(hex: string): number[] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function retired(board: Model['board']): Model['board'] {
  return { epoch: board.epoch + 1, count: 0 }
}

function turnOf(raw: unknown): Turn {
  if (!isRecord(raw)) return IDLE_TURN
  return {
    turnId: textOf(raw.turnId),
    phase: oneOf(raw.phase, PHASES, IDLE_TURN.phase),
    startedAt: timeOf(raw.startedAt),
    endedAt: timeOf(raw.endedAt),
    tools: countOf(raw.tools),
    current: keptActivityOf(raw.current),
    recent: listOf(raw.recent, keptActivityOf),
    files: listOf(raw.files, value =>
      typeof value === 'string' ? value : null,
    ),
    reason: oneOf(raw.reason, REASONS, IDLE_TURN.reason),
    hasAnswer: raw.hasAnswer === true,
    ...keptSummaryOf(raw.summary, raw.next),
    lockAt: timeOf(raw.lockAt),
    isShown: raw.isShown === true,
  }
}

// A summary kept in the model, read again as the model would give it; an
// empty pair when it isn't one.
function keptSummaryOf(
  summary: unknown,
  next: unknown,
): { summary: string; next: string } {
  const kept =
    typeof summary === 'string' && typeof next === 'string'
      ? summaryOf({ isAnswered: true, text: `${summary}\n${next}` })
      : null
  return kept === null
    ? { summary: '', next: '' }
    : { summary: kept.line, next: kept.next }
}

function keptActivityOf(raw: unknown): Activity | null {
  if (!isRecord(raw)) return null
  return typeof raw.tool === 'string' && typeof raw.target === 'string'
    ? { tool: raw.tool, target: raw.target }
    : null
}

function listOf<T>(raw: unknown, itemOf: (value: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(value => {
    const item = itemOf(value)
    return item === null ? [] : [item]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTile(value: unknown): boolean {
  return (
    value === 0 ||
    (Number.isSafeInteger(value) &&
      (value as number) >= 2 &&
      2 ** Math.round(Math.log2(value as number)) === value)
  )
}

function countOf(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0
}

function timeOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Deeply frozen, so a shared default can't be changed through a value that
// falls back to it.
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) frozen(item)
    Object.freeze(value)
  }
  return value
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.find(item => item === value) ?? fallback
}
