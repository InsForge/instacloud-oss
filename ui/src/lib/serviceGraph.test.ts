// Ported from insta-frontend src/lib/service-graph.test.ts: the canvas layout and edge routing are the
// console's own, so they are pinned by the console's own cases.

import { describe, expect, it } from 'vitest'
import { componentsOf, edgeFans, edgeGeometry, layoutGraph, type ServiceLink } from './serviceGraph'

const link = (sourceId: string, targetId: string): ServiceLink => ({ sourceId, targetId })
const METRICS = { cardWidth: 320, cardHeight: 225, gap: 60, edgeGap: 160, aspect: 3 / 2 }
const CARDS = { width: 320, fromHeight: 140, toHeight: 140, portY: 70 }
/** Fan triples the sweep samples: both extremes of each term, and centred. */
const FAN_SAMPLES: [number, number, number][] = [
  [0, 0, 0.5],
  [-58, 58, 0],
  [58, -58, 1],
  [-58, -58, 1],
  [58, 58, 0],
]

describe('componentsOf — which services belong together', () => {
  it('gathers a binding chain, however it was ordered', () => {
    expect(componentsOf(['api', 'db', 'bucket'], [link('db', 'api'), link('bucket', 'api')])).toEqual([['api', 'db', 'bucket']])
  })

  it('gives a service nothing binds a group of its own', () => {
    expect(componentsOf(['db', 'api', 'spare'], [link('db', 'api')])).toEqual([['db', 'api'], ['spare']])
  })

  it('orders biggest first, then by the order the canvas listed them', () => {
    expect(componentsOf(['lonely', 'db', 'api', 'worker'], [link('db', 'api'), link('db', 'worker')])).toEqual([['db', 'api', 'worker'], ['lonely']])
  })

  it('ignores a link whose other end is not on the canvas', () => {
    expect(componentsOf(['api'], [link('db-elsewhere', 'api')])).toEqual([['api']])
    expect(componentsOf(['a', 'b'], [link('gone', 'a'), link('gone', 'b')])).toEqual([['a'], ['b']])
  })
})

describe('layoutGraph — where an undragged card sits', () => {
  it('puts a credential source left of the service consuming it', () => {
    const p = layoutGraph(['api', 'db'], [link('db', 'api')], METRICS)
    expect(p.db).toEqual({ x: 0, y: 0 })
    expect(p.api).toEqual({ x: 480, y: 0 })
  })

  it('centres the shorter column against the taller one', () => {
    const p = layoutGraph(['api', 'db', 'cache', 'bucket'], [link('db', 'api'), link('cache', 'api'), link('bucket', 'api')], METRICS)
    expect([p.db!.y, p.cache!.y, p.bucket!.y]).toEqual([0, 285, 570])
    expect(p.api!.y).toBe(285)
  })

  it('packs independent stacks sideways instead of into one tall ladder', () => {
    const n = [1, 2, 3, 4, 5, 6]
    const ids = [...n.map((i) => `db${i}`), ...n.map((i) => `app${i}`)]
    const p = layoutGraph(ids, n.map((i) => link(`db${i}`, `app${i}`)), METRICS)
    expect(p.db1).toEqual({ x: 0, y: 0 })
    expect(p.app1).toEqual({ x: 480, y: 0 })
    expect(p.db2).toEqual({ x: 860, y: 0 })
    expect(p.db3).toEqual({ x: 0, y: 285 })
    const width = Math.max(...ids.map((i) => p[i]!.x)) + 320
    const height = Math.max(...ids.map((i) => p[i]!.y)) + 225
    expect(width).toBeGreaterThan(height)
  })

  it('orders sources by the average row of what they feed', () => {
    const p = layoutGraph(['api-a', 'api-b', 'late', 'early'], [link('early', 'api-a'), link('late', 'api-b'), link('late', 'api-a')], METRICS)
    expect(p.early!.y).toBe(0)
    expect(p.late!.y).toBe(285)
  })

  it("measures each shelf's drop from its own tallest block", () => {
    const ids = ['ds0', 'ds1', 'ds2', 'dt', ...Array.from({ length: 16 }, (_, i) => `l${i}`)]
    const p = layoutGraph(ids, [link('ds0', 'dt'), link('ds1', 'dt'), link('ds2', 'dt')], METRICS)
    const shelves = [...new Set(ids.map((i) => p[i]!.y))].sort((a, b) => a - b)
    expect(shelves).toContain(855)
    expect(shelves).toContain(1140)
  })

  it('falls back to one shared block where separate ones would pack worse', () => {
    const ids = ['a-s0', 'a-s1', 'a-t', 'b-s', 'b-t0', 'b-t1']
    const p = layoutGraph(ids, [link('a-s0', 'a-t'), link('a-s1', 'a-t'), link('b-s', 'b-t0'), link('b-s', 'b-t1')], METRICS)
    expect(Math.max(...ids.map((i) => p[i]!.y)) + 225).toBe(795)
    expect(Math.max(...ids.map((i) => p[i]!.x)) + 320).toBe(800)
  })

  it('tries shelf widths that no prefix of the blocks adds up to', () => {
    const ids = ['c0s0', 'c0s1', 'c0s2', 'c0t', 'c1s', 'c1t', 'c2s', 'c2t', 'lone0', 'lone1', 'lone2']
    const p = layoutGraph(ids, [link('c0s0', 'c0t'), link('c0s1', 'c0t'), link('c0s2', 'c0t'), link('c1s', 'c1t'), link('c2s', 'c2t')], METRICS)
    expect(Math.max(...ids.map((i) => p[i]!.x)) + 320).toBe(1940)
  })

  it("keeps each stack's own cards in its own block", () => {
    const p = layoutGraph(['db', 'api', 'redis', 'cron'], [link('db', 'api'), link('redis', 'cron')], METRICS)
    expect(p.db!.y).toBe(p.api!.y)
    expect(p.redis!.y).toBe(p.cron!.y)
    expect(p.db!.y).not.toBe(p.redis!.y)
  })

  it('packs services nothing binds rather than stacking them in one column', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const p = layoutGraph(ids, [], METRICS)
    expect(new Set(ids.map((i) => p[i]!.x)).size).toBeGreaterThan(1)
    expect(new Set(ids.map((i) => p[i]!.y)).size).toBeLessThan(ids.length)
  })

  it('has no positions for an empty canvas', () => {
    expect(layoutGraph([], [], METRICS)).toEqual({})
  })
})

