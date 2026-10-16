import type { On } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

import { boardOf, INITIAL_MODEL, MODEL_SHAPE } from '../../hooks/logic'
import type { Model } from '../../types'

tier('user')

type Kept = { shape: string; value: Model }

// Claude Code's own node in a band's tree, which draws nothing while no
// survey shows.
const ENGINE = { type: 'engine', ref: 1 }

// The game's own tree, drawn under what's beneath it.
function ownOf(drawn: unknown): { children: unknown[] } {
  return (drawn as { children: unknown[] }).children.at(-1) as {
    children: unknown[]
  }
}

// Lets the work under way finish before a test looks: the band's model moves
// one step after another, behind the events it watches.
let settle: () => Promise<void> = () => Promise.resolve()

// The session beneath the mod: the events Claude Code answers on its own,
// recorded so a test can see what the mod asked for. `kept` is the store as a
// previous session left it. `state` is the model the mod last wrote to the
// session state, and `olderState` what was there before the mod loaded. A test
// can make store reads fail or wait, make a store write fail or wait, and hold
// back the answer to the next state write or command registration. Once
// `clear` ran, the world answers the mod's session state itself.
function worldOf(
  on: On,
  kept: Record<string, unknown> = {},
  olderState?: Kept,
) {
  const heard = {
    store: new Map<string, unknown>(Object.entries(kept)),
    // Each key read from the store, in order.
    storeReads: [] as string[],
    writes: [] as { key: string; value: unknown }[],
    commands: [] as unknown[],
    logs: [] as string[],
    modelCalls: 0,
    // What the model is asked, what it answers, and an answer held back.
    modelRequests: [] as unknown[],
    modelAnswer: {
      isAnswered: false,
      reason: 'empty-reply',
      usage: {},
    } as unknown,
    heldModel: undefined as Promise<void> | undefined,
    toasts: 0,
    sounds: 0,
    stateWrites: 0,
    // Every model the mod wrote, in order, and each event Claude Code's side
    // received, as it received it.
    stateHistory: [] as Kept[],
    received: {} as Record<string, unknown[]>,
    stateReads: 0,
    edits: [] as unknown[],
    failingTool: false,
    heldTool: undefined as Promise<void> | undefined,
    failingReads: new Set<string>(),
    heldReads: new Map<string, Promise<void>>(),
    failingWrites: new Set<string>(),
    // Every write of the model is refused: a compare-and-set miss each time,
    // so the write gives up after its retries.
    isModelUnwritable: false,
    heldWrites: new Map<string, Promise<void>>(),
    heldAnswer: undefined as Promise<void> | undefined,
    // Holds only the answer to a write of this key, when set.
    heldAnswerKey: undefined as string | undefined,
    // Holds the next state write back before it lands.
    heldStateWrite: undefined as Promise<void> | undefined,
    heldRegistration: undefined as Promise<void> | undefined,
    state: undefined as Kept | undefined,
    // The session state after a `clear`, and the last version written.
    cleared: undefined as
      Map<string, { value: unknown; version: number }> | undefined,
    lastVersion: 0,
    // The periods every interval of the mod's has asked for, counted.
    periods: 0,
    clock: mock.clock(periodsCounted(on, () => (heard.periods += 1))),
    // What's drawn beneath the band.
    beneath: 'engine' as 'engine' | 'sentinel',
  }
  let older = olderState
  settle = () => heard.clock.settle()
  on('store.get', async ($, e) => {
    const key = (e as { key: string }).key
    heard.storeReads.push(key)
    if (heard.failingReads.has(key)) throw new Error('store unavailable')
    await heard.heldReads.get(key)
    return { value: heard.store.get(key) } as never
  })
  on('store.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    const held = heard.heldWrites.get(key)
    heard.heldWrites.delete(key)
    await held
    if (heard.failingWrites.delete(key)) throw new Error('disk full')
    heard.store.set(key, value)
    heard.writes.push({ key, value })
    return { value: undefined } as never
  })
  on('state.get', async ($, e, next) => {
    heard.stateReads += 1
    if (heard.cleared !== undefined) {
      const value = heard.cleared.get((e as { key: string }).key)
      return {
        value: { value: value?.value, version: value?.version ?? 0 },
      } as never
    }
    const answer = await next(e)
    // What an older version left stays there until the mod writes over it.
    if ((e as { key?: string }).key !== 'model' || older === undefined) {
      return answer
    }
    return { value: { value: older, version: 0 } } as never
  })
  on('state.set', async ($, e, next) => {
    const key = (e as { key?: string }).key
    const isModel = key === 'model'
    const before = heard.heldStateWrite
    heard.heldStateWrite = undefined
    await before
    if (isModel && heard.isModelUnwritable) {
      return { value: { isSet: false, version: 0 } } as never
    }
    heard.stateWrites += 1
    const written =
      heard.cleared === undefined
        ? await next(e)
        : clearedWrite(heard.cleared, heard, e as StateWrite)
    const version = (written as { value?: { version?: number } }).value?.version
    heard.lastVersion = Math.max(heard.lastVersion, version ?? 0)
    if (
      isModel &&
      (written as { value?: { isSet?: boolean } }).value?.isSet === true
    ) {
      heard.state = (e as { value: Kept }).value
      heard.stateHistory.push(heard.state)
      older = undefined
    }
    if (heard.heldAnswerKey !== undefined && heard.heldAnswerKey !== key) {
      return written
    }
    const held = heard.heldAnswer
    heard.heldAnswer = undefined
    await held
    return written
  })
  on('ui.log', ($, e) => {
    heard.logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('command.register', async ($, e) => {
    heard.commands.push(e)
    const held = heard.heldRegistration
    heard.heldRegistration = undefined
    await held
    return { value: {} } as never
  })
  on('session.start', () => ({ cwd: '/repo' }) as never)
  const receive = (event: string, e: unknown) => {
    heard.received[event] = [...(heard.received[event] ?? []), e]
  }
  on('turn.start', ($, e) => {
    receive('turn.start', e)
    return { turnId: e.turnId }
  })
  on('turn.complete', ($, e) => {
    receive('turn.complete', e)
    return { text: e.answer }
  })
  on('tool.call', async ($, e) => {
    receive('tool.call', e)
    if (heard.failingTool) throw new Error('tool broke')
    const held = heard.heldTool
    heard.heldTool = undefined
    await held
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.submit', ($, e) => {
    receive('prompt.submit', e)
    return { text: e.text } as never
  })
  // The prompt box: the edit's splice applied to the draft.
  on('prompt.edit', ($, e) => {
    heard.edits.push(e)
    receive('prompt.edit', e)
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length } as never
  })
  on('model.complete', async ($, e) => {
    heard.modelCalls += 1
    heard.modelRequests.push(e)
    const held = heard.heldModel
    heard.heldModel = undefined
    await held
    return { value: heard.modelAnswer } as never
  })
  on('ui.toast', () => {
    heard.toasts += 1
    return { value: undefined } as never
  })
  on('audio.play', () => {
    heard.sounds += 1
    return { value: undefined } as never
  })
  on('classic.PermissionRequest', ($, e) => {
    receive('classic.PermissionRequest', e)
    return {} as never
  })
  // What's beneath the band: Claude Code's own node, as the engine hands it
  // to the band's render, or with `beneath` 'sentinel' another mod's line
  // and button drawn over that node, as a mod beneath this one draws them.
  on('ui.render', ($, e) => {
    if (heard.beneath === 'engine') return ENGINE as never
    type Element = (props: object) => unknown
    const ui = $.ui.resolve(e as never) as unknown as Record<
      'Box' | 'Text' | 'Button',
      Element
    >
    const button = { key: 'sentinel', label: 'sentinel button', onPress() {} }
    return ui.Box({
      flexDirection: 'column',
      children: [
        ui.Text({ children: 'sentinel meter' }),
        ui.Button(button),
        ENGINE,
      ],
    }) as never
  })
  return heard
}

// The registrar the mocked clock hooks on, counting each period an interval
// asks for: `clock.every` is dispatched once per period.
function periodsCounted(on: On, count: () => void): On {
  const counted = (event: string, ...rest: unknown[]) => {
    const hook = rest.at(-1) as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]) => {
      if (event === 'clock.every') count()
      return hook(...args)
    }
    return (on as (...args: unknown[]) => unknown)(
      event,
      ...rest.slice(0, -1),
      wrapped,
    )
  }
  return counted as On
}

type StateWrite = { key: string; value: unknown; ifVersion?: number }

// A write to the session state a `clear` left: compared with the version that
// stands, where a value never written stands at 0, and landing above every
// version before it.
function clearedWrite(
  cleared: Map<string, { value: unknown; version: number }>,
  heard: { lastVersion: number },
  e: StateWrite,
): never {
  const version = cleared.get(e.key)?.version ?? 0
  if (e.ifVersion !== undefined && e.ifVersion !== version) {
    return { value: { isSet: false, version } } as never
  }
  cleared.set(e.key, { value: e.value, version: heard.lastVersion + 1 })
  return { value: { isSet: true, version: heard.lastVersion + 1 } } as never
}

// What a `/clear`, or a resume inside Claude Code, does beneath the mod: the
// session goes on under a new id whose state is empty, and no session start
// follows. The redraw that Claude Code makes then is the test's to make.
function clear(heard: ReturnType<typeof worldOf>): void {
  heard.cleared = new Map()
}

// Starts the session and lets the restore, which never holds the start up,
// finish its place in line.
async function start($: {
  session: { start: (e: never) => Promise<unknown> }
}): Promise<unknown> {
  const started = await $.session.start({
    source: 'startup',
    cwd: '/repo',
  } as never)
  await settle()
  return started
}

async function toggle($: {
  command: { run: (e: never) => Promise<unknown> }
}): Promise<string> {
  return JSON.stringify(
    await $.command.run({ command: 'fortywait', args: '' } as never),
  )
}

