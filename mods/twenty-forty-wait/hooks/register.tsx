import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
} from 'claude-code'

import type { Model } from '../types'
import { bandTree, stackedTree } from './band'
import {
  INITIAL_MODEL,
  MODEL_SHAPE,
  afterBoardPost,
  afterDialog,
  afterFault,
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
  boardPostOf,
  handoffOf,
  isDealt,
  isReadFirst,
  isTicking,
  isTimeShown,
  modelOf,
  rowsTakenOf,
  toggleNoteOf,
  toolSucceeded,
  turnKeyOf,
  writeOf,
} from './logic'
import type {
  Effect,
  SaveEffect,
  Step,
  StoreRead,
  SummarizeEffect,
  TurnKey,
} from './logic'

const model = atom(
  { plugin: 'twenty-forty-wait', key: 'model' } as const,
  INITIAL_MODEL,
  { shape: MODEL_SHAPE },
)

// The time the band shows. Written with each change the band shows and by
// the ticker each second, so the band redraws as it moves.
const now = atom({ plugin: 'twenty-forty-wait', key: 'now' } as const, 0)

// One module load's handles. `section` runs every piece of work that reads or
// writes the model, one after another in the order it came in; `writes`
// chains the durable writes; `timer` is the ticker while the band needs it.
// A tick (between faults), a handoff for one board, or a restore the band
// asked for waits in line at most once, and so do prompt edits that come one
// after another with nothing between: the edit waiting in line, until it
// starts or anything else comes in after it.
type Load = {
  section: Promise<unknown>
  writes: Map<string, Promise<unknown>>
  timer: { cancel: () => void } | undefined
  isTickWaiting: boolean
  handoffWaiting: number | undefined
  isRestoreWaiting: boolean
  editWaiting: object | undefined
  isFaulted: boolean
  isRestored: boolean
}

function inOrder<T>(load: Load, work: () => Promise<T>): Promise<T> {
  const run = load.section.then(work)
  load.section = run.catch(() => undefined)
  return run
}

// A handoff the render asked for, done now if its timer never ran (another
// plugin may refuse timers): the next work in line carries it out first.
async function handedBack($: EngineInterface, load: Load): Promise<void> {
  const epoch = load.handoffWaiting
  if (epoch === undefined) return
  load.handoffWaiting = undefined
  await commit($, latest => afterHandoff(latest, epoch))
}

// Runs observation work in this load's order, with the time the event came
// in, after restoring a session whose state Claude Code emptied. The event
// itself is never held: the hook hands it on at once. Work that fails stops
// the board in its own place in line, before anything after it, in case the
// band is stuck.
function observe(
  $: EngineInterface,
  load: Load,
  work: (at: number) => Promise<void>,
): void {
  const arrived = $.clock.now()
  load.editWaiting = undefined
  void inOrder(load, async () => {
    try {
      await rescued($, load)
      await handedBack($, load)
      await work(await arrived)
    } catch {
      await faulted($, load)
    }
  })
}

// Stops the board: the ticker first, and the band stops drawing it, so both
// hold even if nothing can be written, then the model. The ticker's waiting
// tick is forgotten, so a later ticker runs even if that tick failed before
// its work began; a tick still in line runs, beside the later ticker's.
async function faulted($: EngineInterface, load: Load): Promise<void> {
  load.timer?.cancel()
  load.timer = undefined
  load.isTickWaiting = false
  load.isFaulted = true
  // The band read nothing while it was hidden, so no write redraws it.
  $.ui.invalidate('ui.render')
  await commit($, afterFault).catch(() => undefined)
}

// Restores the session's band from what was kept: on or off for a session
// with no choice of its own, the best score, and a new game for a session
// with none. The band shows from here on.
async function restored($: EngineInterface, load: Load): Promise<void> {
  const kept = {
    isOn: await keptOn($),
    best: await keptValue($, 'best'),
  }
  const at = await $.clock.now()
  const step = await commit($, current =>
    afterRestore(current, kept, Math.random),
  )
  void runEffects($, load, step.effects)
  load.isRestoreWaiting = false
  load.isFaulted = false
  load.isRestored = true
  $.ui.invalidate('ui.render')
  await settled($, load, at)
}