describe('edgeFans — moving edges off each other', () => {
  const one = () => 'corridor'

  it('leaves a lone edge centred on both cards and mid-corridor', () => {
    expect(edgeFans([link('db', 'api')], 58, one)).toEqual([{ exit: 0, entry: 0, turn: 0.5 }])
  })

  it('splits the exits when one service feeds several', () => {
    const fans = edgeFans([link('db', 'a'), link('db', 'b'), link('db', 'c')], 58, one)
    expect(fans.map((f) => f.exit)).toEqual([-16, 0, 16])
    expect(fans.map((f) => f.turn)).toEqual([0, 0.5, 1])
  })

  it('splits the entries when several services feed one', () => {
    const fans = edgeFans([link('db', 'api'), link('bucket', 'api')], 58, one)
    expect(fans.map((f) => f.entry)).toEqual([-4, 12])
    expect(fans.map((f) => f.exit)).toEqual([0, 0])
  })

  it('keeps entries off the grid exits land on', () => {
    const fans = edgeFans([link('s0', 't0'), link('s1', 't0'), link('s0', 't1')], 58, one)
    for (const f of fans) expect(Math.abs(f.exit % 8)).toBe(0)
    for (const f of fans) expect(Math.abs(f.entry % 8)).not.toBe(0)
  })

  it('spreads turn columns per corridor, so an unrelated pair keeps the middle', () => {
    const links = [link('db', 'a'), link('db', 'b'), link('redis', 'cron')]
    const corridor = (l: ServiceLink) => (l.sourceId === 'redis' ? 'other' : 'main')
    expect(edgeFans(links, 58, corridor).map((f) => f.turn)).toEqual([0, 1, 0.5])
  })

  it('spreads turn columns across the whole corridor, not per source', () => {
    const links = ['a', 'b', 'c'].flatMap((t) => [link('db', t), link('uploads', t)])
    expect(new Set(edgeFans(links, 58, one).map((f) => f.turn)).size).toBe(6)
  })

  it('tightens the spacing rather than pushing heads off the card', () => {
    const many = edgeFans(Array.from({ length: 9 }, (_, i) => link(`s${i}`, 'api')), 20, one)
    expect(Math.min(...many.map((f) => f.entry))).toBe(-16)
    expect(Math.max(...many.map((f) => f.entry))).toBe(24)
    expect(new Set(many.map((f) => f.entry)).size).toBe(9)
  })

  it('keeps its answers index-aligned with the links it was given', () => {
    const fans = edgeFans([link('a', 'x'), link('b', 'x'), link('c', 'y')], 58, one)
    expect(fans.map((f) => f.entry)).toEqual([-4, 12, 4])
  })

  it('has nothing to say about an empty graph', () => {
    expect(edgeFans([], 58, one)).toEqual([])
  })
})

