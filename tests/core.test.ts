import { describe, expect, test } from 'claude-code/testing'
import { IDLE_SETTLE_MS, IdleCompactor, MAX_IDLE_MS, MIN_IDLE_MS, type Deps } from '../hooks/core'

const MIN = 60_000

// A clock of our own: timers fire only when the test moves time, and
// `sleepFor` moves wall time without firing anything, as a suspended laptop does.
class FakeClock {
  now = 0
  private timers: { due: number; fn: () => void; isCancelled: boolean }[] = []

  after = (ms: number, fn: () => void) => {
    const timer = { due: this.now + ms, fn, isCancelled: false }
    this.timers.push(timer)
    return { cancel: () => void (timer.isCancelled = true) }
  }

  pending(): number {
    return this.timers.filter(t => !t.isCancelled).length
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms
    for (;;) {
      const next = this.timers.filter(t => !t.isCancelled && t.due <= end).sort((a, b) => a.due - b.due)[0]
      if (next === undefined) break
      this.now = Math.max(this.now, next.due)
      this.fire(next)
      await flush()
    }
    this.now = end
    await flush()
  }

  /** Wall time jumps; overdue timers fire late, at wake. */
  async sleepFor(ms: number): Promise<void> {
    this.now += ms
    for (const t of this.timers.filter(t => !t.isCancelled && t.due <= this.now)) {
      this.fire(t)
      await flush()
    }
  }

