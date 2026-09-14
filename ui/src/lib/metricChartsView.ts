// Which state the metric charts show, as a pure decision so it is testable without a DOM.
//
// usePoll keeps the last successful `data` when a later poll fails and sets `error`; it clears `error`
// on the next success. So a set `error` always means THE LATEST poll failed. Rendering charts whenever
// `data` existed ignored that and left old observations on screen as if current — indefinitely, for
// as long as the daemon stayed unreachable. A failed latest poll therefore wins over old data.
//
// usePoll also keeps its data when its dependencies change, and an older request can land after a
// newer one began. Data is therefore only data for the scope it was fetched for: switching from one
// service to another must show loading, never the first service's points under the second's name.

export type ChartsView = 'loading' | 'unavailable' | 'note' | 'cards'

export function metricChartsView(state: {
  hasData: boolean
  error: unknown
  note?: string
  /** The scope the data was fetched for, and the scope on screen now. Compared only when both are given. */
  fetchedFor?: string
  scope?: string
}): ChartsView {
  if (state.error) return 'unavailable'
  const current = state.fetchedFor === undefined || state.scope === undefined || state.fetchedFor === state.scope
  if (!state.hasData || !current) return 'loading'
  return state.note ? 'note' : 'cards'
}