describe('edgeGeometry — the wire between two cards', () => {
  it('turns inside the corridor, and stops clear of the arrowhead', () => {
    const { d, arrow } = edgeGeometry({ x: 0, y: 0 }, { x: 480, y: 285 }, CARDS)
    expect(d).toBe('M 320,70 H 393 V 355 H 466')
    expect(arrow).toBe('M 480,355 L 471,350 L 471,360 Z')
  })

  it('runs straight when the two ends line up', () => {
    expect(edgeGeometry({ x: 0, y: 0 }, { x: 480, y: 0 }, CARDS).d).toBe('M 320,70 H 466')
  })

  it("enters the target's right edge when it sits left of its source", () => {
    const { d, arrow } = edgeGeometry({ x: 480, y: 0 }, { x: 0, y: 285 }, CARDS)
    expect(d).toBe('M 480,70 H 407 V 355 H 334')
    expect(arrow).toBe('M 320,355 L 329,360 L 329,350 Z')
  })

  it('comes in through the top when the cards are too close to face each other', () => {
    const { d, arrow } = edgeGeometry({ x: 0, y: 0 }, { x: 333, y: 285 }, CARDS)
    expect(d).toBe('M 160,140 V 206 H 493 V 271')
    expect(arrow).toBe('M 493,285 L 498,276 L 488,276 Z')
  })

  it('comes in through the bottom when the target sits above its source', () => {
    const { d, arrow } = edgeGeometry({ x: 0, y: 285 }, { x: 100, y: 0 }, CARDS)
    expect(d).toBe('M 160,285 V 220 H 260 V 154')
    expect(arrow).toBe('M 260,140 L 255,149 L 265,149 Z')
  })

  it('goes around underneath when the cards overlap every way', () => {
    const { d, arrow } = edgeGeometry({ x: 0, y: 0 }, { x: 40, y: 40 }, CARDS)
    expect(d).toBe('M 160,140 V 224 H 200 V 194')
    expect(arrow).toBe('M 200,180 L 195,189 L 205,189 Z')
  })

  it('moves the exit, the entry and the turn column by the fan', () => {
    const plain = edgeGeometry({ x: 0, y: 0 }, { x: 480, y: 0 }, CARDS)
    const fanned = edgeGeometry({ x: 0, y: 0 }, { x: 480, y: 0 }, CARDS, { exit: -16, entry: 14, turn: 0 })
    expect(plain.d).toBe('M 320,70 H 466')
    expect(fanned.d).toBe('M 320,54 H 352 V 84 H 466')
    expect(fanned.arrow).toBe('M 480,84 L 471,79 L 471,89 Z')
  })

  it("moves the turn row too, on the branches that come in through a card's top", () => {
    const rows = [0, 0.5, 1].map((turn) => edgeGeometry({ x: 0, y: 0 }, { x: 333, y: 400 }, CARDS, { exit: 0, entry: 0, turn }).d)
    expect(rows).toEqual(['M 160,140 V 194 H 493 V 386', 'M 160,140 V 263 H 493 V 386', 'M 160,140 V 332 H 493 V 386'])
    const mirrored = [0, 0.5, 1].map((turn) => edgeGeometry({ x: 0, y: 400 }, { x: 333, y: 0 }, CARDS, { exit: 0, entry: 0, turn }).d)
    expect(mirrored).toEqual(['M 160,400 V 346 H 493 V 154', 'M 160,400 V 277 H 493 V 154', 'M 160,400 V 208 H 493 V 154'])
  })

  /** An arrowhead drawn over its own line reads as a thickened line end rather than a direction. */
  it('never draws a leg through the arrowhead, whatever the cards are doing', () => {
    const box = (arrow: string) => {
      const pts = arrow.replace(/^M /, '').replace(/ Z$/, '').split(' L ').map((p) => p.split(',').map(Number))
      const xs = pts.map((p) => p[0]!)
      const ys = pts.map((p) => p[1]!)
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    }
    const legs = (d: string) => {
      const parts = d.replace(/^M /, '').split(' ')
      let [x, y] = parts[0]!.split(',').map(Number) as [number, number]
      const out: [number, number, number, number][] = []
      for (let i = 1; i < parts.length; i += 2) {
        const to = Number(parts[i + 1])
        if (parts[i] === 'H') out.push([x, y, (x = to), y])
        else out.push([x, y, x, (y = to)])
      }
      return out
    }
    const offenders: string[] = []
    for (const fromHeight of [140, 225]) {
      for (const toHeight of [140, 225]) {
        for (let dx = -700; dx <= 700; dx += 17) {
          for (let dy = -400; dy <= 400; dy += 10) {
            for (const [exit, entry, turn] of FAN_SAMPLES) {
              const g = edgeGeometry({ x: 0, y: 0 }, { x: dx, y: dy }, { width: 320, fromHeight, toHeight, portY: 70 }, { exit, entry, turn })
              const b = box(g.arrow)
              for (const [x1, y1, x2, y2] of legs(g.d)) {
                const touches = Math.max(x1, x2) > b.minX && Math.min(x1, x2) < b.maxX && Math.max(y1, y2) > b.minY && Math.min(y1, y2) < b.maxY
                if (touches) offenders.push(`dx=${dx} dy=${dy} exit=${exit} entry=${entry}`)
              }
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

/** Two wires drawn along the same line for a stretch read as one wire. Complete graphs are the worst case. */
describe('no two wires are ever drawn along the same line', () => {
  const legsOf = (d: string): [number, number, number, number][] => {
    const parts = d.replace(/^M /, '').split(' ')
    let [x, y] = parts[0]!.split(',').map(Number) as [number, number]
    const out: [number, number, number, number][] = []
    for (let i = 1; i < parts.length; i += 2) {
      const to = Number(parts[i + 1])
      if (parts[i] === 'H') out.push([x, y, (x = to), y])
      else out.push([x, y, x, (y = to)])
    }
    return out
  }
  const overlap = (a: [number, number, number, number], b: [number, number, number, number]) => {
    const [aVertical, bVertical] = [a[0] === a[2], b[0] === b[2]]
    if (aVertical !== bVertical) return 0
    if (aVertical ? a[0] !== b[0] : a[1] !== b[1]) return 0
    const span = (s: [number, number, number, number]) => (aVertical ? [Math.min(s[1], s[3]), Math.max(s[1], s[3])] : [Math.min(s[0], s[2]), Math.max(s[0], s[2])])
    const [a1, a2] = span(a)
    const [b1, b2] = span(b)
    return Math.min(a2!, b2!) - Math.max(a1!, b1!)
  }

  it.each([[2, 2], [2, 3], [3, 2], [3, 3], [3, 4], [4, 3], [4, 4]])('complete %ix%i graph', (sources, targets) => {
    const ids = [...Array.from({ length: sources }, (_, i) => `s${i}`), ...Array.from({ length: targets }, (_, i) => `t${i}`)]
    const links = Array.from({ length: sources }, (_, i) => i).flatMap((i) => Array.from({ length: targets }, (_, j) => link(`s${i}`, `t${j}`)))
    const placed = layoutGraph(ids, links, METRICS)
    const fans = edgeFans(links, 58, (l) => `${placed[l.sourceId]!.x}>${placed[l.targetId]!.x}`)
    const drawn = links.map((l, i) => edgeGeometry(placed[l.sourceId]!, placed[l.targetId]!, CARDS, fans[i]!))
    const shared: string[] = []
    for (let a = 0; a < drawn.length; a++) {
      for (let b = a + 1; b < drawn.length; b++) {
        for (const legA of legsOf(drawn[a]!.d)) {
          for (const legB of legsOf(drawn[b]!.d)) {
            if (overlap(legA, legB) > 0) shared.push(`${a}/${b}`)
          }
        }
      }
    }
    expect(shared).toEqual([])
  })
})
