// What a sleeping database's Database tab shows (insta-frontend database/instance-gate.tsx `useDbInstanceGate`,
// postgres-data-tab.tsx). Pure so the root vitest covers it.
//
// After Wake and browse, "Connecting to the database…" covers the whole window until the data read answers, as on the
// console. Clearing the waking flag the moment the wake call returned brought the prompt back for one metrics round trip
// against a database that was already coming up.
//
// Self-host divergence: the console's latch is one-way for the life of the mount, because its queries wake the
// database. The daemon's reads never do (decision 48), so a database can be asleep again by the time the read lands
// (a short idle timeout does it). A one-way latch then spun "Connecting" forever. So the hold lasts until the FIRST
// read after the wake answers, and that read decides: awake shows the data, still sleeping shows the prompt again.

export type DbGateView = 'prompt' | 'connecting' | 'content'

export interface DbGateState {
  /** The latest metrics read answered "database is sleeping". */
  sleeping: boolean
  /** The wake request is in flight. */
  waking: boolean
  /** The wake succeeded and no read has answered since: the hold. */
  awaitingRead: boolean
  /** The wake request itself failed. */
  wakeError?: string
}

export function dbGateView({ sleeping, waking, awaitingRead, wakeError }: DbGateState): DbGateView {
  if (waking) return 'connecting'
  if (awaitingRead && !wakeError) return 'connecting'
  return sleeping ? 'prompt' : 'content'
}