// A `/clear`, or a resume inside Claude Code, ends the session: Claude Code
// empties the mod's session state and no session start follows. A load that
// has restored and then finds a board with no tiles restores again, as a new
// session would.
async function rescued($: EngineInterface, load: Load): Promise<void> {
  if (!load.isRestored || isDealt(modelOf(await read($, model)).game)) return
  await restored($, load)
}

// Applies a transition to the model. A transition that changes nothing
// writes nothing; otherwise it is one compare-and-set write, and `update` may
// run it more than once, so the effects are those of the run written.
async function commit(
  $: EngineInterface,
  transition: (current: Model) => Step,
): Promise<Step & { isChanged: boolean }> {
  const kept = modelOf(await read($, model))
  const first = transition(kept)
  if (first.model === kept) return { ...first, isChanged: false }
  let effects = first.effects
  const written = await update($, model, value => {
    const step = transition(modelOf(value))
    effects = step.effects
    return step.model
  })
  return { model: written, effects, isChanged: true }
}

// After a change at `at`: a lock that came due is committed first, whatever
// arrived, so the ticker never stops with a lock left uncommitted. Then the
// band's time moves when the band shows time, and the ticker runs exactly
// while the band needs the clock.
async function settled(
  $: EngineInterface,
  load: Load,
  at: number,
): Promise<void> {
  const latest = await commit($, current => afterTick(current, at))
  if (isTimeShown(latest.model)) await update($, now, () => at)
  const isNeeded = isTicking(latest.model, at)
  if (isNeeded && load.timer === undefined) {
    load.timer = $.clock.every(1000, () => {
      if (load.isTickWaiting) return
      load.isTickWaiting = true
      observe($, load, async tickAt => {
        load.isTickWaiting = false
        await settled($, load, tickAt)
      })
    })
  } else if (!isNeeded && load.timer !== undefined) {
    load.timer.cancel()
    load.timer = undefined
  }
}

// Carries out a commit's effects: durable writes in line behind earlier
// ones, and summary calls on their own, none once a failure stopped the band,
// even if that couldn't be written. Resolves once the writes have landed.
function runEffects(
  $: EngineInterface,
  load: Load,
  effects: Effect[],
): Promise<unknown> {
  const saves: SaveEffect[] = []
  for (const effect of effects) {
    switch (effect.kind) {
      case 'save':
        saves.push(effect)
        break
      case 'summarize':
        if (!load.isFaulted) summarize($, load, effect)
        break
    }
  }
  return queueWrites($, load, saves)
}

// Asks the model for a turn's summary, outside the line so a slow call holds
// nothing up, and hands the result back in line, where the turn it belongs
// to decides whether it is shown. A call that fails says so in its result; a
// call refused outright is logged, and the card keeps its placeholder.
function summarize(
  $: EngineInterface,
  load: Load,
  effect: SummarizeEffect,
): void {
  $.model.complete(effect.request).then(
    result => {
      observe($, load, async at => {
        await committedAt($, load, at, current =>
          afterSummary(current, effect.turn, result),
        )
      })
    },
    (error: unknown) => {
      $.ui.log(`could not summarize: ${String(error)}`, { to: 'debug' })
    },
  )
}

// Commits an observation together with any lock that came due by then, in
// one read, so a stopped ticker never leaves a lock waiting; the band's time
// moves only when something changed.
async function committedAt(
  $: EngineInterface,
  load: Load,
  at: number,
  transition: (current: Model) => Step,
): Promise<void> {
  const step = await commit($, current => {
    const observed = transition(current)
    const due = afterTick(observed.model, at)
    return { model: due.model, effects: [...observed.effects, ...due.effects] }
  })
  if (step.isChanged) await settled($, load, at)
}

// Queues durable writes, each behind the earlier writes of its own key, and
// resolves once these have landed; a slow best score never holds up on/off.
// A best score reads what is stored first, since another session may have
// kept a higher one meanwhile. A write that fails is logged, and its queue
// goes on.
function queueWrites(
  $: EngineInterface,
  load: Load,
  effects: SaveEffect[],
): Promise<unknown> {
  const landed: Promise<unknown>[] = []
  for (const effect of effects) {
    const queued = (load.writes.get(effect.key) ?? Promise.resolve())
      .then(async () => {
        const stored: StoreRead = isReadFirst(effect)
          ? await storedOf($, effect.key)
          : { isRead: false }
        const write = writeOf(effect, stored)
        if (write !== null) await $.store.set(write.key, write.value)
      })
      .catch((error: unknown) => {
        $.ui.log(`could not save ${effect.key}: ${String(error)}`, {
          to: 'debug',
        })
      })
    load.writes.set(effect.key, queued)
    landed.push(queued)
  }
  return Promise.all(landed)
}