describe('register', () => {
  test('a fresh install starts off and writes nothing until /fortywait', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    const turn = await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
    await $.turn.complete({
      answer: 'done',
      text: 'done',
      isAborted: false,
      reason: 'answer',
      turnId: turn.turnId,
      durationMs: 30_000,
    } as never)
    expect(heard.writes).toEqual([])
    expect(heard.modelCalls).toBe(0)
    expect(heard.toasts).toBe(0)
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
  })

  test('/fortywait is offered mid-turn', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    expect(JSON.stringify(heard.commands)).toContain('"name":"fortywait"')
    expect(JSON.stringify(heard.commands)).toContain('"immediate":true')
    await $.turn.start({ text: 'long job', turnId: 't2' })
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
  })

  test('/fortywait turns it on, and again turns it off, keeping each choice', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
    expect(heard.store.get('isOn')).toBe(true)
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
    expect(heard.store.get('isOn')).toBe(false)
    expect(heard.writes).toEqual([
      { key: 'isOn', value: true },
      { key: 'isOn', value: false },
    ])
  })

  test('switched on in an earlier session, it starts on', async ($, on) => {
    worldOf(on, { isOn: true })
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
  })

  test('switched off in an earlier session, it starts off', async ($, on) => {
    worldOf(on, { isOn: false, best: 4096 })
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
  })

  test('a reload keeps this session on or off, even when another session changed the store', async ($, on) => {
    const heard = worldOf(on, { isOn: false })
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
    heard.store.set('isOn', false)
    await start($)
    expect(heard.state?.value.isOn).toBe(true)
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
  })

  test('a kept value that is not a choice starts it off', async ($, on) => {
    worldOf(on, { isOn: 'yes' })
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
  })

  test('two quick toggles are written in the order they happened', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    const replies = await Promise.all([toggle($), toggle($)])
    expect(
      replies.filter(r => r.includes('Twenty Forty-Wait on')),
    ).toHaveLength(1)
    expect(
      replies.filter(r => r.includes('Twenty Forty-Wait off')),
    ).toHaveLength(1)
    expect(heard.writes).toEqual([
      { key: 'isOn', value: true },
      { key: 'isOn', value: false },
    ])
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
  })

  test('while off, Claude Code works as without the mod', async ($, on) => {
    const heard = worldOf(on, { isOn: true })
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
    heard.writes.length = 0
    const turn = await $.turn.start({ text: 'go', turnId: 't3' })
    expect(turn).toEqual({ turnId: 't3' })
    const call = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(JSON.stringify(call)).toContain('"ok"')
    const sent = await $.prompt.submit({
      text: 'more',
      origin: { kind: 'composer' },
    } as never)
    expect(JSON.stringify(sent)).toContain('"more"')
    expect(heard.writes).toEqual([])
    expect(heard.modelCalls).toBe(0)
    expect(heard.toasts).toBe(0)
  })

  test('the band state lives in the session, under its shape', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    expect(heard.state?.shape).toBe(MODEL_SHAPE)
    expect(heard.state?.value.isOn).toBe(true)
  })

  test('state an older version kept under another shape is not read', async ($, on) => {
    const heard = worldOf(
      on,
      {},
      {
        shape: 'model/0',
        value: {
          ...INITIAL_MODEL,
          isOn: true,
          game: { ...INITIAL_MODEL.game, best: 5000 },
        },
      },
    )
    await start($)
    expect(heard.state?.value.isOn).toBe(false)
    expect(heard.state?.value.game.best).toBe(0)
    const tiles = heard.state?.value.game.cells.filter(value => value !== 0)
    expect(tiles).toHaveLength(2)
  })

  test('a toggle that lands while another is still answering keeps their order', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    let release = () => {}
    heard.heldAnswer = new Promise<void>(resolve => {
      release = resolve
    })
    const first = toggle($)
    await heard.clock.settle()
    const second = toggle($)
    await heard.clock.settle()
    release()
    await Promise.all([first, second])
    expect(heard.state?.value.isOn).toBe(false)
    expect(heard.store.get('isOn')).toBe(false)
  })

  test('a toggle during a reload is not undone by the reload', async ($, on) => {
    const heard = worldOf(on, { isOn: false })
    await start($)
    let release = () => {}
    heard.heldReads.set(
      'best',
      new Promise<void>(resolve => {
        release = resolve
      }),
    )
    const reload = start($)
    await heard.clock.settle()
    const toggled = toggle($)
    await heard.clock.settle()
    release()
    await Promise.all([reload, toggled])
    expect(heard.state?.value.isOn).toBe(true)
    expect(heard.store.get('isOn')).toBe(true)
  })

  test('the choice is restored even when the best score cannot be read', async ($, on) => {
    const heard = worldOf(on, { isOn: true })
    heard.failingReads.add('best')
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
  })

  test('a choice that cannot be saved is logged, and the next one is saved', async ($, on) => {
    const heard = worldOf(on)
    heard.failingWrites.add('isOn')
    await start($)
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
    expect(heard.logs.join('\n')).toContain('could not save')
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
    expect(heard.store.get('isOn')).toBe(false)
  })

  test('a toggle while a reload is still registering the command is not undone', async ($, on) => {
    const heard = worldOf(on, { isOn: false })
    await start($)
    let registered = () => {}
    let saved = () => {}
    heard.heldRegistration = new Promise<void>(resolve => {
      registered = resolve
    })
    heard.heldWrites.set(
      'isOn',
      new Promise<void>(resolve => {
        saved = resolve
      }),
    )
    const reload = start($)
    await heard.clock.settle()
    const toggled = toggle($)
    await heard.clock.settle()
    registered()
    await heard.clock.settle()
    saved()
    await Promise.all([reload, toggled])
    expect(heard.state?.value.isOn).toBe(true)
    expect(heard.store.get('isOn')).toBe(true)
  })

  test('a game and turn already in the session survive a reload and a toggle', async ($, on) => {
    const game = {
      cells: [2, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      score: 36,
      best: 36,
      isOver: false,
      hasWon: false,
      moves: 9,
    }
    const turn = {
      ...INITIAL_MODEL.turn,
      turnId: 't7',
      phase: 'done' as const,
      startedAt: 1000,
      endedAt: 31_000,
      tools: 4,
      reason: 'answer' as const,
      lockAt: 36_000,
      isShown: true,
    }
    const heard = worldOf(
      on,
      { isOn: true },
      {
        shape: MODEL_SHAPE,
        value: { ...INITIAL_MODEL, isOn: true, game, turn },
      },
    )
    await start($)
    // A reload hands the keys to the prompt, which ends the fade at once.
    const locked = { ...turn, lockAt: 0 }
    expect(heard.state?.value.game).toEqual(game)
    expect(heard.state?.value.turn).toEqual(locked)
    await toggle($)
    expect(heard.state?.value.game).toEqual(game)
    expect(heard.state?.value.turn).toEqual(locked)
  })

  test('a new session or restart deals a new game and keeps the best score', async ($, on) => {
    const heard = worldOf(on, { best: 4096 })
    await start($)
    const game = heard.state?.value.game
    expect(game?.cells.filter(value => value !== 0)).toHaveLength(2)
    expect(game?.score).toBe(0)
    expect(game?.best).toBe(4096)
  })

  test('a reload keeps the game exactly where it was, with no new tile', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    const dealt = heard.state?.value.game
    await start($)
    expect(heard.state?.value.game).toEqual(dealt)
  })
})

const BAND = {
  plugin: 'twenty-forty-wait',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 48,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 47 },
    view: {},
  },
} as const

type Band = {
  find: (query: { text: RegExp }) => Promise<{ text?: string } | undefined>
  redraw: () => Promise<void>
}

async function mounted(
  $: unknown,
  change: { maxRows?: number; bodyColumns?: number; hasSurvey?: boolean } = {},
  viewport?: { columns: number; rows: number; isFullscreen: boolean },
) {
  const ui = ($ as { ui: { mount: (e: unknown) => Promise<Band> } }).ui
  return ui.mount({ ...BAND, viewport, props: { ...BAND.props, ...change } })
}

async function shows(band: Band, text: RegExp): Promise<boolean> {
  await settle()
  await band.redraw()
  return (await band.find({ text })) !== undefined
}

// A reply long enough to be summarized: 200 characters or more.
const REPLY =
  'Fixed the parser. It now accepts trailing commas in arrays and objects, ' +
  'and the parser suite has a test for each case; all of them pass. Next, ' +
  'run the migration on staging and check that the import job ends cleanly.'

function ending(turnId: string, change: Record<string, unknown> = {}) {
  return {
    answer: REPLY,
    text: REPLY,
    isAborted: false,
    reason: 'answer',
    turnId,
    durationMs: 0,
    ...change,
  } as never
}

describe('the band above the prompt', () => {
  test('/fortywait shows the band at once, even mid-turn, and again hides it', async ($, on) => {
    worldOf(on)
    await start($)
    await $.turn.start({ text: 'long job', turnId: 't1' })
    const band = await mounted($)
    expect(await shows(band, /No activity yet|working/)).toBe(false)
    await toggle($)
    expect(await shows(band, /No activity yet/)).toBe(true)
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
    expect(await shows(band, /Claude is working/)).toBe(true)
    await toggle($)
    expect(await shows(band, /Claude is working|No activity yet/)).toBe(false)
  })

  test('before any turn the band says so plainly', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    expect(
      await shows(
        await mounted($),
        /No activity yet · Claude's work shows here/,
      ),
    ).toBe(true)
  })

  test('a running turn shows its current call and the two before, Bash by its description', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({
      tool: 'Read',
      file_path: '/repo/src/app/a.ts',
    } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'parse' } as never)
    await $.tool.call({
      tool: 'Bash',
      command: 'rm -rf build && make',
      description: 'Rebuild from scratch',
    } as never)
    const band = await mounted($)
    expect(await shows(band, /● Claude is working · \d+s · 3 tool calls/)).toBe(
      true,
    )
    expect(await shows(band, /Bash {2}Rebuild from scratch/)).toBe(true)
    expect(await shows(band, /Read {2}…\/app\/a\.ts/)).toBe(true)
    expect(await shows(band, /Grep {2}parse/)).toBe(true)
    expect(await shows(band, /rm -rf/)).toBe(false)
  })

  test('a long turn fades, then the clock locks it behind the card, with no sound or toast', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await clickBoard(await boardBand($))
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    const band = await mounted($)
    expect(
      await shows(band, /Claude is waiting for you · the board locks in 5s/),
    ).toBe(true)
    await heard.clock.advance(5_000)
    await heard.clock.settle()
    expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
    expect(heard.state?.value.turn.lockAt).toBe(0)
    const writes = heard.stateWrites
    await heard.clock.advance(5_000)
    await heard.clock.settle()
    expect(heard.stateWrites).toBe(writes)
    expect(await shows(band, /12s · 0 tool calls · 0 files changed/)).toBe(true)
    // Rule change: the summary or placeholder is one plain paragraph.
    expect(
      await shows(band, /^Claude finished — your turn: read the reply\.$/),
    ).toBe(true)
    expect(await shows(band, /Fixed the parser/)).toBe(false)
    expect(heard.toasts).toBe(0)
    expect(heard.sounds).toBe(0)
  })

  test('a short turn, and an interrupted one, lock at once', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await heard.clock.advance(2_000)
    await $.turn.complete(ending('t1'))
    expect(await shows(await mounted($), /✓ YOUR TURN/)).toBe(true)
    await $.turn.start({ text: 'big job', turnId: 't2' })
    await heard.clock.advance(40_000)
    await $.turn.complete(
      ending('t2', {
        reason: 'aborted',
        isAborted: true,
        answer: '',
        text: '',
      }),
    )
    const band = await mounted($)
    // Rule change: the summary or placeholder is one plain paragraph.
    expect(await shows(band, /^Interrupted — your turn\.$/)).toBe(true)
  })

  test('the next turn, the person’s or an automated one, lifts the lock', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'one', turnId: 't1' })
    await heard.clock.advance(1_000)
    await $.turn.complete(ending('t1'))
    const band = await mounted($)
    expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
    await $.turn.start({ text: '<scheduled prompt>', turnId: 't2' })
    expect(await shows(band, /Claude is working/)).toBe(true)
    expect(await shows(band, /✓ YOUR TURN/)).toBe(false)
  })

  test('a reload keeps the lock and the card', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'one', turnId: 't1' })
    await heard.clock.advance(1_000)
    await $.turn.complete(ending('t1'))
    await start($)
    expect(await shows(await mounted($), /✓ YOUR TURN/)).toBe(true)
  })

  test('with no room for the band, it shrinks to one line that says how to bring it back', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await mounted($, { maxRows: 8 })
    expect(
      await shows(band, /Claude is working .* more rows show the game/),
    ).toBe(true)
  })

  test('on the main screen the band takes up to a third of the window; in fullscreen, the whole slot', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const at = async (maxRows: number, isFullscreen: boolean) => {
      const band = await mounted(
        $,
        { maxRows },
        { columns: 105, rows: isFullscreen ? 30 : maxRows, isFullscreen },
      )
      return (await shows(band, /more rows show the game/))
        ? 'one line'
        : (await shows(band, /click the board to play/))
          ? 'full'
          : 'neither'
    }
    expect(await at(24, false)).toBe('full')
    expect(await at(23, false)).toBe('one line')
    expect(await at(8, true)).toBe('full')
    expect(await at(7, true)).toBe('one line')
  })

  test('a survey takes the band, and nothing of the mod is drawn', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    expect(
      await shows(await mounted($, { hasSurvey: true }), /No activity yet/),
    ).toBe(false)
  })

  test('a permission prompt or question passes through, and nothing locks', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
    const answer = await $.classic.PermissionRequest({
      tool_name: 'Bash',
      tool_input: { command: 'touch x' },
    } as never)
    expect(answer).toEqual({})
    const band = await mounted($)
    expect(await shows(band, /Claude is working/)).toBe(true)
    expect(await shows(band, /YOUR TURN/)).toBe(false)
  })

  test('a tool that fails on its own passes its failure on, and the band keeps going', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    heard.failingTool = true
    const failed = await $.tool
      .call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
      .then(
        () => false,
        () => true,
      )
    expect(failed).toBe(true)
    expect(heard.state?.value.isFaulted).toBe(false)
    expect(await shows(await mounted($), /Claude is working/)).toBe(true)
  })

  test('watching never holds Claude Code up: a tool call goes on while the band is still writing', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.settle()
    let release = () => {}
    heard.heldAnswer = new Promise<void>(resolve => {
      release = resolve
    })
    const call = await $.tool.call({
      tool: 'Read',
      file_path: '/repo/a.ts',
    } as never)
    expect(JSON.stringify(call)).toContain('"ok"')
    release()
  })

  test('a turn the band started following mid-way still shows its time moving', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await $.turn.start({ text: 'long job', turnId: 't1' })
    await toggle($)
    // A long call: it is still running when the time is read.
    let release = () => {}
    heard.heldTool = new Promise<void>(resolve => {
      release = resolve
    })
    const call = $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
    await heard.clock.settle()
    const band = await mounted($)
    const writes = heard.stateWrites
    await heard.clock.advance(3_000)
    // The ticker moves the time on its own, with nothing else happening.
    expect(heard.stateWrites - writes).toBeGreaterThanOrEqual(3)
    expect(await shows(band, /Claude is working · 3s/)).toBe(true)
    release()
    await call
  })

  test('while off, turns, tools and dialogs write nothing, and switching off stops the clock at once', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.settle()
    await toggle($)
    await heard.clock.settle()
    const writes = heard.stateWrites
    await heard.clock.advance(3_000)
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
    await $.classic.PermissionRequest({
      tool_name: 'Bash',
      tool_input: {},
    } as never)
    await $.turn.complete(ending('t1'))
    await $.turn.start({ text: 'again', turnId: 't2' })
    await heard.clock.advance(3_000)
    await heard.clock.settle()
    expect(heard.stateWrites).toBe(writes)
  })

  test('an edit that finishes after its turn ended does not count for the next turn', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'one', turnId: 't1' })
    let release = () => {}
    heard.heldTool = new Promise<void>(resolve => {
      release = resolve
    })
    const write = $.tool.call({
      tool: 'Write',
      file_path: '/repo/late.ts',
    } as never)
    await heard.clock.advance(1_000)
    await $.turn.complete(ending('t1'))
    await $.turn.start({ text: 'two', turnId: 't2' })
    release()
    await write
    await heard.clock.settle()
    expect(heard.state?.value.turn.turnId).toBe('t2')
    expect(heard.state?.value.turn.files).toEqual([])
  })

  test('an event between a lock’s time and the next tick commits the lock, so it holds', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clickBoard(await boardBand($))
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_500)
    await $.turn.complete(ending('t1'))
    await heard.clock.advance(5_100)
    expect(heard.state?.value.turn.lockAt).not.toBe(0)
    await $.prompt.submit({
      text: 'from a peer',
      origin: { kind: 'peer' },
    } as never)
    await heard.clock.settle()
    expect(heard.state?.value.turn.lockAt).toBe(0)
  })

  test('an edit that succeeds during its turn counts on the card', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'edit', turnId: 't1' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts' } as never)
    await heard.clock.settle()
    expect(heard.state?.value.turn.files).toEqual(['/repo/src/new.ts'])
    await $.turn.complete(ending('t1'))
    expect(await shows(await mounted($), /1 tool call · 1 file changed/)).toBe(
      true,
    )
  })

  test('no watched event waits for the band: turn start, turn end and a dialog all go on while it writes', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    const held = () => {
      let release = () => {}
      heard.heldAnswer = new Promise<void>(resolve => {
        release = resolve
      })
      return release
    }
    let release = held()
    expect(await $.turn.start({ text: 'go', turnId: 't1' })).toEqual({
      turnId: 't1',
    })
    release()
    await heard.clock.settle()
    release = held()
    await $.classic.PermissionRequest({
      tool_name: 'Bash',
      tool_input: {},
    } as never)
    release()
    await heard.clock.settle()
    release = held()
    expect(JSON.stringify(await $.turn.complete(ending('t1')))).toContain(
      'Fixed the parser',
    )
    release()
  })

  test('a turn ends at the time its end came in, even while the band is still writing', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.advance(12_000)
    let release = () => {}
    heard.heldAnswer = new Promise<void>(resolve => {
      release = resolve
    })
    await heard.clock.advance(1_000)
    await $.turn.complete(ending('t1'))
    await heard.clock.advance(3_000)
    release()
    await heard.clock.settle()
    expect(heard.state?.value.turn.endedAt).toBe(13_000)
  })

  test('seconds that pass while the band is still writing wait in line as one tick', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.settle()
    let release = () => {}
    heard.heldAnswer = new Promise<void>(resolve => {
      release = resolve
    })
    await heard.clock.advance(1_000)
    await heard.clock.advance(10_000)
    const before = heard.stateWrites
    release()
    await heard.clock.settle()
    expect(heard.stateWrites - before).toBeLessThanOrEqual(2)
  })

  test('a turn that starts while the lock is still being written keeps its clock', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'one', turnId: 't1' })
    await clickBoard(await boardBand($))
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    await heard.clock.advance(4_000)
    let release = () => {}
    heard.heldAnswerKey = 'model'
    heard.heldAnswer = new Promise<void>(resolve => {
      release = resolve
    })
    // The tick that locks the first turn is still being written…
    await heard.clock.advance(1_000)
    // …when the next turn starts.
    await $.turn.start({ text: 'two', turnId: 't2' })
    release()
    await heard.clock.settle()
    const band = await mounted($)
    const writes = heard.stateWrites
    await heard.clock.advance(3_000)
    expect(heard.stateWrites - writes).toBeGreaterThanOrEqual(3)
    expect(await shows(band, /Claude is working · 3s/)).toBe(true)
  })
})

