import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, SessionCompactTrigger } from 'claude-code'

const MIN = 60_000
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

/** The engine beneath the plugin: answers each event and counts compactions. */
function world(on: On) {
  const clock = mock.clock(on)
  const compactions: SessionCompactTrigger[] = []
  const toasts: string[] = []
  let isFailing = false
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.compact', ($, e) => {
    // A plugin's call reaches the bottom without the fields the engine fills in.
    compactions.push(e.trigger ?? 'plugin')
    return { messages: [SUMMARY] }
  })
  on('turn.step', async function* ($, e) {
    if (isFailing) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  return {
    clock,
    compactions,
    toasts,
    failRequests: (value: boolean) => void (isFailing = value),
  }
}

async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  for (let r = await stream.next(); !r.done; r = await stream.next());
}

let turnCount = 0
async function mainTurn($: Engine, options: { agentId?: string; isComplete?: boolean } = {}): Promise<void> {
  const turnId = `t${++turnCount}`
  if (options.agentId === undefined) await $.turn.start({ text: 'hi', turnId })
  await drain($.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: options.agentId }))
  if (options.isComplete !== false) {
    await $.turn.complete({
      answer: 'ok',
      durationMs: 1,
      isAborted: false,
      turnId,
      reason: 'answer',
      agentId: options.agentId,
    })
  }
}

async function start($: Engine, isInteractive = true): Promise<void> {
  await $.session.start({ cwd: '/tmp', surface: isInteractive ? 'terminal' : null, isInteractive })
}

describe('idle-compact through the engine', () => {
  test('one compaction after 50 idle minutes, none after', async ($, on) => {
    const w = world(on)
    await start($)
    await mainTurn($)
    await w.clock.advance(MIN * 50 - 1)
    expect(w.compactions).toEqual([])
    await w.clock.advance(1)
    expect(w.compactions).toEqual(['plugin'])
    expect(w.toasts).toEqual([expect.stringContaining('compacted')])
    await w.clock.advance(MIN * 300)
    expect(w.compactions).toHaveLength(1)
  })

  test('subagent requests neither set nor move the deadline', async ($, on) => {
    const w = world(on)
    await start($)
    await mainTurn($, { agentId: 'sub-1' })
    await w.clock.advance(MIN * 120)
    expect(w.compactions).toEqual([])
    await mainTurn($)
    await w.clock.advance(MIN * 30)
    await mainTurn($, { agentId: 'sub-1' })
    await w.clock.advance(MIN * 20)
    expect(w.compactions).toEqual(['plugin'])
  })

  test('a new main request re-times; a failed one leaves nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await mainTurn($)
    await w.clock.advance(MIN * 45)
    w.failRequests(true)
    await mainTurn($)
    await w.clock.advance(MIN * 120)
    expect(w.compactions).toEqual([])
  })

  test('no compaction while the main turn runs', async ($, on) => {
    const w = world(on)
    await start($)
    await mainTurn($, { isComplete: false })
    await w.clock.advance(MIN * 55)
    expect(w.compactions).toEqual([])
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: `t${turnCount}`, reason: 'aborted' })
    await w.clock.advance(5_000)
    expect(w.compactions).toEqual(['plugin'])
  })

  for (const [name, cancel] of [
    ['/compact', ($: Engine) => $.session.compact({ trigger: 'manual', messages: [SUMMARY] })],
    ['auto-compact', ($: Engine) => $.session.compact({ trigger: 'auto', messages: [SUMMARY] })],
    ['/clear', ($: Engine) => $.classic.SessionStart({ source: 'clear' })],
    ['resume', ($: Engine) => $.classic.SessionStart({ source: 'resume' })],
    ['branch', ($: Engine) => $.classic.SessionStart({ source: 'fork' })],
    [
      'session end',
      ($: Engine) =>
        $.session.end({ reason: 'clear', sessionId: 'x', resume: { id: 'x' } } as Parameters<Engine['session']['end']>[0]),
    ],
  ] as const) {
    test(`${name} cancels the pending reservation`, async ($, on) => {
      const w = world(on)
      await start($)
      await mainTurn($)
      await w.clock.advance(MIN * 20)
      await cancel($)
      const before = w.compactions.length
      await w.clock.advance(MIN * 120)
      expect(w.compactions).toHaveLength(before)
    })
  }

  test('a precompute does not cancel the reservation', async ($, on) => {
    const w = world(on)
    await start($)
    await mainTurn($)
    await w.clock.advance(MIN * 20)
    await $.session.compact({ trigger: 'precompute', messages: [SUMMARY] })
    await w.clock.advance(MIN * 30)
    expect(w.compactions).toEqual(['precompute', 'plugin'])
  })

  test('off outside an interactive session', async ($, on) => {
    const w = world(on)
    await start($, false)
    await mainTurn($)
    await w.clock.advance(MIN * 55)
    expect(w.compactions).toEqual([])
  })
})
