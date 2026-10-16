// The rows a metric chart draws, as a pure function so the gap behavior is testable without a DOM.
//
// The console's chart built rows only from the timestamps some line reported and joined each line
// across whatever it skipped (recharts `connectNulls`). On the self-hosted box that drew daemon
// downtime, and the network rates the daemon deliberately does not invent across an outage, as
// continuous measurement. Here every slot of the selected window is a row, a line with no sample in a
// slot simply has no value there, and the chart does not connect across it: missing reads as missing.

export interface ChartDomain {
  from: number
  to: number
  /** The bucket width; without it the rows come from the samples alone (the console's behavior). */
  step?: number
}

export function chartRows(lines: ReadonlyArray<{ key: string; points: ReadonlyArray<{ t: number; value: number }> }>, domain?: ChartDomain): Record<string, number>[] {
  const byT = new Map<number, Record<string, number>>()
  if (domain?.step && domain.step > 0) {
    for (let t = domain.from; t <= domain.to; t += domain.step) byT.set(t, { t })
  }
  for (const line of lines) {
    for (const p of line.points) {
      // A point off the grid (the one live reading a fresh daemon answers with) still gets its own row.
      const row = byT.get(p.t) ?? { t: p.t }
      row[line.key] = p.value
      byT.set(p.t, row)
    }
  }
  return [...byT.values()].sort((a, b) => a.t! - b.t!)
}