// What a mounted band offers a test of the board.
type BoardBand = {
  find: (query: {
    type?: string
    key?: string
    text?: RegExp
  }) => Promise<{ key?: string; props: Record<string, unknown> } | undefined>
  drawn: (scope?: { in?: string }) => Promise<unknown>
  redraw: () => Promise<void>
  pointer: (event: Record<string, unknown>) => Promise<void>
  key: (event: Record<string, unknown>) => Promise<void>
  post: (data: unknown, scope?: { in?: string }) => Promise<void>
}

async function boardBand(
  $: unknown,
  change: { maxRows?: number; bodyColumns?: number } = {},
): Promise<BoardBand> {
  return (await mounted($, change)) as unknown as BoardBand
}

// The board's key as drawn now.
async function boardKey(band: BoardBand): Promise<string | undefined> {
  await settle()
  await band.redraw()
  return (await band.find({ type: 'Client' }))?.key
}

async function clickBoard(band: BoardBand): Promise<void> {
  const key = await boardKey(band)
  await band.pointer({ type: 'down', x: 3, y: 2, button: 'left', in: key })
  await settle()
}

async function press(
  band: BoardBand,
  event: Record<string, unknown>,
): Promise<void> {
  await band.key({ ...event, in: await boardKey(band) })
  await settle()
}

// The rows a drawn tree takes, as the terminal lays it out: each text is one
// row (the band cuts every text to one), but an empty text takes none; a box
// with a height takes that height; a column adds its children up, a row takes
// the tallest, a frame adds two, and a board widget takes what its module drew.
// A prop that changes a box's rows in a way this count doesn't follow fails.
async function heightOf(band: BoardBand, node: unknown): Promise<number> {
  if (typeof node !== 'object' || node === null) return 0
  const {
    type,
    props = {},
    children = [],
  } = node as {
    type?: string
    props?: Record<string, unknown>
    children?: unknown[]
  }
  if (type === 'Text') return textOf(node) === '' ? 0 : 1
  const unfollowed = Object.keys(props).filter(name =>
    /^(display|minHeight|maxHeight|flexBasis|gap|rowGap|margin|padding)/.test(
      name,
    ),
  )
  if (
    unfollowed.length > 0 ||
    (props.height !== undefined && typeof props.height !== 'number')
  ) {
    throw new Error(`heightOf can't count ${JSON.stringify(props)}`)
  }
  if (typeof props.height === 'number') return props.height
  if (type === 'Client') {
    return heightOf(band, await band.drawn({ in: String(props.key) }))
  }
  const heights = await Promise.all(
    children.map(child => heightOf(band, child)),
  )
  const inner =
    props.flexDirection === 'row'
      ? Math.max(0, ...heights)
      : heights.reduce((sum, height) => sum + height, 0)
  return inner + (props.borderStyle !== undefined ? 2 : 0)
}

// A session whose kept game is about to score: two 2s side by side.
const SCORING: Kept = {
  shape: MODEL_SHAPE,
  value: {
    ...INITIAL_MODEL,
    isOn: true,
    isSeeded: true,
    game: {
      cells: [2, 2, ...new Array<number>(14).fill(0)],
      score: 0,
      best: 0,
      isOver: false,
      hasWon: false,
      moves: 0,
    },
  },
}

