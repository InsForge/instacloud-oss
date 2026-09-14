import { describe, expect, it, vi } from 'vitest'
import { startPoll, type PollTimers } from './pollLoop'

/** A request the test resolves by hand, and timers it fires by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function manualTimers() {
  const pending: Array<() => void> = []
  const timers: PollTimers = { set: (fn) => { pending.push(fn); return pending.length - 1 }, clear: () => { pending.length = 0 } }
  return { timers, pending }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('startPoll (regression: an old poll outlived a dependency change and kept overwriting)', () => {
  it('delivers nothing and schedules nothing when its request resolves after the loop was stopped', async () => {
    const request = deferred<string>()
    const { timers, pending } = manualTimers()
    const handlers = { onData: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    const stop = startPoll(() => request.promise, handlers, 30_000, timers)
    stop() // the range or service changed while this request was in flight
    request.resolve('old range data')
    await flush()
    expect(handlers.onData).not.toHaveBeenCalled()
    expect(handlers.onSettled).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0) // no loop left behind
  })

  it('does the same for a request that fails after the loop was stopped', async () => {
    const request = deferred<string>()
    const { timers, pending } = manualTimers()
    const handlers = { onData: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    const stop = startPoll(() => request.promise, handlers, 30_000, timers)
    stop()
    request.reject(new Error('daemon unreachable'))
    await flush()
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('keeps two generations apart: only the current loop writes', async () => {
    const oldRequest = deferred<string>()
    const { timers } = manualTimers()
    const written: string[] = []
    const stopOld = startPoll(() => oldRequest.promise, { onData: (d) => written.push(d), onError: () => {}, onSettled: () => {} }, 30_000, timers)
    stopOld()
    startPoll(async () => 'new range data', { onData: (d) => written.push(d), onError: () => {}, onSettled: () => {} }, 30_000, timers)
    oldRequest.resolve('old range data')
    await flush()
    expect(written).toEqual(['new range data'])
  })

  it('polls again after each attempt settles while running, and stop clears the pending timer', async () => {
    const { timers, pending } = manualTimers()
    let calls = 0
    const handlers = { onData: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    const stop = startPoll(async () => ++calls, handlers, 30_000, timers)
    await flush()
    expect(handlers.onData).toHaveBeenLastCalledWith(1)
    expect(pending).toHaveLength(1)
    pending.shift()!()
    await flush()
    expect(handlers.onData).toHaveBeenLastCalledWith(2)
    stop()
    expect(pending).toHaveLength(0)
  })
})