// What the store holds under a key now, or that it couldn't be read.
async function storedOf($: EngineInterface, key: string): Promise<StoreRead> {
  try {
    return { isRead: true, value: await $.store.get(key) }
  } catch (error) {
    $.ui.log(`could not read ${key}: ${String(error)}`, { to: 'debug' })
    return { isRead: false }
  }
}

// Whether a session with no choice of its own starts with the band on: as
// `/fortywait` last left it, in any session.
function keptOn($: EngineInterface): Promise<unknown> {
  return keptValue($, 'isOn')
}

// A value kept from an earlier session, or undefined when it can't be read.
async function keptValue($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch (error) {
    $.ui.log(`could not read ${key}: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

// The band as drawn for this render: what's beneath it on top, as it came,
// and the game in the rows left under it, or what's beneath alone when the
// game isn't drawn.
async function drawn(
  $: EngineInterface,
  load: Load,
  e: RenderInput<'AbovePrompt'>,
  current: Model,
  below: RenderElement,
): Promise<RenderElement> {
  const view = bandOf(current, await read($, now), {
    columns: e.props.bodyColumns,
    maxRows: e.props.maxRows,
    isFullscreen: e.viewport?.isFullscreen,
    hasSurvey: e.props.hasSurvey,
    others: rowsTakenOf(below, e.props.bodyColumns),
  })
  // Drawing can't write; a board that held the keys but isn't drawn is
  // handed back right after, once per board.
  const epoch = handoffOf(current, view)
  if (epoch !== null && load.handoffWaiting !== epoch) {
    load.handoffWaiting = epoch
    $.clock.after(0, () => {
      observe($, load, async at => {
        load.handoffWaiting = undefined
        await commit($, latest => afterHandoff(latest, epoch))
        await settled($, load, at)
      })
    })
  }
  if (view.kind === 'none') return below
  const ui = $.ui.resolve(e) as Parameters<typeof bandTree>[0]
  const own = bandTree(ui, view)
  return stackedTree(ui, below, own)
}

/**
 * Wires the mod into Claude Code. At each session start or reload it offers
 * `/fortywait` and restores the kept choice, and restores again when Claude
 * Code empties the session's state; `/fortywait` switches the band on or off.
 * Turn, tool and dialog events move the band's model, one after another in
 * the order they came, while each event goes on unchanged and unheld; the
 * ticker moves the band's time, and the band above the prompt draws it.
 */
export const register: Register = on => {
  const load: Load = {
    section: Promise.resolve(),
    writes: new Map(),
    timer: undefined,
    isTickWaiting: false,
    handoffWaiting: undefined,
    isRestoreWaiting: false,
    editWaiting: undefined,
    isFaulted: false,
    isRestored: false,
  }

  on('session.start', ($, e, next) => {
    // The restore takes its place in line before anything can wait on I/O,
    // so a `/fortywait` run meanwhile comes after it; the session starts at
    // once, whatever the restore waits on.
    void inOrder(load, async () => {
      try {
        await $.command.register({
          name: 'fortywait',
          description:
            'Turn Twenty Forty-Wait on or off: a game above the prompt while Claude works',
          immediate: true,
        })
        await restored($, load)
      } catch {
        await faulted($, load)
      }
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'fortywait' }, async $ => {
    const { step, written } = await inOrder(load, async () => {
      await rescued($, load)
      const at = await $.clock.now()
      const step = await commit($, afterToggle)
      load.isFaulted = false
      $.ui.invalidate('ui.render')
      const written = runEffects($, load, step.effects)
      await settled($, load, at).catch(() => faulted($, load))
      return { step, written }
    })
    await written
    return { text: toggleNoteOf(step.model) }
  })

  on('turn.start', ($, e, next) => {
    observe($, load, async at => {
      await commit($, current =>
        afterTurnStart(current, { turnId: e.turnId, at }),
      )
      await settled($, load, at)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', ($, e, next) => {
    const call = { tool: String(e.tool), input: e }
    // The turn this call ran in, so its result counts only there.
    let turn: TurnKey | null = null
    observe($, load, async at => {
      const step = await commit($, current =>
        afterToolCall(current, { ...call, at, agentId: e.agentId }),
      )
      turn = turnKeyOf(step.model)
      await settled($, load, at)
    })
    const result = next(e)
    void result.then(
      done => {
        observe($, load, async at => {
          await commit($, current =>
            afterToolDone(current, {
              ...call,
              isOk: toolSucceeded(done),
              turn,
            }),
          )
          await settled($, load, at)
        })
      },
      () => undefined,
    )
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    observe($, load, async at => {
      const step = await commit($, current =>
        afterTurnEnd(current, {
          turnId: e.turnId,
          reason: e.reason,
          answer: e.answer,
          durationMs: e.durationMs,
          at,
          agentId: e.agentId,
        }),
      )
      void runEffects($, load, step.effects)
      await settled($, load, at)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // A permission prompt or a question, from any loop: the dialog takes the
  // keys from the board.
  on('classic.PermissionRequest', ($, e, next) => {
    observe($, load, async at => {
      await commit($, afterDialog)
      await settled($, load, at)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The board posted its clicks and keys. Only queued here: the count the
  // model acknowledged reaches the board through its props at the next draw.
  on('ui.message', { component: 'AbovePrompt' }, ($, e, next) => {
    const post = boardPostOf(e.data)
    if (post !== null) {
      observe($, load, async at => {
        const step = await commit($, current =>
          afterBoardPost(current, e.element, post, at, Math.random),
        )
        void runEffects($, load, step.effects)
        await settled($, load, at)
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // An edit or a send in the prompt: if the game still had the keys, the
  // person left it in a way Claude Code doesn't report. Observed only: the
  // edit and the prompt go on unchanged. Edits typed one after another wait
  // in line as one, since each says the same.
  on('prompt.edit', ($, e, next) => {
    if (load.editWaiting === undefined) {
      const edit = {}
      observe($, load, async at => {
        if (load.editWaiting === edit) load.editWaiting = undefined
        await committedAt($, load, at, current =>
          afterPrompt(current, { kind: 'edit' }),
        )
      })
      load.editWaiting = edit
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', ($, e, next) => {
    const origin = String((e.origin as { kind?: unknown } | undefined)?.kind)
    observe($, load, async at => {
      await committedAt($, load, at, current =>
        afterPrompt(current, { kind: 'submit', origin }),
      )
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The board widget failed: it stops being drawn, and the keys go back.
  on('ui.fault', ($, e, next) => {
    observe($, load, () => faulted($, load))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Nothing of the mod is drawn until this load has restored the session's
    // band, nor once a fault stopped it, even if that couldn't be written.
    if (
      (e.surface !== 'terminal' && e.surface !== 'desktop') ||
      !load.isRestored ||
      load.isFaulted
    ) {
      return next(e)
    }
    const current = modelOf(await read($, model))
    // Claude Code emptied the session's state: drawing can't write, so the
    // restore runs right after, asked for once until one lands, and Claude
    // Code draws its own band meanwhile.
    if (!isDealt(current.game)) {
      if (!load.isRestoreWaiting) {
        load.isRestoreWaiting = true
        $.clock.after(0, () => observe($, load, () => Promise.resolve()))
      }
      return next(e)
    }
    // What other mods draw beneath this one stays, on top, and the game has
    // the rows left under it.
    const below = await next(e)
    try {
      return await drawn($, load, e, current, below)
    } catch {
      // The band's own drawing failed, after what's beneath was drawn:
      // Claude Code draws that alone, and the board stops, right after.
      $.clock.after(0, () => {
        observe($, load, () => faulted($, load))
      })
      return below
    }
  }).catch(($, e, next) => {
    // The band's own drawing failed: Claude Code draws its own, and the board
    // stops, right after. A failure beneath, once handed on, is not ours, nor
    // is a re-entry (read as a string: older Claude Code types list the kinds
    // differently); a timeout always is, as only the hook's own time counts.
    const kind = String(next.error.kind)
    if ((!next.called || kind === 'timeout') && kind !== 're-entry') {
      $.clock.after(0, () => {
        observe($, load, () => faulted($, load))
      })
    }
    return next(e)
  })
}