describe('the board in the band', () => {
  test('the board is drawn under its epoch’s key, with the mode row as the band’s bottom row', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    const board = await band.find({ type: 'Client' })
    expect(board?.key).toBe('board-1')
    expect(board?.props.module).toBe('hooks/board.tsx')
    expect(board?.props.width).toBe(29)
    const tree = (await band.drawn()) as { children: { children?: string[] }[] }
    expect(JSON.stringify(tree.children.at(-1))).toContain(
      '▶ click the board to play',
    )
  })

  test('a click on the board gives the game the keys, and the arrows play', async ($, on) => {
    const heard = worldOf(on, {}, SCORING)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await band.redraw()
    expect(
      await band.find({ text: /● GAME · arrows play · Tab to type/ }),
    ).toBeDefined()
    expect((await band.find({ type: 'Client' }))?.props.props).toMatchObject({
      frame: 'game',
      count: 1,
    })
    await press(band, { key: 'left' })
    expect(heard.state?.value.game.cells[0]).toBe(4)
    expect(heard.state?.value.game.score).toBe(4)
    expect(heard.state?.value.board.count).toBe(2)
  })

  test('only a left-button press is a click', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    for (const event of [
      { type: 'down', button: 'right' },
      { type: 'down', button: 'middle' },
      { type: 'move' },
      { type: 'up', button: 'left' },
    ]) {
      await band.pointer({ ...event, x: 3, y: 2, in: 'board-1' })
    }
    await settle()
    expect(heard.state?.value.mode).toBe('input')
    await band.pointer({
      type: 'down',
      button: 'left',
      x: 3,
      y: 2,
      in: 'board-1',
    })
    await settle()
    expect(heard.state?.value.mode).toBe('game')
  })

  test('Tab hands the keys back and puts a new board in the band', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await press(band, { key: 'tab' })
    expect(heard.state?.value.mode).toBe('input')
    expect(await boardKey(band)).toBe('board-2')
    expect(await band.find({ text: /▶ click the board to play/ })).toBeDefined()
  })

  test('a post under a board that was retired meanwhile changes nothing', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    let release = () => {}
    heard.heldStateWrite = new Promise<void>(resolve => {
      release = resolve
    })
    // Tab, then a click on the board still drawn, before Tab has landed.
    await band.key({ key: 'tab', in: 'board-1' })
    await band.pointer({
      type: 'down',
      x: 3,
      y: 2,
      button: 'left',
      in: 'board-1',
    })
    release()
    await settle()
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.board).toEqual({ epoch: 2, count: 0 })
  })

  test('a backlog sent again applies once', async ($, on) => {
    const heard = worldOf(on, {}, SCORING)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    const post = {
      count: 2,
      inputs: [{ kind: 'click' }, { kind: 'key', key: 'left' }],
    }
    await band.post(post, { in: 'board-1' })
    await settle()
    await band.post(post, { in: 'board-1' })
    await settle()
    expect(heard.state?.value.game.moves).toBe(1)
    expect(heard.state?.value.board.count).toBe(2)
  })

  test('Claude Code’s shortcuts and letters on the board only show how to leave', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    const game = heard.state?.value.game
    for (const event of [
      { key: 'tab', shift: true },
      { key: 'o', ctrl: true },
      { key: 'r', ctrl: true },
      { key: 'pageup' },
      { key: 'x' },
    ]) {
      await press(band, event)
    }
    expect(heard.state?.value.mode).toBe('game')
    expect(heard.state?.value.hasStrayKey).toBe(true)
    expect(heard.state?.value.game).toEqual(game)
    await band.redraw()
    expect(
      await band.find({ text: /⌨ keys are in the game · Tab to type/ }),
    ).toBeDefined()
  })

  test('an edit or a typed send in the prompt shows input mode; a prompt from elsewhere doesn’t', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    expect(
      await $.prompt.submit({
        text: 'from a peer',
        origin: { kind: 'peer' },
      } as never),
    ).toEqual({ text: 'from a peer' })
    await settle()
    expect(heard.state?.value.mode).toBe('game')
    const edit = { text: 'x', cursor: 1, start: 0, end: 0, inputText: 'x' }
    const prompt = (
      $ as unknown as {
        prompt: { edit: (e: unknown) => Promise<unknown> }
      }
    ).prompt
    expect(await prompt.edit(edit)).toEqual({ text: 'xx', cursor: 1 })
    await settle()
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.board.epoch).toBe(1)
  })

  test('a typed send in the prompt shows input mode too', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await $.prompt.submit({
      text: 'next',
      origin: { kind: 'composer' },
    } as never)
    await settle()
    expect(heard.state?.value.mode).toBe('input')
  })

  test('a higher best score is kept for later sessions', async ($, on) => {
    const heard = worldOf(on, {}, SCORING)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    await press(band, { key: 'left' })
    await heard.clock.settle()
    expect(heard.store.get('best')).toBe(4)
  })

  test('a lower best never overwrites a higher one another session kept before this write', async ($, on) => {
    const heard = worldOf(on, {}, SCORING)
    await start($)
    heard.store.set('best', 9999)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    await press(band, { key: 'left' })
    await heard.clock.settle()
    expect(heard.store.get('best')).toBe(9999)
    expect(heard.writes.filter(write => write.key === 'best')).toEqual([])
  })

  test('the band takes at most the rows the fit rule counts: 8 when wide, 13 when narrow', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.settle()
    const wide = await boardBand($)
    expect(await heightOf(wide, await wide.drawn())).toBe(8)
    // The live view is shorter than the card the fit rule counts for.
    const narrow = await boardBand($, { bodyColumns: 50 })
    expect(await heightOf(narrow, await narrow.drawn())).toBeLessThanOrEqual(13)
    await $.turn.complete(ending('t1'))
    await heard.clock.settle()
    await wide.redraw()
    expect(await wide.find({ text: /✓ YOUR TURN/ })).toBeDefined()
    // Rule change: behind the card there's no mode row, so the band is a row
    // under its count.
    expect(await heightOf(wide, await wide.drawn())).toBe(7)
    await narrow.redraw()
    // Rule change: the placeholder is one row now, so the card takes 4 of the
    // 5 rows the fit rule counts. With no files changed its files row is
    // empty, which takes no row in the terminal: 3 rows, under the board,
    // with no mode row under them.
    expect(await heightOf(narrow, await narrow.drawn())).toBe(10)
  })

  test('shrunk while the game has the keys, the band draws no board and the keys go back', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    const small = await boardBand($, { maxRows: 8 })
    expect(await small.find({ type: 'Client' })).toBeUndefined()
    await settle()
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.board.epoch).toBe(2)
  })

  test('a dialog while the game has the keys hands them back, and the band returns with a new board', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await $.classic.PermissionRequest({
      tool_name: 'Bash',
      tool_input: {},
    } as never)
    await settle()
    expect(heard.state?.value.mode).toBe('input')
    expect(await boardKey(band)).toBe('board-2')
  })

  test('while off, no board is drawn', async ($, on) => {
    worldOf(on)
    await start($)
    await toggle($)
    await toggle($)
    const band = await boardBand($)
    expect(await band.find({ type: 'Client' })).toBeUndefined()
  })

  test('the board sends again what was not yet counted, and each input counts once', async ($, on) => {
    const heard = worldOf(on, {}, SCORING)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    let release = () => {}
    heard.heldStateWrite = new Promise<void>(resolve => {
      release = resolve
    })
    await band.pointer({
      type: 'down',
      x: 3,
      y: 2,
      button: 'left',
      in: 'board-1',
    })
    // The click is not counted yet when the arrow comes, so the arrow's
    // post carries the click again.
    await band.key({ key: 'left', in: 'board-1' })
    release()
    await settle()
    expect(heard.state?.value.mode).toBe('game')
    expect(heard.state?.value.game.moves).toBe(1)
    expect(heard.state?.value.board.count).toBe(2)
    await press(band, { key: 'left' })
    expect(heard.state?.value.board.count).toBe(3)
  })

  test('a board drawn again under the same key numbers on from what was counted', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const first = await boardBand($)
    await clickBoard(first)
    expect(heard.state?.value.mode).toBe('game')
    const prompt = (
      $ as unknown as {
        prompt: { edit: (e: unknown) => Promise<unknown> }
      }
    ).prompt
    await prompt.edit({
      text: 'x',
      cursor: 1,
      start: 0,
      end: 0,
      inputText: 'x',
    })
    await settle()
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.board).toEqual({ epoch: 1, count: 1 })
    // A new instance: had it numbered from 1, its click would count as old.
    const again = await boardBand($)
    await clickBoard(again)
    expect(heard.state?.value.mode).toBe('game')
    expect(heard.state?.value.board.count).toBe(2)
  })

  test('every row of the band and the board is cut to one line, in every state the band shows', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    const uncut: string[] = []
    const walk = (node: unknown, inText: boolean) => {
      if (typeof node !== 'object' || node === null) return
      const {
        type,
        props = {},
        children = [],
      } = node as {
        type?: string
        props?: Record<string, unknown>
        children?: unknown[]
      }
      if (type === 'Text' && !inText && props.wrap !== 'truncate-end') {
        uncut.push(JSON.stringify(node).slice(0, 80))
      }
      for (const child of children) walk(child, inText || type === 'Text')
    }
    const look = async (band: BoardBand) => {
      await settle()
      await band.redraw()
      walk(await band.drawn(), false)
      const key = (await band.find({ type: 'Client' }))?.key
      if (key !== undefined) walk(await band.drawn({ in: key }), false)
    }
    const band = await boardBand($)
    await look(band)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts' } as never)
    await look(band)
    await clickBoard(band)
    await look(band)
    await $.turn.complete(ending('t1'))
    await heard.clock.settle()
    expect(await band.find({ text: /new\.ts/ })).toBeDefined()
    await look(band)
    await look(await boardBand($, { maxRows: 8 }))
    await look(await boardBand($, { bodyColumns: 50 }))
    expect(uncut).toEqual([])
  })

  test('an edit in the prompt goes on exactly as typed, also while the band is still writing', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    let release = () => {}
    heard.heldStateWrite = new Promise<void>(resolve => {
      release = resolve
    })
    await band.key({ key: 'left', in: 'board-1' })
    const edit = { text: 'ab', cursor: 1, start: 1, end: 1, inputText: 'X' }
    const prompt = (
      $ as unknown as {
        prompt: { edit: (e: unknown) => Promise<unknown> }
      }
    ).prompt
    expect(await prompt.edit(edit)).toEqual({ text: 'aXb', cursor: 2 })
    expect(heard.edits.at(-1)).toMatchObject(edit)
    release()
    await settle()
    expect(heard.state?.value.mode).toBe('input')
  })

  test('a burst of edits waits in line as one', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    let release = () => {}
    heard.heldStateWrite = new Promise<void>(resolve => {
      release = resolve
    })
    await band.key({ key: 'left', in: 'board-1' })
    const prompt = (
      $ as unknown as {
        prompt: { edit: (e: unknown) => Promise<unknown> }
      }
    ).prompt
    const reads = heard.stateReads
    for (let k = 0; k < 30; k++) {
      await prompt.edit({
        text: '',
        cursor: 0,
        start: 0,
        end: 0,
        inputText: 'x',
      })
    }
    release()
    await settle()
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.stateReads - reads).toBeLessThan(10)
  })

  test('/fortywait answers at once, never waiting on a store read', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    heard.heldReads.set('isOn', new Promise<void>(() => {}))
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
    expect(heard.store.get('isOn')).toBe(true)
  })

  test('edits on both sides of a click keep their order: the last word is the edit', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    let release = () => {}
    heard.heldStateWrite = new Promise<void>(resolve => {
      release = resolve
    })
    const prompt = (
      $ as unknown as {
        prompt: { edit: (e: unknown) => Promise<unknown> }
      }
    ).prompt
    const edit = { text: '', cursor: 0, start: 0, end: 0, inputText: 'x' }
    await band.key({ key: 'left', in: 'board-1' })
    await prompt.edit(edit)
    await band.pointer({
      type: 'down',
      x: 3,
      y: 2,
      button: 'left',
      in: 'board-1',
    })
    await prompt.edit(edit)
    release()
    await settle()
    expect(heard.state?.value.mode).toBe('input')
  })

  test('a best the store lacks is saved at the next start', async ($, on) => {
    const kept: Kept = {
      shape: MODEL_SHAPE,
      value: { ...SCORING.value, game: { ...SCORING.value.game, best: 16 } },
    }
    const heard = worldOf(on, { best: 4 }, kept)
    await start($)
    await heard.clock.settle()
    expect(heard.store.get('best')).toBe(16)
  })
})

// What Haiku answers when it does: two lines.
const SUMMARY = {
  isAnswered: true,
  text: 'Fixed the parser.\nRun the tests.',
  usage: {},
}

// A turn of a minute that Claude ended on its own, with an answer.
async function longTurn(
  $: {
    turn: {
      start: (e: never) => Promise<unknown>
      complete: (e: never) => Promise<unknown>
    }
  },
  heard: { clock: { advance: (ms: number) => Promise<void> } },
  change: Record<string, unknown> = {},
) {
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await heard.clock.advance(60_000)
  await $.turn.complete(
    ending('t1', {
      answer: `I ${REPLY}`,
      ...change,
    }),
  )
}

