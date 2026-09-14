// Which state the metric charts show, as a pure decision so it is testable without a DOM.
//
// usePoll keeps the last successful `data` when a later poll fails and sets `error`; it clears `error`
// on the next success. So a set `error` always means THE LATEST poll failed. Rendering charts whenever
// `data` existed ignored that and left old observations on screen as if current — indefinitely, for
// as long as the daemon stayed unreachable. A failed latest poll therefore wins over old data.

export type ChartsView = 'loading' | 'unavailable' | 'note' | 'cards'

export function metricChartsView(state: { hasData: boolean; error: unknown; note?: string }): ChartsView {
  if (state.error) return 'unavailable'
  if (!state.hasData) return 'loading'
  return state.note ? 'note' : 'cards'
}
