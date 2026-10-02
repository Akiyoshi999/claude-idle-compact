import type { Register } from 'claude-code'
import { IdleCompactor } from './core'

// Module variables on purpose: a reload starts with no reservation (the old
// environment's timers are dropped), and the next main request times anew.
export const register: Register = on => {
  let compactor: IdleCompactor | undefined

  on('session.start', async ($, e, next) => {
    compactor?.enable(false)
    compactor = new IdleCompactor({
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      sessionId: () => $.session.id(),
      compact: () => $.session.compact(),
      notify: text => $.ui.toast(text),
    })
    compactor.enable(e.isInteractive)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || compactor === undefined) return yield* next(e)
    const current = compactor
    const token = await current.beginMainRequest()
    let hasResponse = false
    try {
      const result = yield* next(e)
      hasResponse = result.stopReason !== null && result.usage !== null
      return result
    } finally {
      void current.endMainRequest(token, hasResponse)
    }
  })

  on('turn.start', ($, e, next) => {
    compactor?.turnStarted()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) compactor?.turnCompleted()
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const done = compactor?.inputSubmitted()
    try {
      return await next(e)
    } finally {
      done?.()
    }
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute' || compactor === undefined) return next(e)
    const done = compactor.compactionStarted()
    try {
      return await next(e)
    } finally {
      done()
    }
  })

  on('classic.SessionStart', ($, e, next) => {
    compactor?.reset()
    return next(e)
  })

  on('session.end', ($, e, next) => {
    compactor?.reset()
    return next(e)
  })
}