describe('the summary on the card', () => {
  test('a long turn’s card shows Haiku’s gist and next step, made from Claude’s reply', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    await longTurn($ as never, heard)
    await heard.clock.advance(6_000)
    expect(heard.modelCalls).toBe(1)
    expect(heard.modelRequests[0]).toMatchObject({
      model: 'haiku',
      maxTokens: 250,
      timeoutMs: 20_000,
    })
    const request = heard.modelRequests[0] as { system: string; prompt: string }
    expect(request.system).toContain('status notes')
    expect(request.prompt).toContain('first give the gist')
    expect(request.prompt).toContain(
      "Use only what the reply says: don't add work, changes or results it doesn't mention.",
    )
    expect(
      request.prompt.endsWith(`The assistant's final reply:\n\nI ${REPLY}`),
    ).toBe(true)
    expect(heard.state?.value.turn).toMatchObject({
      summary: 'Fixed the parser.',
      next: 'Run the tests.',
    })
    const band = await mounted($)
    // Rule change: the summary or placeholder is one plain paragraph.
    expect(await shows(band, /^Fixed the parser\. Run the tests\.$/)).toBe(true)
  })

  test('a reply under 200 characters is not sent: its card shows the placeholder; one of 200 is summarized', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1', { answer: 'w'.repeat(199) }))
    await heard.clock.settle()
    expect(heard.modelCalls).toBe(0)
    expect(
      await shows(
        await mounted($),
        /^Claude finished — your turn: read the reply\.$/,
      ),
    ).toBe(true)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t2', { answer: 'w'.repeat(200) }))
    await heard.clock.settle()
    expect(heard.modelCalls).toBe(1)
    expect(
      await shows(await mounted($), /^Fixed the parser\. Run the tests\.$/),
    ).toBe(true)
  })

  test('a short, interrupted or empty turn asks nothing', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.advance(3_000)
    await $.turn.complete(ending('t1'))
    await longTurn($ as never, heard, {
      reason: 'aborted',
      isAborted: true,
      turnId: 't1',
    })
    await $.turn.start({ text: 'go', turnId: 't3' })
    await heard.clock.advance(60_000)
    await $.turn.complete(ending('t3', { answer: '', text: '' }))
    await heard.clock.settle()
    expect(heard.modelCalls).toBe(0)
  })

  // Rule change: the summary can't be switched off; the band off is the only
  // way to send nothing. On, the same long turn asks once (the first test of
  // this group).
  test('while the band was never switched on, no model is ever asked', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    const stateWrites = heard.stateWrites
    await longTurn($ as never, heard)
    await heard.clock.settle()
    expect(heard.modelCalls).toBe(0)
    expect(heard.stateWrites).toBe(stateWrites)
    expect(heard.writes).toEqual([])
  })

  test('switched off before its turn ends, no model is asked for it', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.advance(60_000)
    await toggle($)
    const stateWrites = heard.stateWrites
    const writes = heard.writes.length
    await $.turn.complete(ending('t1', { answer: `I ${REPLY}` }))
    await heard.clock.settle()
    expect(heard.modelCalls).toBe(0)
    expect(heard.stateWrites).toBe(stateWrites)
    expect(heard.writes).toHaveLength(writes)
  })

  // A failure stops the band even when the stop itself can't be written down:
  // the model still says all is well, but no reply goes to the model. The
  // turn's start is unseen either way, so it's long only by the length Claude
  // Code reports; with no failure, the same end asks once.
  for (const isFailing of [true, false]) {
    test(
      isFailing
        ? 'stopped by a failure it couldn’t record, the band asks no model'
        : 'with no failure, the same turn, its start unseen, asks once',
      async ($, on) => {
        const heard = worldOf(on)
        await start($)
        await toggle($)
        if (isFailing) {
          heard.isModelUnwritable = true
          await $.turn.start({ text: 'go', turnId: 't1' })
          await heard.clock.settle()
          heard.isModelUnwritable = false
          expect(heard.state?.value.isFaulted).toBe(false)
          expect(
            await shows(await mounted($), /Claude is working|No activity yet/),
          ).toBe(false)
        }
        await heard.clock.advance(60_000)
        await $.turn.complete(
          ending('t1', { answer: `I ${REPLY}`, durationMs: 60_000 }),
        )
        await heard.clock.settle()
        // The end itself was taken: the turn is handed back.
        expect(heard.state?.value.turn).toMatchObject({
          turnId: 't1',
          phase: 'done',
        })
        expect(heard.modelCalls).toBe(isFailing ? 0 : 1)
      },
    )
  }

  // Rule change: the settings are gone. Options an older install kept in
  // settings no longer reach the mod, so they change nothing: the game is
  // drawn, a long turn played in it fades, and the summary is asked for.
  test(
    'options kept from an older install change nothing: the game, the fade and the summary',
    { options: { activity: 'none', summary: false } },
    async ($, on) => {
      const heard = worldOf(on)
      heard.modelAnswer = SUMMARY
      await start($)
      await toggle($)
      await $.turn.start({ text: 'go', turnId: 't1' })
      const band = await boardBand($)
      expect(await band.find({ type: 'Client' })).toBeDefined()
      await clickBoard(band)
      expect(heard.state?.value.mode).toBe('game')
      await heard.clock.advance(60_000)
      await $.turn.complete(ending('t1', { answer: `I ${REPLY}` }))
      await heard.clock.advance(1_000)
      await band.redraw()
      expect(await band.find({ text: /locks in/ })).toBeDefined()
      expect(heard.modelCalls).toBe(1)
    },
  )

  for (const [name, answer] of [
    [
      'a failed call',
      {
        isAnswered: false,
        reason: 'api-error',
        status: 529,
        error: 'overloaded_error',
        usage: {},
      },
    ],
    [
      'an answer of three lines',
      {
        isAnswered: true,
        text: 'Fixed it.\nRun it.\nShip it.',
        usage: {},
      },
    ],
    [
      'an answer of one line',
      { isAnswered: true, text: 'One line only.', usage: {} },
    ],
  ] as const) {
    test(`${name} leaves the placeholder`, async ($, on) => {
      const heard = worldOf(on)
      heard.modelAnswer = answer
      await start($)
      await toggle($)
      await longTurn($ as never, heard)
      await heard.clock.advance(6_000)
      expect(heard.modelCalls).toBe(1)
      expect(heard.state?.value.turn.summary).toBe('')
      expect(heard.state?.value.isFaulted).toBe(false)
      expect(await shows(await mounted($), /Claude finished/)).toBe(true)
    })
  }

  test('a summary that comes back after the next turn started, or after switching off, is dropped', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    let release = () => {}
    heard.heldModel = new Promise<void>(resolve => {
      release = resolve
    })
    await longTurn($ as never, heard)
    await heard.clock.settle()
    await $.turn.start({ text: 'again', turnId: 't2' })
    release()
    await heard.clock.settle()
    expect(heard.state?.value.turn).toMatchObject({
      turnId: 't2',
      summary: '',
      next: '',
    })
    heard.heldModel = new Promise<void>(resolve => {
      release = resolve
    })
    await heard.clock.advance(60_000)
    // A reply long enough to be summarized, so the request is under way when
    // the band is switched off.
    await $.turn.complete(ending('t2', { answer: `I ${REPLY}` }))
    await heard.clock.settle()
    expect(heard.modelCalls).toBe(2)
    await toggle($)
    release()
    await heard.clock.settle()
    expect(heard.state?.value.turn).toMatchObject({
      turnId: 't2',
      phase: 'done',
      summary: '',
    })
  })

  test('only the beginning and the end of Claude’s reply leave: not its middle, the prompt, the tools or the files', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    await $.turn.start({ text: 'my private prompt words', turnId: 't1' })
    await $.tool.call({
      tool: 'Read',
      file_path: '/repo/secret/plans.md',
    } as never)
    await $.tool.call({
      tool: 'Write',
      file_path: '/repo/secret/new.ts',
    } as never)
    await heard.clock.advance(60_000)
    const answer = `Opening words. ${'a'.repeat(2500)} middle words ${'z'.repeat(6500)} Done. Run it.`
    await $.turn.complete(ending('t1', { answer }))
    await heard.clock.settle()
    const sent = JSON.stringify(heard.modelRequests)
    expect(heard.modelCalls).toBe(1)
    expect(sent).toContain('Opening words.')
    expect(sent).toContain('Done. Run it.')
    expect(sent).not.toContain('middle words')
    expect(sent).not.toContain('private prompt words')
    expect(sent).not.toContain('secret')
    expect(sent).not.toContain('Read')
  })

  test('at 80 columns a long gist gives way, files then stats, with every row cut to one line, and the band 8 rows in the fade and 7 on the card', async ($, on) => {
    const line =
      'Moved the payment retries into a background queue with backoff, so failed charges no longer block the checkout pages.'
    // Long enough that, run together, the two need 6 of the card's rows.
    const next =
      'Review the queue settings in config/payments.yml, then run the checkout and refund tests on staging before you merge the new branch tonight.'
    const heard = worldOf(on)
    heard.modelAnswer = {
      isAnswered: true,
      text: `${line}\n${next}`,
      usage: {},
    }
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($, { bodyColumns: 80 })
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(60_000)
    await $.turn.complete(ending('t1'))
    await heard.clock.advance(1_000)
    const check = async (rows: string[], height: number) => {
      const look = await lookOf(band)
      const texts = look.texts.filter(drawn => drawn.text.trim().length > 0)
      for (const drawn of texts) expect(drawn.style.wrap).toBe('truncate-end')
      const drawnRows = (await rowsOf(band)).map(row => row.trim())
      for (const row of rows) expect(drawnRows).toContain(row)
      for (const row of drawnRows) expect(row.length).toBeLessThanOrEqual(49)
      expect(await heightOf(band, await band.drawn())).toBe(height)
      return drawnRows
    }
    const fade = await check([], 8)
    expect(fade.join(' ')).toContain(line)
    await heard.clock.advance(5_000)
    // Rule change: behind the card there's no mode row, so the band is 7 rows.
    const card = await check(['✓ YOUR TURN · 1m 00s · 0 tools · 0 files'], 7)
    // Rule change: the summary or placeholder is one plain paragraph.
    expect(card.join(' ')).toContain(`${line} ${next}`)
    expect(card.some(row => /tool calls · .* changed/.test(row))).toBe(false)
  })

  test('a summary that comes back during the fade shows under the banner, and stays on the card', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clickBoard(await boardBand($))
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(60_000)
    await $.turn.complete(ending('t1'))
    await heard.clock.advance(1_000)
    expect(heard.modelCalls).toBe(1)
    const band = await mounted($)
    expect(await shows(band, /locks in/)).toBe(true)
    // Rule change: the summary or placeholder is one plain paragraph.
    expect(await shows(band, /^Fixed the parser\. Run the tests\.$/)).toBe(true)
    await heard.clock.advance(5_000)
    expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
    expect(await shows(band, /^Fixed the parser\. Run the tests\.$/)).toBe(true)
  })

  test('a next step is shown as Haiku gives it, whatever its words', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = {
      isAnswered: true,
      text: 'Fixed the parser.\nNo further action is needed.',
      usage: {},
    }
    await start($)
    await toggle($)
    await longTurn($ as never, heard)
    await heard.clock.advance(6_000)
    expect(heard.state?.value.turn.next).toBe('No further action is needed.')
    // Rule change: the summary or placeholder is one plain paragraph.
    expect(
      await shows(
        await mounted($),
        /^Fixed the parser\. No further action is needed\.$/,
      ),
    ).toBe(true)
  })

  for (const columns of [80, 120]) {
    test(`at ${columns} columns a summary of about 200 characters is drawn in full beside the board, and the band stays 7 rows`, async ($, on) => {
      const line =
        'Rewrote the config loader to read every profile at start; the stale cache bug is now fully fixed.'
      const next =
        'Run the integration tests against staging, then check that the profile switch works in the app.'
      const heard = worldOf(on)
      heard.modelAnswer = {
        isAnswered: true,
        text: `${line}\n${next}`,
        usage: {},
      }
      await start($)
      await toggle($)
      await longTurn($ as never, heard)
      await heard.clock.advance(6_000)
      const band = await boardBand($, { bodyColumns: columns })
      await settle()
      await band.redraw()
      const rows = (await rowsOf(band)).map(row => row.trim())
      const text = rows.join(' ')
      // Rule change: the gist and the next step run together.
      expect(text).toContain(`${line} ${next}`)
      // The tree keeps each row whole, so a row longer than the panel beside
      // the board is one the terminal would cut.
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(columns - 31)
      }
      // Rule change: behind the card there's no mode row.
      expect(await heightOf(band, await band.drawn())).toBe(7)
    })
  }

  test('a summary held back over off, on and a new turn with the same id is dropped', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    let release = () => {}
    heard.heldModel = new Promise<void>(resolve => {
      release = resolve
    })
    await longTurn($ as never, heard)
    await heard.clock.settle()
    await toggle($)
    await toggle($)
    await $.turn.start({ text: 'again', turnId: 't1' })
    await heard.clock.advance(2_000)
    await $.turn.complete(ending('t1'))
    await heard.clock.settle()
    release()
    await heard.clock.settle()
    expect(heard.state?.value.turn).toMatchObject({
      turnId: 't1',
      summary: '',
      next: '',
    })
  })

  // Rule change: the next step wrapped on rows of its own, after an arrow;
  // now it runs on from the gist.
  test('at 64 columns the paragraph wraps to three rows beside the board, and the band stays 7 rows', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = {
      isAnswered: true,
      text: 'Ran the command.\nCheck that output to confirm the command finished.',
      usage: {},
    }
    await start($)
    await toggle($)
    await longTurn($ as never, heard)
    await heard.clock.advance(6_000)
    const band = await boardBand($, { bodyColumns: 64 })
    await settle()
    await band.redraw()
    expect(
      await band.find({ text: /^Ran the command\. Check that$/ }),
    ).toBeDefined()
    expect(
      await band.find({ text: /^output to confirm the command$/ }),
    ).toBeDefined()
    expect(await band.find({ text: /^finished\.$/ })).toBeDefined()
    // Rule change: behind the card there's no mode row.
    expect(await heightOf(band, await band.drawn())).toBe(7)
  })
})

// The text a drawn node shows: its strings, its children's included.
function textOf(node: unknown): string {
  return typeof node === 'string'
    ? node
    : typeof node === 'object' && node !== null
      ? ((node as { children?: unknown[] }).children ?? []).map(textOf).join('')
      : ''
}

// The rows of text the band draws, top to bottom.
async function rowsOf(band: BoardBand): Promise<string[]> {
  const rows: string[] = []
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const { type, children = [] } = node as {
      type?: string
      children?: unknown[]
    }
    if (type === 'Text') rows.push(textOf(node))
    else for (const child of children) walk(child)
  }
  walk(await band.drawn())
  return rows
}

// A session that was playing while a long turn's end faded, kept in state:
// what a reload of the mod starts from.
const FADING: Kept = {
  shape: MODEL_SHAPE,
  value: {
    ...INITIAL_MODEL,
    isOn: true,
    isSeeded: true,
    mode: 'game',
    board: { epoch: 2, count: 3 },
    game: {
      cells: [2, 4, 8, 16, ...new Array<number>(12).fill(0)],
      score: 40,
      best: 64,
      isOver: false,
      hasWon: false,
      moves: 9,
    },
    turn: {
      ...INITIAL_MODEL.turn,
      turnId: 't1',
      phase: 'done',
      startedAt: 0,
      endedAt: 1000,
      reason: 'answer',
      hasAnswer: true,
      lockAt: 6000,
      isShown: true,
    },
  },
}

describe('a game kept from before', () => {
  test('a game kept from before is shown as it was', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 64 }, FADING)
    await start($)
    await heard.clock.advance(6_000)
    const band = await boardBand($)
    const board = await band.find({ type: 'Client' })
    const tiles = (
      board?.props.props as { tiles: { text: string }[] } | undefined
    )?.tiles
    expect(tiles?.slice(0, 4).map(tile => tile.text)).toEqual([
      '2',
      '4',
      '8',
      '16',
    ])
    expect(heard.state?.value.game.moves).toBe(9)
    expect(await shows(band as never, /✓ YOUR TURN/)).toBe(true)
  })
})