  private fire(t: { fn: () => void; isCancelled: boolean }): void {
    t.isCancelled = true
    t.fn()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function setup(options: { compact?: Deps['compact']; sessionId?: () => string } = {}) {
  const clock = new FakeClock()
  const calls = { compact: 0, toasts: [] as string[] }
  const compactor = new IdleCompactor({
    now: async () => clock.now,
    after: clock.after,
    sessionId: async () => options.sessionId?.() ?? 's1',
    compact: async () => {
      calls.compact++
      return options.compact ? options.compact() : {}
    },
    notify: text => calls.toasts.push(text),
  })
  compactor.enable(true)
  return { clock, calls, compactor }
}

/** One main turn of one successful request, started now. */
async function turn(c: IdleCompactor, hasResponse = true): Promise<void> {
  c.turnStarted()
  const token = await c.beginMainRequest()
  await c.endMainRequest(token, hasResponse)
  c.turnCompleted()
  await flush()
}

describe('idle-compact core', () => {
  test('compacts once, 50 minutes after the last main request', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    await clock.advance(MIN_IDLE_MS - 1)
    expect(calls.compact).toBe(0)
    await clock.advance(1)
    expect(calls.compact).toBe(1)
    await clock.advance(5 * 60 * MIN)
    expect(calls.compact).toBe(1)
    expect(compactor.outcomes).toEqual([{ kind: 'compacted' }])
  })

  test('a new main request cancels the old reservation and restarts the 50 minutes', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    await clock.advance(40 * MIN)
    await turn(compactor)
    expect(clock.pending()).toBe(1)
    await clock.advance(15 * MIN) // 55 min after the first request
    expect(calls.compact).toBe(0)
    await clock.advance(35 * MIN) // 50 min after the second
    expect(calls.compact).toBe(1)
  })

  test('the baseline is the request start, not its end', async () => {
    const { clock, calls, compactor } = setup()
    compactor.turnStarted()
    const token = await compactor.beginMainRequest()
    await clock.advance(10 * MIN) // a long response
    await compactor.endMainRequest(token, true)
    compactor.turnCompleted()
    await clock.advance(40 * MIN)
    expect(calls.compact).toBe(1)
  })

  test('a failed request leaves no reservation', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    await clock.advance(10 * MIN)
    await turn(compactor, false)
    expect(clock.pending()).toBe(0)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compact).toBe(0)
  })

  test('a stale callback of a cancelled generation does nothing', async () => {
    const { clock, calls, compactor } = setup()
    let stale: (() => void) | undefined
    const realAfter = clock.after
    clock.after = (ms, fn) => {
      stale ??= fn
      return realAfter(ms, fn)
    }
    await turn(compactor)
    await clock.advance(20 * MIN)
    await turn(compactor)
    stale?.() // the first reservation's callback, fired anyway
    await flush()
    expect(calls.compact).toBe(0)
  })

  test('never interrupts a running turn; judged again when it goes idle', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    compactor.turnStarted() // e.g. waiting on a permission prompt, no new request
    await clock.advance(52 * MIN)
    expect(calls.compact).toBe(0)
    compactor.turnCompleted() // the person aborted it
    await clock.advance(IDLE_SETTLE_MS)
    expect(calls.compact).toBe(1)
  })

  test('a turn that ends past 60 minutes is skipped, not compacted', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    compactor.turnStarted()
    await clock.advance(61 * MIN)
    compactor.turnCompleted()
    await clock.advance(IDLE_SETTLE_MS)
    expect(calls.compact).toBe(0)
    expect(compactor.outcomes).toEqual([{ kind: 'late', idleMs: 61 * MIN + IDLE_SETTLE_MS }])
  })

  test('a prompt submitted at the deadline wins over the timer', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    await clock.advance(MIN_IDLE_MS - 1)
    const entered = compactor.inputSubmitted()
    await clock.advance(1)
    expect(calls.compact).toBe(0)
    entered()
    // Its turn then sends a request, which re-times everything.
    await turn(compactor)
    await clock.advance(MIN_IDLE_MS - 1)
    expect(calls.compact).toBe(0)
  })

  test('waking from sleep past 60 minutes skips without compacting', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    await clock.sleepFor(3 * 60 * MIN)
    expect(calls.compact).toBe(0)
    expect(compactor.outcomes).toEqual([{ kind: 'late', idleMs: 3 * 60 * MIN }])
    expect(calls.toasts[0]).toMatch(/skipped/)
    await clock.advance(5 * 60 * MIN)
    expect(calls.compact).toBe(0)
  })

  test('waking from sleep inside the window still compacts', async () => {
    const { clock, calls, compactor } = setup()
    await turn(compactor)
    await clock.sleepFor(55 * MIN)
    expect(calls.compact).toBe(1)
  })

  test('a skipped or failed compaction is not retried', async () => {
    for (const compact of [async () => ({ skip: 'hook said no' }), async () => Promise.reject(new Error('busy'))]) {
      const { clock, calls, compactor } = setup({ compact })
      await turn(compactor)
      await clock.advance(MAX_IDLE_MS * 10)
      expect(calls.compact).toBe(1)
      expect(clock.pending()).toBe(0)
    }
  })

  test('the reservation is consumed before compact runs, so re-entry cannot double it', async () => {
    let compactor!: IdleCompactor
    let reentered = 0
    const s = setup({
      compact: async () => {
        compactor.turnCompleted() // an idle notice arriving mid-compaction
        await flush()
        reentered = s.calls.compact
        return {}
      },
    })
    compactor = s.compactor
    await turn(compactor)
    await s.clock.advance(MIN_IDLE_MS + 10 * MIN)
    expect(reentered).toBe(1)
    expect(s.calls.compact).toBe(1)
  })

  test('requests during its own compaction set no new timer', async () => {
    let compactor!: IdleCompactor
    let tokenDuringCompact: unknown = 'unset'
    const s = setup({
      compact: async () => {
        tokenDuringCompact = await compactor.beginMainRequest()
        return {}
      },
    })
    compactor = s.compactor
    await turn(compactor)
    await s.clock.advance(MIN_IDLE_MS)
    expect(tokenDuringCompact).toBeUndefined()
    expect(s.clock.pending()).toBe(0)
  })

  test('another compaction, a reset or a disable cancels the reservation', async () => {
    for (const cancel of [
      (c: IdleCompactor) => c.compactionStarted()(),
      (c: IdleCompactor) => c.reset(),
      (c: IdleCompactor) => c.enable(false),
    ]) {
      const { clock, calls, compactor } = setup()
      await turn(compactor)
      await clock.advance(30 * MIN)
      cancel(compactor)
      await clock.advance(2 * 60 * MIN)
      expect(calls.compact).toBe(0)
    }
  })

  test('a reservation from another session id is dropped', async () => {
    let id = 's1'
    const { clock, calls, compactor } = setup({ sessionId: () => id })
    await turn(compactor)
    id = 's2'
    await clock.advance(MIN_IDLE_MS)
    expect(calls.compact).toBe(0)
    expect(compactor.outcomes).toEqual([{ kind: 'session-changed' }])
  })
})
