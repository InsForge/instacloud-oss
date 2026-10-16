// The poll loop behind usePoll, with no React in it so it can be tested (see localPrefStore.ts on why
// a react-importing module cannot be tested from the root vitest config).
//
// Each loop owns its own `stopped` flag. usePoll used to keep ONE `alive` ref for every effect run:
// cleanup set it false and the next run set it true straight away, so a request the old run had in
// flight resolved into `true`, wrote its (old range's, old service's) data, and scheduled the old
// closure again — a loop that never ended, one more for every dependency change.

export interface PollHandlers<T> {
  onData: (data: T) => void
  onError: (error: unknown) => void
  /** After every attempt, success or failure, while the loop is still running. */
  onSettled: () => void
}

export interface PollTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: PollTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Run `fn` now and again `intervalMs` after each attempt settles. The returned stop ends THIS loop:
 *  a request still in flight when it is called delivers nothing and schedules nothing. */
export function startPoll<T>(fn: () => Promise<T>, handlers: PollHandlers<T>, intervalMs: number, timers: PollTimers = realTimers): () => void {
  let stopped = false
  let handle: unknown
  const run = async (): Promise<void> => {
    try {
      const data = await fn()
      if (!stopped) handlers.onData(data)
    } catch (e) {
      if (!stopped) handlers.onError(e)
    }
    if (stopped) return
    handlers.onSettled()
    handle = timers.set(() => { void run() }, intervalMs)
  }
  void run()
  return () => {
    stopped = true
    if (handle !== undefined) timers.clear(handle)
  }
}