describe('every watched event goes on at once', () => {
  test('each observer hands its event on, unchanged, while the band’s own write is still held', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    const band = await boardBand($)
    const prompt = (
      $ as unknown as {
        prompt: { edit: (e: unknown) => Promise<unknown> }
      }
    ).prompt
    const held = async <T>(call: () => Promise<T>): Promise<T> => {
      let release = () => {}
      heard.heldStateWrite = new Promise<void>(resolve => {
        release = resolve
      })
      const result = await call()
      release()
      await heard.clock.settle()
      return result
    }
    expect(
      await held(() => $.turn.start({ text: 'go', turnId: 't1' })),
    ).toEqual({ turnId: 't1' })
    expect(
      await held(() =>
        $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never),
      ),
    ).toMatchObject({ result: 'ok' })
    // A click gives the game the keys, so each prompt event has a write to make.
    const click = (count: number) =>
      band.post(
        { count, inputs: new Array(count).fill({ kind: 'click' }) },
        { in: 'board-1' },
      )
    await held(() => click(1))
    expect(
      await held(() =>
        $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never),
      ),
    ).toEqual({ text: 'hi' })
    await held(() => click(2))
    expect(
      await held(() =>
        prompt.edit({
          text: 'x',
          cursor: 1,
          start: 1,
          end: 1,
          inputText: ' and a dictated sentence',
        }),
      ),
    ).toEqual({ text: 'x and a dictated sentence', cursor: 25 })
    expect(heard.state?.value.mode).toBe('input')
    expect(
      await held(() =>
        $.classic.PermissionRequest({
          tool_name: 'Bash',
          tool_input: {},
        } as never),
      ),
    ).toEqual({})
    expect(
      JSON.stringify(await held(() => $.turn.complete(ending('t1')))),
    ).toContain('Fixed the parser')
    // Each reached Claude Code's side exactly as it was raised.
    expect(heard.received['turn.start']).toEqual([{ text: 'go', turnId: 't1' }])
    expect(heard.received['tool.call']).toEqual([
      expect.objectContaining({ tool: 'Read', file_path: '/repo/a.ts' }),
    ])
    expect(heard.received['prompt.submit']).toEqual([
      expect.objectContaining({ text: 'hi', origin: { kind: 'composer' } }),
    ])
    expect(heard.received['prompt.edit']).toEqual([
      expect.objectContaining({
        text: 'x',
        cursor: 1,
        start: 1,
        end: 1,
        inputText: ' and a dictated sentence',
      }),
    ])
    expect(heard.received['classic.PermissionRequest']).toEqual([
      expect.objectContaining({ tool_name: 'Bash', tool_input: {} }),
    ])
    expect(heard.received['turn.complete']).toEqual([
      expect.objectContaining({ turnId: 't1', answer: REPLY }),
    ])
  })
})

describe('nothing waits on the store', () => {
  test('the session starts at once, even while a kept value can’t be read yet', async ($, on) => {
    const heard = worldOf(on)
    heard.heldReads.set('isOn', new Promise<void>(() => {}))
    expect(
      await $.session.start({ source: 'startup', cwd: '/repo' } as never),
    ).toEqual({ cwd: '/repo' })
  })

  test('/fortywait answers at once while a best score is still being saved', async ($, on) => {
    const heard = worldOf(on, {}, SCORING)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    heard.heldReads.set('best', new Promise<void>(() => {}))
    await press(band, { key: 'left' })
    expect(heard.state?.value.game.score).toBe(4)
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
    expect(heard.store.get('isOn')).toBe(false)
  })
})

describe('a summary keeps its place in line', () => {
  test('a summary that comes back while a new turn waits in line never lands on the old card', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    let releaseModel = () => {}
    heard.heldModel = new Promise<void>(resolve => {
      releaseModel = resolve
    })
    await longTurn($ as never, heard)
    await heard.clock.settle()
    const band = await boardBand($)
    let releaseWrite = () => {}
    heard.heldStateWrite = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    await band.pointer({
      type: 'down',
      x: 3,
      y: 2,
      button: 'left',
      in: 'board-1',
    })
    await $.turn.start({ text: 'next', turnId: 't2' })
    releaseModel()
    await heard.clock.settle()
    releaseWrite()
    await heard.clock.settle()
    expect(heard.state?.value.turn).toMatchObject({ turnId: 't2', summary: '' })
    expect(
      heard.stateHistory.some(kept => kept.value.turn.summary !== ''),
    ).toBe(false)
  })
})

// A plugin above the mod that reads, for each watched event, how the mod's
// own link settled and logs it: `passed` or `returned` when it handed the
// event on, never `expired` or `caught`, which would mean it held it up. It
// loads from its own source, so it names each event as a literal.
const ABOVE: Plugin = {
  name: 'above',
  tier: 'prepend',
  register: on => {
    on('turn.start', async ($, e, next) => {
      const result = await next(e)
      await $.ui.log(
        `link turn.start ${next.trace
          .filter(link => link.plugin === 'twenty-forty-wait')
          .map(link => link.outcome)
          .join(',')}`,
      )
      return result
    })
    on('tool.call', async ($, e, next) => {
      const result = await next(e)
      await $.ui.log(
        `link tool.call ${next.trace
          .filter(link => link.plugin === 'twenty-forty-wait')
          .map(link => link.outcome)
          .join(',')}`,
      )
      return result
    })
    on('prompt.edit', async ($, e, next) => {
      const result = await next(e)
      await $.ui.log(
        `link prompt.edit ${next.trace
          .filter(link => link.plugin === 'twenty-forty-wait')
          .map(link => link.outcome)
          .join(',')}`,
      )
      return result
    })
    on('prompt.submit', async ($, e, next) => {
      const result = await next(e)
      await $.ui.log(
        `link prompt.submit ${next.trace
          .filter(link => link.plugin === 'twenty-forty-wait')
          .map(link => link.outcome)
          .join(',')}`,
      )
      return result
    })
    on('classic.PermissionRequest', async ($, e, next) => {
      const result = await next(e)
      await $.ui.log(
        `link classic.PermissionRequest ${next.trace
          .filter(link => link.plugin === 'twenty-forty-wait')
          .map(link => link.outcome)
          .join(',')}`,
      )
      return result
    })
    on('turn.complete', async ($, e, next) => {
      const result = await next(e)
      await $.ui.log(
        `link turn.complete ${next.trace
          .filter(link => link.plugin === 'twenty-forty-wait')
          .map(link => link.outcome)
          .join(',')}`,
      )
      return result
    })
  },
}

describe('the mod’s own link, as a plugin above sees it', () => {
  test(
    'every observer hands its event on, never held up past its time',
    { plugins: [ABOVE] },
    async ($, on) => {
      const heard = worldOf(on)
      await start($)
      await toggle($)
      const band = await boardBand($)
      const prompt = (
        $ as unknown as {
          prompt: { edit: (e: unknown) => Promise<unknown> }
        }
      ).prompt
      const held = async (call: () => Promise<unknown>) => {
        let release = () => {}
        heard.heldStateWrite = new Promise<void>(resolve => {
          release = resolve
        })
        await call()
        release()
        await heard.clock.settle()
      }
      await held(() => $.turn.start({ text: 'go', turnId: 't1' }))
      await held(() =>
        $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never),
      )
      await held(() =>
        band.post({ count: 1, inputs: [{ kind: 'click' }] }, { in: 'board-1' }),
      )
      await held(() =>
        $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never),
      )
      await held(() =>
        band.post(
          { count: 2, inputs: [{ kind: 'click' }, { kind: 'click' }] },
          { in: 'board-1' },
        ),
      )
      await held(() =>
        prompt.edit({
          text: 'x',
          cursor: 1,
          start: 1,
          end: 1,
          inputText: 'yz',
        }),
      )
      await held(() =>
        $.classic.PermissionRequest({
          tool_name: 'Bash',
          tool_input: {},
        } as never),
      )
      await held(() => $.turn.complete(ending('t1')))
      const links = heard.logs
        .map(log => (JSON.parse(log) as { text?: string }).text ?? '')
        .filter(text => text.startsWith('link '))
      for (const event of [
        'turn.start',
        'tool.call',
        'prompt.submit',
        'prompt.edit',
        'classic.PermissionRequest',
        'turn.complete',
      ]) {
        expect(links).toContainEqual(
          expect.stringMatching(
            new RegExp(`^link ${event} (passed|returned)$`),
          ),
        )
      }
      expect(links.some(text => /expired|caught|skipped/.test(text))).toBe(
        false,
      )
    },
  )
})

describe('the whole branch, after the second look', () => {
  test('on/off choices made quickly land in the order they were made', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    let release = () => {}
    heard.heldWrites.set(
      'isOn',
      new Promise<void>(resolve => {
        release = resolve
      }),
    )
    const first = toggle($)
    const second = toggle($)
    await heard.clock.settle()
    release()
    expect(await first).toContain('Twenty Forty-Wait on')
    expect(await second).toContain('Twenty Forty-Wait off')
    await heard.clock.settle()
    expect(heard.writes.filter(write => write.key === 'isOn')).toEqual([
      { key: 'isOn', value: true },
      { key: 'isOn', value: false },
    ])
    expect(heard.store.get('isOn')).toBe(false)
  })

  test('nothing of the mod is drawn before this load has restored the session', async ($, on) => {
    // The session's band was on before this load; until the restore has run,
    // its old board must not be drawn.
    worldOf(on, { isOn: true }, SCORING)
    const early = await boardBand($)
    expect(await early.drawn()).toEqual(ENGINE)
    expect(await early.find({ type: 'Client' })).toBeUndefined()
    await start($)
    // The drawing already on screen comes back by itself once restored: no
    // redraw by hand, so a band that read nothing while hidden still updates.
    expect(await early.find({ type: 'Client' })).toBeDefined()
  })
})

// An edit in the prompt box, as the person types it.
async function typed($: unknown): Promise<void> {
  const prompt = ($ as { prompt: { edit: (e: unknown) => Promise<unknown> } })
    .prompt
  await prompt.edit({ text: '', cursor: 0, start: 0, end: 0, inputText: 'x' })
  await settle()
}

describe('playable only while Claude works', () => {
  test('fresh and switched on, the idle board is locked: a click changes nothing and the arrows move nothing', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    const band = await boardBand($)
    const game = heard.state?.value.game ?? INITIAL_MODEL.game
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.board.epoch).toBe(2)
    for (const key of ['left', 'up', 'right', 'down']) {
      await press(band, { key })
    }
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.game).toEqual(game)
    await band.redraw()
    expect(
      await band.find({ text: /○ playable while Claude works/ }),
    ).toBeDefined()
    expect(await band.find({ text: /✓ YOUR TURN/ })).toBeUndefined()
    const board = (await band.find({ type: 'Client' }))?.props.props as {
      tiles: unknown[]
      frame: string
    }
    expect(board.tiles).toEqual(boardOf(game, 1).tiles)
    expect(board.frame).toBe('dim')
  })

  test('switched on again after a finished turn, the board is idle and locked, with no card', async ($, on) => {
    // A finished game, so a click that got through would deal a new one.
    const over = {
      cells: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2],
      score: 120,
      best: 120,
      isOver: true,
      hasWon: false,
      moves: 60,
    }
    const heard = worldOf(
      on,
      {},
      {
        shape: MODEL_SHAPE,
        value: { ...INITIAL_MODEL, isSeeded: true, game: over },
      },
    )
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete(ending('t1'))
    await toggle($)
    await toggle($)
    const band = await boardBand($)
    expect(
      await shows(band as never, /No activity yet · Claude's work shows here/),
    ).toBe(true)
    expect(await shows(band as never, /✓ YOUR TURN/)).toBe(false)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.game).toEqual(over)
    expect(await shows(band as never, /○ playable while Claude works/)).toBe(
      true,
    )
  })

  test('once a turn starts, the board is playable, in input mode, and a click enters the game', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    expect(await shows(band as never, /▶ click the board to play/)).toBe(true)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
  })
})

