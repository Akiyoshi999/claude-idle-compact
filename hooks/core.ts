// The scheduling logic, free of `$`: register.ts feeds it the session's
// events and hands it the clock, the session id and the compact call, so the
// tests can drive it with a clock of their own.

export const MIN_IDLE_MS = 50 * 60_000
export const MAX_IDLE_MS = 60 * 60_000
/** How long the session must stay idle after a turn before a due reservation is judged. */
export const IDLE_SETTLE_MS = 2_000

export type Timer = { cancel: () => void }

export type Deps = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  sessionId: () => Promise<string>
  compact: () => Promise<{ skip?: string }>
  notify: (text: string) => void
}

/** What one reservation came to; `notify` is told, tests read `outcomes`. */
export type Outcome =
  | { kind: 'compacted' }
  | { kind: 'compact-skipped'; reason: string }
  | { kind: 'compact-failed'; error: string }
  | { kind: 'late'; idleMs: number }
  | { kind: 'session-changed' }

export type RequestToken = { gen: number; startedAt: number }

type Reservation = {
  gen: number
  baselineAt: number
  sessionId: string
  /** armed: timer running; due: deadline hit while busy; consumed: never again. */
  state: 'armed' | 'due' | 'consumed'
}

export class IdleCompactor {
  readonly outcomes: Outcome[] = []
  private isEnabled = false
  private gen = 0
  private reservation: Reservation | undefined
  private timer: Timer | undefined
  private isTurnRunning = false
  private pendingInputs = 0
  private compactions = 0
  private isSelfCompacting = false

  constructor(private readonly deps: Deps) {}

  enable(isEnabled: boolean): void {
    this.isEnabled = isEnabled
    if (!isEnabled) this.invalidate()
  }

  /** A main-loop model request is about to be sent. */
  async beginMainRequest(): Promise<RequestToken | undefined> {
    if (!this.isEnabled || this.compactions > 0 || this.isSelfCompacting) return undefined
    this.isTurnRunning = true
    const gen = this.invalidate()
    const startedAt = await this.deps.now()
    return { gen, startedAt }
  }

  /**
   * The request ended. Only one that got a response back (`hasResponse`) sets
   * the new baseline; a failed one leaves no reservation at all.
   */
  async endMainRequest(token: RequestToken | undefined, hasResponse: boolean): Promise<void> {
    if (token === undefined || !hasResponse || token.gen !== this.gen) return
    let sessionId: string
    let now: number
    try {
      sessionId = await this.deps.sessionId()
      now = await this.deps.now()
    } catch {
      return // nothing to time against: no reservation
    }
    if (token.gen !== this.gen || !this.isEnabled) return
    this.reservation = { gen: token.gen, baselineAt: token.startedAt, sessionId, state: 'armed' }
    this.arm(Math.max(0, token.startedAt + MIN_IDLE_MS - now))
  }

  turnStarted(): void {
    this.isTurnRunning = true
  }

  /** The main turn ended; a reservation that fell due meanwhile is judged once the session settles. */
  turnCompleted(): void {
    this.isTurnRunning = false
    if (this.reservation?.state === 'due' && this.reservation.gen === this.gen) this.arm(IDLE_SETTLE_MS)
  }

  /** A prompt was submitted; call the returned function once it entered or queued. */
  inputSubmitted(): () => void {
    this.pendingInputs++
    return once(() => {
      this.pendingInputs--
    })
  }

  /** Someone else's compaction of the main conversation (not a precompute) began. */
  compactionStarted(): () => void {
    this.invalidate()
    this.compactions++
    return once(() => {
      this.compactions--
    })
  }

  /** /clear, resume, branch, session end: forget everything timed so far. */
  reset(): void {
    this.invalidate()
    this.isTurnRunning = false
  }

  private isBusy(): boolean {
    return this.isTurnRunning || this.pendingInputs > 0 || this.compactions > 0 || this.isSelfCompacting
  }

  private invalidate(): number {
    this.timer?.cancel()
    this.timer = undefined
    this.reservation = undefined
    return ++this.gen
  }

  private arm(ms: number): void {
    this.timer?.cancel()
    const gen = this.gen
    this.timer = this.deps.after(ms, () => {
      this.attempt(gen).catch((error: unknown) => {
        const r = this.reservation
        if (r?.gen === gen) r.state = 'consumed'
        this.report({ kind: 'compact-failed', error: error instanceof Error ? error.message : String(error) })
      })
    })
  }

  private isCurrent(gen: number, r: Reservation | undefined): r is Reservation {
    return r !== undefined && gen === this.gen && r === this.reservation && r.gen === gen && r.state !== 'consumed'
  }

  private async attempt(gen: number): Promise<void> {
    const first = this.reservation
    if (!this.isCurrent(gen, first)) return
    if (this.isBusy()) {
      first.state = 'due'
      return
    }
    const now = await this.deps.now()
    const sessionId = await this.deps.sessionId()
    const r = this.reservation
    if (!this.isCurrent(gen, r)) return
    // Re-judged after the awaits: a prompt submitted meanwhile wins.
    if (this.isBusy()) {
      r.state = 'due'
      return
    }
    const idleMs = now - r.baselineAt
    if (idleMs < MIN_IDLE_MS) {
      r.state = 'armed'
      this.arm(MIN_IDLE_MS - idleMs)
      return
    }
    r.state = 'consumed'
    this.timer?.cancel()
    this.timer = undefined
    if (sessionId !== r.sessionId) return this.report({ kind: 'session-changed' })
    if (idleMs >= MAX_IDLE_MS) return this.report({ kind: 'late', idleMs })
    this.isSelfCompacting = true
    try {
      const result = await this.deps.compact()
      this.report(result.skip === undefined ? { kind: 'compacted' } : { kind: 'compact-skipped', reason: result.skip })
    } catch (error) {
      this.report({ kind: 'compact-failed', error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.isSelfCompacting = false
    }
  }

  private report(outcome: Outcome): void {
    this.outcomes.push(outcome)
    const text = describe(outcome)
    if (text !== undefined) this.deps.notify(text)
  }
}

function describe(outcome: Outcome): string | undefined {
  switch (outcome.kind) {
    case 'compacted':
      return 'idle-compact: compacted after 50+ idle minutes'
    case 'compact-skipped':
      return `idle-compact: compaction skipped (${outcome.reason})`
    case 'compact-failed':
      return `idle-compact: compaction failed (${outcome.error}); not retried`
    case 'late':
      return `idle-compact: skipped, ${Math.floor(outcome.idleMs / 60_000)} min idle (past 60, e.g. after sleep)`
    case 'session-changed':
      return undefined
  }
}

function once(fn: () => void): () => void {
  let isDone = false
  return () => {
    if (isDone) return
    isDone = true
    fn()
  }
}