describe('the fade is only for finishing a move', () => {
  test('a long turn that ends with the keys in the prompt shows the card at once', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    const band = await mounted($)
    expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
    expect(await shows(band, /locks in/)).toBe(false)
  })

  test('switched on mid-turn, with no tool call before a long end, the card shows at once', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await toggle($)
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1', { durationMs: 20_000 }))
    const band = await mounted($)
    expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
    expect(await shows(band, /locks in/)).toBe(false)
  })

  test('a long turn whose start was missed while the card was up shows its own card at once', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete(ending('t1'))
    await heard.clock.advance(30_000)
    await $.turn.complete(ending('t2', { durationMs: 20_000 }))
    const band = await mounted($)
    expect(await shows(band, /20s · 0 tool calls/)).toBe(true)
    expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
    expect(await shows(band, /locks in/)).toBe(false)
  })

  test('leaving the game during the fade, by Tab, an edit or a dialog, ends it at once', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    const band = await mounted($)
    const leaves: (() => Promise<unknown>)[] = [
      async () => press(await boardBand($), { key: 'tab' }),
      async () => typed($),
      async () =>
        $.classic.PermissionRequest({
          tool_name: 'Bash',
          tool_input: {},
        } as never),
    ]
    for (const [k, leave] of leaves.entries()) {
      const turnId = `t${k + 1}`
      await $.turn.start({ text: 'go', turnId })
      await clickBoard(await boardBand($))
      expect(heard.state?.value.mode).toBe('game')
      await heard.clock.advance(12_000)
      await $.turn.complete(ending(turnId))
      expect(await shows(band, /locks in 5s/)).toBe(true)
      await leave()
      expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
      expect(await shows(band, /locks in/)).toBe(false)
    }
  })

  test('a click after leaving during the fade doesn’t enter the game again', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    await press(band, { key: 'tab' })
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('input')
    expect(await shows(band as never, /✓ YOUR TURN/)).toBe(true)
  })

  test('a reload during the fade shows the card at once', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clickBoard(await boardBand($))
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    const band = await mounted($)
    expect(await shows(band, /locks in 5s/)).toBe(true)
    await start($)
    expect(await shows(band, /✓ YOUR TURN/)).toBe(true)
    expect(await shows(band, /locks in/)).toBe(false)
  })

  test('a long turn that ends in the game fades, and the arrows still play', async ($, on) => {
    const heard = worldOf(on, {}, SCORING)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    expect(await shows(band as never, /locks in 5s/)).toBe(true)
    await press(band, { key: 'left' })
    expect(heard.state?.value.game.score).toBe(4)
    await heard.clock.advance(5_000)
    expect(await shows(band as never, /✓ YOUR TURN/)).toBe(true)
  })

  test('a long turn that ends with the keys in the prompt is still summarized', async ($, on) => {
    const heard = worldOf(on)
    heard.modelAnswer = SUMMARY
    await start($)
    await toggle($)
    await longTurn($ as never, heard)
    await heard.clock.settle()
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.modelCalls).toBe(1)
    expect(await shows(await mounted($), /Fixed the parser\./)).toBe(true)
  })
})

// Every text in the band's tree, with the style it asks for: a Text's own
// props over those of the Text it sits in. It reads the tree, not the
// terminal: nothing is laid out, cut or coloured here.
type Drawn = { text: string; style: Record<string, unknown> }
function textsOf(
  node: unknown,
  inherited: Record<string, unknown> = {},
): Drawn[] {
  if (typeof node !== 'object' || node === null) return []
  const {
    type,
    props = {},
    children = [],
  } = node as {
    type?: string
    props?: Record<string, unknown>
    children?: unknown[]
  }
  const style = type === 'Text' ? { ...inherited, ...props } : {}
  const own = children.filter(child => typeof child === 'string').join('')
  return [
    ...(type === 'Text' && own.length > 0 ? [{ text: own, style }] : []),
    ...children.flatMap(child => textsOf(child, style)),
  ]
}

// The band's texts as drawn now, and the board's frame.
async function lookOf(band: BoardBand) {
  await settle()
  await band.redraw()
  const texts = textsOf(await band.drawn())
  const key = (await band.find({ type: 'Client' }))?.key
  const widget = key === undefined ? undefined : await band.drawn({ in: key })
  const frame =
    (widget as { children?: { props?: Record<string, unknown> }[] })
      ?.children?.[0]?.props ?? {}
  const styleOf = (text: RegExp) =>
    texts.find(drawn => text.test(drawn.text))?.style
  return { texts, frame, styleOf }
}

// How light a tile's #rrggbb background is: its channels' sum.
function lightOf(tile: { background: string } | undefined): number {
  const n = Number.parseInt(tile?.background.slice(1) ?? '', 16)
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)
}

// The styles each state asks for, exactly, so an extra dim or bold shows.
const ROW = { wrap: 'truncate-end' }
const DIM = { ...ROW, dimColor: true }
const GAME_ROW = { ...ROW, color: 'cyan', bold: true }
const BANNER = { ...ROW, color: 'warning', bold: true }
const HEADING = { ...ROW, color: 'green', bold: true }
const FRAME = { flexDirection: 'column', borderStyle: 'round' }

describe('the look of each state, as drawn', () => {
  test('working, the game, the fade, the lock and idle each draw in their own colours', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    const band = await boardBand($)
    const seen: Drawn[] = []
    const at = async () => {
      const look = await lookOf(band)
      seen.push(...look.texts)
      return look
    }

    const idle = await at()
    expect(
      idle.styleOf(/^No activity yet · Claude's work shows here$/),
    ).toEqual(DIM)
    expect(idle.styleOf(/^○ playable while Claude works$/)).toEqual(DIM)
    expect(idle.frame).toEqual({ ...FRAME, borderDimColor: true })

    await $.turn.start({ text: 'go', turnId: 't1' })
    const working = await at()
    expect(
      working.styleOf(/^● Claude is working · \d+s · 0 tool calls$/),
    ).toEqual(ROW)
    expect(working.styleOf(/^▶ click the board to play$/)).toEqual(DIM)
    expect(working.frame).toEqual({ ...FRAME, borderDimColor: true })

    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    const game = await at()
    expect(game.styleOf(/^● Claude is working/)).toEqual(ROW)
    expect(game.styleOf(/^● GAME · arrows play · Tab to type$/)).toEqual(
      GAME_ROW,
    )
    expect(game.frame).toEqual({ ...FRAME, borderColor: 'cyan' })

    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    const fade = await at()
    expect(
      fade.styleOf(/^Claude is waiting for you · the board locks in 5s$/),
    ).toEqual(BANNER)
    expect(fade.styleOf(/^● GAME · finish your move · Tab to type$/)).toEqual(
      GAME_ROW,
    )
    expect(fade.frame).toEqual({ ...FRAME, borderColor: 'warning' })
    // A stray key during the fade keeps the move to finish on the row.
    await press(band, { key: 'x' })
    expect(heard.state?.value.hasStrayKey).toBe(true)
    const stray = await at()
    expect(stray.styleOf(/^● GAME · finish your move · Tab to type$/)).toEqual(
      GAME_ROW,
    )

    await heard.clock.advance(5_000)
    const locked = await at()
    expect(locked.styleOf(/^✓ YOUR TURN$/)).toEqual(HEADING)
    // Rule change: behind the card there's no mode row; the card says it.
    expect(locked.texts.some(drawn => drawn.text.startsWith('○'))).toBe(false)
    expect(locked.frame).toEqual({ ...FRAME, borderDimColor: true })
    expect(locked.texts.some(drawn => /locks in/.test(drawn.text))).toBe(false)

    // The warning colour is the fade's banner alone, as text, and nothing has
    // a background. Rule change: the bold accents are the game's mode row, the
    // banner and the card's heading, and nothing else; the card's next step
    // is no longer bold.
    expect(seen.filter(drawn => 'backgroundColor' in drawn.style)).toEqual([])
    expect(seen.filter(drawn => drawn.style.color === 'yellow')).toEqual([])
    const warning = seen.filter(drawn => drawn.style.color === 'warning')
    expect(warning.length).toBeGreaterThan(0)
    for (const drawn of warning) {
      expect(drawn.text).toMatch(
        /^Claude is waiting for you · the board locks in \ds$/,
      )
    }
    const bold = new Set(
      seen.filter(drawn => drawn.style.bold === true).map(drawn => drawn.text),
    )
    expect([...bold].sort()).toEqual(
      [
        '● GAME · arrows play · Tab to type',
        '● GAME · finish your move · Tab to type',
        'Claude is waiting for you · the board locks in 5s',
        '✓ YOUR TURN',
      ].sort(),
    )
  })

  // Rule change: behind the card there's no mode row at all, not even blank,
  // so the band is a row shorter while the card shows. (Under the board, the
  // card and the live view can differ in rows too, so the band is measured
  // against what's drawn above the mode row.)
  for (const [layout, bodyColumns] of [
    ['beside the board', 100],
    ['under the board', 40],
  ] as const) {
    test(`with the card ${layout}, there's no mode row once locked, so the band is a row shorter`, async ($, on) => {
      const heard = worldOf(on)
      await start($)
      await toggle($)
      await $.turn.start({ text: 'go', turnId: 't1' })
      const band = await boardBand($, { bodyColumns })
      await clickBoard(band)
      expect(heard.state?.value.mode).toBe('game')
      await band.redraw()
      expect(await band.find({ text: /^● GAME · arrows play/ })).toBeDefined()
      const playing = ownOf(await band.drawn())
      const playingRows = await heightOf(band, playing)
      expect(playingRows).toBe((await heightOf(band, playing.children[0])) + 1)

      await heard.clock.advance(12_000)
      await $.turn.complete(ending('t1'))
      await heard.clock.advance(5_000)
      await settle()
      await band.redraw()
      expect(await band.find({ text: /^✓ YOUR TURN/ })).toBeDefined()
      const locked = ownOf(await band.drawn())
      const parts = locked.children.filter(
        child => child !== null && child !== undefined && child !== false,
      )
      expect(parts).toHaveLength(1)
      expect(await heightOf(band, locked)).toBe(await heightOf(band, parts[0]))
      // Beside the board the board sets the height: the band is 8 rows
      // while playing and 7 once locked.
      if (layout === 'beside the board') {
        expect(playingRows).toBe(8)
        expect(await heightOf(band, locked)).toBe(7)
      }
    })
  }

  test('over the fade the board darkens each second, then locks grey', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    type Tile = { background: string; color: string; isEmpty: boolean }
    const now = async () => {
      await settle()
      await band.redraw()
      const board = (await band.find({ type: 'Client' }))?.props.props as {
        tiles: Tile[]
        frame: string
      }
      const tiles = board.tiles.filter(tile => !tile.isEmpty)
      return { tiles, frame: board.frame, light: lightOf(tiles[0]) }
    }
    const ended = await now()
    await heard.clock.advance(1_000)
    const second = await now()
    await heard.clock.advance(2_000)
    const third = await now()
    await heard.clock.advance(2_000)
    const locked = await now()
    expect([ended, second, third].map(look => look.frame)).toEqual([
      'fade',
      'fade',
      'fade',
    ])
    expect(second.light).toBeLessThan(ended.light)
    expect(third.light).toBeLessThan(second.light)
    expect(locked.light).toBeLessThan(third.light)
    expect(locked.frame).toBe('dim')
    expect(locked.tiles.length).toBeGreaterThan(0)
    for (const tile of locked.tiles) {
      expect([tile.background, tile.color]).toEqual(['#4a4a4a', '#9a9a9a'])
    }
  })

  test('shrunk to one line, the state leads in its own tone and the rest is dim', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    const small = { maxRows: 8 }
    const idle = await lookOf(await boardBand($, small))
    expect(
      idle.styleOf(/^No activity yet · Claude's work shows here$/),
    ).toEqual(DIM)
    expect(idle.styleOf(/^ · more rows show the game$/)).toEqual(DIM)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const working = await lookOf(await boardBand($, small))
    expect(
      working.styleOf(/^● Claude is working · \d+s · 0 tool calls$/),
    ).toEqual(ROW)
    expect(working.styleOf(/^ · more rows show the game$/)).toEqual(DIM)
    await $.turn.complete(ending('t1'))
    await heard.clock.settle()
    const locked = await lookOf(await boardBand($, small))
    expect(locked.styleOf(/^✓ YOUR TURN$/)).toEqual(HEADING)
    expect(
      // Rule change: the hint right after the state, then the paragraph.
      locked.styleOf(
        /^ · more rows show the game · Claude finished — your turn: read the reply\.$/,
      ),
    ).toEqual(DIM)
  })

  test('shrunk during the fade, the band hands the keys back, which ends the fade: the line shows the card', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clickBoard(await boardBand($))
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    const small = await lookOf(await boardBand($, { maxRows: 8 }))
    expect(heard.state?.value.mode).toBe('input')
    expect(small.styleOf(/^✓ YOUR TURN$/)).toEqual(HEADING)
    expect(small.texts.some(drawn => /locks in/.test(drawn.text))).toBe(false)
  })

  test('the move that finishes the game during the fade locks the board at once, for good', async ($, on) => {
    // One move from the end: left merges the 2s, and whatever tile then comes
    // into the one empty cell, no move is left.
    const last: Kept = {
      shape: MODEL_SHAPE,
      value: {
        ...INITIAL_MODEL,
        isOn: true,
        isSeeded: true,
        game: {
          cells: [
            2, 2, 8, 16, 8, 16, 32, 64, 16, 32, 64, 128, 32, 64, 128, 256,
          ],
          score: 0,
          best: 0,
          isOver: false,
          hasWon: false,
          moves: 0,
        },
      },
    }
    const heard = worldOf(on, {}, last)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($)
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    expect(await shows(band as never, /locks in 5s/)).toBe(true)
    const epoch = heard.state?.value.board.epoch ?? 0
    await press(band, { key: 'left' })
    await heard.clock.settle()
    const over = heard.state?.value.game
    expect(over?.isOver).toBe(true)
    expect(heard.state?.value.mode).toBe('input')
    expect(heard.state?.value.turn.lockAt).toBe(0)
    expect(heard.state?.value.board.epoch).toBe(epoch + 1)
    const look = await lookOf(band)
    expect(look.styleOf(/^✓ YOUR TURN$/)).toEqual(HEADING)
    expect(look.frame).toEqual({ ...FRAME, borderDimColor: true })
    // Nothing keeps time any more, and a click deals no new game.
    const writes = heard.stateWrites
    await heard.clock.advance(5_000)
    expect(heard.stateWrites).toBe(writes)
    await clickBoard(band)
    expect(heard.state?.value.game).toEqual(over)
    expect(heard.state?.value.mode).toBe('input')
  })

  test('the column layout draws the banner and the card the same way', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    await toggle($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await boardBand($, { bodyColumns: 52 })
    await clickBoard(band)
    expect(heard.state?.value.mode).toBe('game')
    await heard.clock.advance(12_000)
    await $.turn.complete(ending('t1'))
    const fade = await lookOf(band)
    expect(
      fade.styleOf(/^Claude is waiting for you · the board locks in 5s$/),
    ).toEqual(BANNER)
    expect(fade.frame).toEqual({ ...FRAME, borderColor: 'warning' })
    await heard.clock.advance(5_000)
    expect((await lookOf(band)).styleOf(/^✓ YOUR TURN$/)).toEqual(HEADING)
  })
})

// A session already played: its game's score is 76.
const PLAYED: Kept = {
  shape: MODEL_SHAPE,
  value: {
    ...INITIAL_MODEL,
    isOn: true,
    isSeeded: true,
    game: {
      cells: [64, 8, 4, ...new Array<number>(13).fill(0)],
      score: 76,
      best: 76,
      isOver: false,
      hasWon: false,
      moves: 21,
    },
  },
}

function tilesOf(heard: ReturnType<typeof worldOf>): number {
  return heard.state?.value.game.cells.filter(value => value !== 0).length ?? 0
}

// The scores the board draws under its tiles, as drawn now; undefined while no
// board is drawn.
async function scoresOf(band: BoardBand): Promise<string | undefined> {
  await settle()
  await band.redraw()
  const key = (await band.find({ type: 'Client' }))?.key
  if (key === undefined) return undefined
  return textsOf(await band.drawn({ in: key }))
    .map(drawn => drawn.text)
    .find(text => text.startsWith('score '))
}

describe('after a /clear or a resume inside Claude Code', () => {
  test('a game that was on is back at once, as in a new session: two tiles and the kept best', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 4436 }, PLAYED)
    await start($)
    const band = await boardBand($)
    expect(await scoresOf(band)).toBe('score 76 · best 4436')
    for (const time of ['first', 'second']) {
      const reads = heard.storeReads.length
      clear(heard)
      await band.redraw()
      expect(await band.drawn(), `${time} /clear`).toEqual(ENGINE)
      expect(await scoresOf(band), `${time} /clear`).toBe('score 0 · best 4436')
      expect(await band.find({ text: /No activity yet/ })).toBeDefined()
      expect(tilesOf(heard)).toBe(2)
      expect(heard.state?.value.turn.phase).toBe('idle')
      expect(heard.storeReads.slice(reads)).toEqual(['isOn', 'best'])
    }
  })

  test('a game that was off stays off, and /fortywait shows a new game with the kept best', async ($, on) => {
    const heard = worldOf(on, { isOn: false, best: 4436 })
    await start($)
    clear(heard)
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
    expect(tilesOf(heard)).toBe(2)
    expect(heard.state?.value.game.best).toBe(4436)
    expect(heard.writes).toEqual([{ key: 'isOn', value: true }])
  })

  test('the next event restores it first, and the band follows that turn', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 4436 })
    await start($)
    clear(heard)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await settle()
    expect(heard.state?.value.isOn).toBe(true)
    expect(tilesOf(heard)).toBe(2)
    expect(heard.state?.value.game.best).toBe(4436)
    expect(heard.state?.value.turn).toMatchObject({
      turnId: 't1',
      phase: 'running',
    })
  })

  test('with no /clear nothing is restored again: draws, a turn and toggles read nothing kept', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 4436 })
    await start($)
    const reads = heard.storeReads.length
    const band = await mounted($)
    expect(await shows(band, /No activity yet/)).toBe(true)
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(await shows(band, /Claude is working/)).toBe(true)
    await $.turn.complete(ending('t1'))
    expect(await shows(band, /YOUR TURN/)).toBe(true)
    await toggle($)
    await toggle($)
    expect(await shows(band, /No activity yet/)).toBe(true)
    expect(heard.storeReads.length).toBe(reads)
  })

  test('/fortywait right after acts on the restored game: one that was on turns off', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 4436 })
    await start($)
    clear(heard)
    expect(await toggle($)).toContain('Twenty Forty-Wait off')
    expect(tilesOf(heard)).toBe(2)
    expect(heard.writes).toEqual([{ key: 'isOn', value: false }])
  })

  test('the band redraws itself once restored, with no other draw asked for', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 4436 })
    await start($)
    const band = await boardBand($)
    clear(heard)
    await band.redraw()
    await settle()
    expect(await band.find({ text: /No activity yet/ })).toBeDefined()
    expect(tilesOf(heard)).toBe(2)
  })

  for (const phase of ['running', 'fading'] as const) {
    test(`a game ${phase === 'running' ? 'played while Claude works' : 'fading after a long turn'} comes back idle, the keys in the prompt and no clock running`, async ($, on) => {
      const heard = worldOf(on, { isOn: true, best: 4436 })
      await start($)
      await $.turn.start({ text: 'go', turnId: 't1' })
      const band = await boardBand($)
      await clickBoard(band)
      expect(heard.state?.value.mode).toBe('game')
      await heard.clock.advance(12_000)
      // The band's clock runs while Claude works.
      expect(heard.periods).toBeGreaterThan(10)
      if (phase === 'fading') {
        await $.turn.complete(ending('t1'))
        expect((await lookOf(band)).styleOf(/the board locks in/)).toBeDefined()
      }
      clear(heard)
      await band.redraw()
      await settle()
      expect(heard.state?.value).toMatchObject({ isOn: true, mode: 'input' })
      expect(heard.state?.value.turn.phase).toBe('idle')
      expect(tilesOf(heard)).toBe(2)
      const reads = heard.stateReads
      const periods = heard.periods
      await heard.clock.advance(10_000)
      expect(heard.periods).toBe(periods)
      expect(heard.stateReads).toBe(reads)
      expect((await lookOf(band)).styleOf(/No activity yet/)).toBeDefined()
    })
  }

  test('a restore that fails on a tick stops the band, and once it is back its clock runs again', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 4436 })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const band = await mounted($)
    clear(heard)
    heard.isModelUnwritable = true
    await heard.clock.advance(1_000)
    expect(await shows(band, /Claude is working|No activity yet/)).toBe(false)
    heard.isModelUnwritable = false
    await $.turn.start({ text: 'again', turnId: 't2' })
    await settle()
    await heard.clock.advance(3_000)
    expect(await shows(band, /Claude is working · 3s/)).toBe(true)
  })

  test('while a restore waits in line, more draws ask for no other', async ($, on) => {
    const heard = worldOf(on, { isOn: true, best: 4436 })
    await start($)
    const band = await boardBand($)
    // The state reads a /clear costs while its restore is held up on the store
    // and the band is drawn this many times.
    const readsOf = async (draws: number) => {
      clear(heard)
      let release = () => {}
      heard.heldReads.set(
        'isOn',
        new Promise<void>(resolve => {
          release = resolve
        }),
      )
      const before = heard.stateReads
      await band.redraw()
      await settle()
      for (let draw = 1; draw < draws; draw += 1) await band.redraw()
      await settle()
      release()
      await settle()
      expect(tilesOf(heard)).toBe(2)
      return heard.stateReads - before
    }
    const once = await readsOf(1)
    // Only the three more draws' own reads: no restore asked for again.
    expect(await readsOf(4)).toBe(once + 3)
  })

  test('a fresh install shows and writes nothing, and /fortywait then deals', async ($, on) => {
    const heard = worldOf(on)
    await start($)
    const band = await boardBand($)
    clear(heard)
    await band.redraw()
    expect(await scoresOf(band)).toBeUndefined()
    expect(await band.find({ text: /No activity yet/ })).toBeUndefined()
    expect(heard.writes).toEqual([])
    expect(await toggle($)).toContain('Twenty Forty-Wait on')
    expect(tilesOf(heard)).toBe(2)
    expect(await scoresOf(band)).toBe('score 0 · best 0')
  })
})

describe('other mods above the band', () => {
  async function bandOn($: unknown, surface: string, change: object = {}) {
    const ui = ($ as { ui: { mount: (e: unknown) => Promise<unknown> } }).ui
    const props = { ...BAND.props, ...change }
    return (await ui.mount({ ...BAND, surface, props })) as BoardBand
  }

  // What's drawn, as it came: each drawing numbers its presses anew.
  async function drawnAt($: unknown, surface: string, change: object = {}) {
    const band = await bandOn($, surface, change)
    await settle()
    await band.redraw()
    const drawn = JSON.stringify(await band.drawn())
    return drawn.replace(/"handle":\d+/g, '"handle":0')
  }

  for (const surface of ['terminal', 'desktop']) {
    test(`on ${surface}, the game draws under what's beneath, as it came: Claude Code's node alone, or a mod's drawing`, async ($, on) => {
      const heard = worldOf(on, { isOn: true })
      await start($)
      await $.turn.start({ text: 'go', turnId: 't1' })
      const alone = JSON.parse(await drawnAt($, surface))
      expect(alone.props).toEqual({ flexDirection: 'column' })
      expect(alone.children[0]).toEqual(ENGINE)
      expect(alone.children[1].props).toMatchObject({ flexGrow: 1 })
      heard.beneath = 'sentinel'
      const { props, children } = JSON.parse(await drawnAt($, surface))
      expect(props).toEqual({ flexDirection: 'column' })
      const types = children[0].children.map(
        (each: { type: string }) => each.type,
      )
      expect(types).toEqual(['Text', 'Button', 'engine'])
      expect(children[1]).toEqual(alone.children[1])
    })

    test(`on ${surface}, before the restore, under a survey and off, what's beneath is left as it came`, async ($, on) => {
      const heard = worldOf(on, { isOn: true })
      heard.beneath = 'sentinel'
      const beneath = await drawnAt($, surface)
      expect(beneath).toMatch(/sentinel meter.*sentinel button.*"engine"/)
      await start($)
      expect(await drawnAt($, surface, { hasSurvey: true })).toBe(beneath)
      await toggle($)
      expect(await drawnAt($, surface)).toBe(beneath)
      heard.beneath = 'engine'
      expect(await drawnAt($, surface)).toBe(JSON.stringify(ENGINE))
    })

    test(`on ${surface}, with fewer rows, the game's one line under what's beneath, or that alone and the keys at the prompt`, async ($, on) => {
      const heard = worldOf(on, { isOn: true })
      heard.beneath = 'sentinel'
      const beneath = await drawnAt($, surface)
      await start($)
      await $.turn.start({ text: 'go', turnId: 't1' })
      await clickBoard(await bandOn($, surface))
      expect(heard.state?.value.mode).toBe('game')
      // The mod's 2 rows take every row, and at 10 columns, wrapped, all 3.
      expect(await drawnAt($, surface, { maxRows: 2 })).toBe(beneath)
      const wrapped = { maxRows: 3, bodyColumns: 10 }
      expect(await drawnAt($, surface, wrapped)).toBe(beneath)
      expect(heard.state?.value.mode).toBe('input')
      // A third of the 18 rows left is too few for the board.
      const narrow = await drawnAt($, surface, { maxRows: 20 })
      expect(narrow).toMatch(/sentinel meter.*more rows show the game/)
      heard.beneath = 'engine'
      const alone = await drawnAt($, surface, { maxRows: 20 })
      expect(alone).toMatch(/^\{"type":"Box".*"engine".*more rows show/)
      expect(alone).not.toContain('sentinel')
    })
  }
})
