// The console's service graph (insta-frontend src/lib/service-graph.ts), ported unchanged in behavior:
// where each card sits on the canvas when nobody has dragged it, and how the edge between two cards
// is routed. Pure, so it unit-tests without a DOM.

/** An edge on the canvas: `sourceId` feeds a credential into the compute service `targetId`. */
export interface ServiceLink {
  sourceId: string
  targetId: string
}

export interface Point {
  x: number
  y: number
}

/** Card size and spacing, passed in so the layout holds none of the canvas's constants. */
export interface GraphMetrics {
  cardWidth: number
  /** The tallest a card gets — what a block's height has to clear. */
  cardHeight: number
  gap: number
  /**
   * The wider gutter between a source column and the column it feeds: at the plain
   * gutter an edge between neighbouring cards is a 60px stub, which reads as a tick
   * mark rather than a connection.
   */
  edgeGap: number
  /**
   * Shape the packing aims for. A CONSTANT, not the live viewport — deriving it from
   * the window would rearrange every card on a resize, and these positions are the
   * baseline a user's own drags are stored against.
   */
  aspect: number
}

/**
 * The services each binding chain reaches, one group per chain, and one group per
 * service nothing binds. Biggest first, so packing puts substantial blocks down before
 * singletons; ties keep `ids` order, which the Map's insertion order and a stable sort
 * give — layout must never depend on the iteration order of the link list.
 */
export function componentsOf(ids: string[], links: ServiceLink[]): string[][] {
  const root = new Map(ids.map((id) => [id, id]))
  const find = (id: string): string => {
    const up = root.get(id)!
    if (up === id) return id
    const top = find(up)
    root.set(id, top)
    return top
  }
  for (const link of links) {
    if (root.has(link.sourceId) && root.has(link.targetId)) {
      root.set(find(link.sourceId), find(link.targetId))
    }
  }
  const grouped = new Map<string, string[]>()
  for (const id of ids) grouped.set(find(id), [...(grouped.get(find(id)) ?? []), id])
  return [...grouped.values()].sort((a, b) => b.length - a.length)
}

/** One component, laid out from its own origin. */
function layoutComponent(ids: string[], links: ServiceLink[], m: GraphMetrics): Record<string, Point> {
  // A group of several always carries a link: every link that united it has both ends
  // inside. So no links means one service, standing alone.
  if (links.length === 0) return { [ids[0]!]: { x: 0, y: 0 } }
  const positions: Record<string, Point> = {}
  // Two columns is the whole story rather than a general layering pass: a binding only has a
  // compute TARGET and a non-compute SOURCE, so no third rank and no cycle can exist.
  const rowHeight = m.cardHeight + m.gap
  const targets = ids.filter((id) => links.some((l) => l.targetId === id))
  const rowOf = new Map(targets.map((id, row) => [id, row]))
  // A source sits beside the average row of what it feeds, which is what keeps edges
  // from crossing when one database serves several apps. Sorting is stable, so sources
  // feeding the same row keep their `ids` order.
  const barycenter = (id: string) => {
    const rows = links.filter((l) => l.sourceId === id).map((l) => rowOf.get(l.targetId)!)
    return rows.reduce((a, b) => a + b, 0) / rows.length
  }
  const sources = ids.filter((id) => links.some((l) => l.sourceId === id)).sort((a, b) => barycenter(a) - barycenter(b))

  const column = (ordered: string[], other: string[], x: number) => {
    // The shorter column centres against the taller, so a single app fed by three
    // databases faces the middle of them rather than sitting at the top.
    const top = (Math.max(0, other.length - ordered.length) / 2) * rowHeight
    ordered.forEach((id, row) => {
      positions[id] = { x, y: Math.round(top + row * rowHeight) }
    })
  }
  column(sources, targets, 0)
  column(targets, sources, m.cardWidth + m.edgeGap)
  return positions
}

interface Block {
  ids: string[]
  local: Record<string, Point>
  width: number
  height: number
}

function blockOf(ids: string[], links: ServiceLink[], m: GraphMetrics): Block {
  const local = layoutComponent(ids, links, m)
  return {
    ids,
    local,
    width: Math.max(...ids.map((id) => local[id]!.x)) + m.cardWidth,
    height: Math.max(...ids.map((id) => local[id]!.y)) + m.cardHeight,
  }
}

/**
 * A shelf holds a contiguous run of blocks, so the packing can only change at a width
 * where some run stops fitting — those widths, and no others, are worth trying. Prefixes
 * alone miss every run that starts on a later shelf, which costs up to a quarter of the
 * scale the camera could have used.
 */
function shelfWidths(blocks: Block[], m: GraphMetrics): number[] {
  const widths = new Set<number>()
  for (let i = 0; i < blocks.length; i++) {
    let run = -m.gap
    for (let j = i; j < blocks.length; j++) {
      run += blocks[j]!.width + m.gap
      widths.add(run)
    }
  }
  return [...widths].sort((a, b) => a - b)
}

function shelve(blocks: Block[], shelfWidth: number, m: GraphMetrics): Record<string, Point> {
  const out: Record<string, Point> = {}
  let x = 0
  let y = 0
  let shelfHeight = 0
  for (const block of blocks) {
    // `x > 0` so a block wider than the shelf still lands rather than looping: `shelve`
    // has to hold for any width, not only the ones shelfWidths offers.
    if (x > 0 && x + block.width > shelfWidth) {
      x = 0
      y += shelfHeight + m.gap
      shelfHeight = 0
    }
    for (const id of block.ids) {
      out[id] = { x: x + block.local[id]!.x, y: y + block.local[id]!.y }
    }
    x += block.width + m.gap
    shelfHeight = Math.max(shelfHeight, block.height)
  }
  return out
}

/** Proportional to the scale a camera fitting this placement would land on. */
function fitScore(ids: string[], placed: Record<string, Point>, m: GraphMetrics): number {
  const xs = ids.map((id) => placed[id]!.x)
  const ys = ids.map((id) => placed[id]!.y)
  const width = Math.max(...xs) - Math.min(...xs) + m.cardWidth
  const height = Math.max(...ys) - Math.min(...ys) + m.cardHeight
  return Math.min(m.aspect / width, 1 / height)
}

/**
 * Where each card sits when the user hasn't dragged it: each binding chain laid out on
 * its own, then those blocks packed into shelves — so services wired together sit
 * together, and a project with several stacks grows sideways instead of only downwards.
 *
 * Two arrangements are scored, and the roomier wins. Separate blocks group related cards
 * but can never share a column, and a few shapes pack tighter with every chain in ONE
 * two-column block; scoring that as well is what stops any shape landing smaller than it
 * would have without the grouping.
 */
export function layoutGraph(ids: string[], links: ServiceLink[], m: GraphMetrics): Record<string, Point> {
  if (ids.length === 0) return {}
  const groups = componentsOf(ids, links)
  const arrangements = [groups]
  const chains = groups.filter((group) => group.length > 1)
  if (chains.length > 1) {
    const joined = new Set(chains.flat())
    arrangements.push([ids.filter((id) => joined.has(id)), ...groups.filter((group) => group.length === 1)])
  }

  let best: Record<string, Point> = {}
  let bestScore = -1
  for (const arrangement of arrangements) {
    const blocks = arrangement.map((group) => {
      const inside = new Set(group)
      return blockOf(group, links.filter((l) => inside.has(l.sourceId) && inside.has(l.targetId)), m)
    })
    for (const width of shelfWidths(blocks, m)) {
      const trial = shelve(blocks, width, m)
      const score = fitScore(ids, trial, m)
      if (score > bestScore) {
        bestScore = score
        best = trial
      }
    }
  }
  return best
}

/** Nominal spacing between edges sharing one card's edge, squeezed if they don't fit. */
const FAN_STEP = 16
/**
 * Entries sit off the grid exits land on. Cards a row apart are rowHeight apart and a fan
 * reaches at most a fraction of that, so two horizontal legs can only be collinear when a
 * source and a target share a layout row AND an offset — which this makes impossible,
 * since slots put exits on multiples of FAN_STEP/2 and nothing lands on a quarter step.
 */
const ENTRY_BIAS = FAN_STEP / 4
const ARROW_LEN = 9
const ARROW_HALF = 5
const ARROW_GAP = 5
/** What an entry edge needs free before an edge can meet it: the head, plus daylight. */
const ARROW_SPACE = ARROW_LEN + ARROW_GAP
/** How far past two overlapping cards their edge is routed. */
const LANE = 44
/** The band of the corridor turn columns spread across, keeping them off both cards. */
const TURN_MIN = 0.22
const TURN_MAX = 0.78

export interface EdgeGeometry {
  /** The dashed polyline, stopping short of the arrowhead. */
  d: string
  /** Filled triangle, tip on the target card's entry edge. */
  arrow: string
}

/** The two cards an edge joins. Heights may differ. */
export interface EdgeCards {
  width: number
  fromHeight: number
  toHeight: number
  /** Where a side port sits, measured from the card's top. */
  portY: number
}

/** How one edge is moved aside so it isn't drawn on top of another. */
export interface EdgeFan {
  /** Along the source card's edge, in px. */
  exit: number
  /** Along the target card's edge, in px. */
  entry: number
  /** Where its turn column sits in the corridor between the cards, 0 to 1. */
  turn: number
}

const CENTRED: EdgeFan = { exit: 0, entry: 0, turn: 0.5 }
const r = Math.round
/** A fan slot as a share of whatever corridor the cards leave, held off both of them. */
const band = (turn: number) => TURN_MIN + (TURN_MAX - TURN_MIN) * turn

/** Signed, centred slots for each link within its `key` group, squeezed to fit ±max. */
function slotsBy(links: ServiceLink[], key: (l: ServiceLink) => string, max: number): number[] {
  const total = new Map<string, number>()
  for (const link of links) total.set(key(link), (total.get(key(link)) ?? 0) + 1)
  const taken = new Map<string, number>()
  return links.map((link) => {
    const k = key(link)
    const n = total.get(k)!
    const index = taken.get(k) ?? 0
    taken.set(k, index + 1)
    const step = n > 1 ? Math.min(FAN_STEP, (2 * max) / (n - 1)) : 0
    return (index - (n - 1) / 2) * step
  })
}

/**
 * How far each edge is moved aside, index-aligned with `links`.
 *
 * All three matter, and each answers a different collision. Without `entry`, edges into
 * one card land on the same point with their heads stacked. Without `exit`, every edge
 * out of one card starts at the same pixel. Without `turn` they all pivot at the same
 * column, which a chain's shared target column makes the common case.
 *
 * `corridorOf` groups the turn columns, and must name the space an edge actually pivots
 * in — every edge between the same two card columns. Grouping by binding chain instead
 * leaves two chains packed into one block pivoting on the same column.
 */
export function edgeFans(links: ServiceLink[], maxOffset: number, corridorOf: (link: ServiceLink) => string): EdgeFan[] {
  const exits = slotsBy(links, (l) => l.sourceId, maxOffset)
  const entries = slotsBy(links, (l) => l.targetId, maxOffset)
  const total = new Map<string, number>()
  for (const link of links) total.set(corridorOf(link), (total.get(corridorOf(link)) ?? 0) + 1)
  const taken = new Map<string, number>()
  return links.map((link, i) => {
    const corridor = corridorOf(link)
    const n = total.get(corridor)!
    const index = taken.get(corridor) ?? 0
    taken.set(corridor, index + 1)
    // One edge in a corridor has nothing to avoid, and keeps the straight wire an
    // aligned pair draws.
    return n > 1 ? { exit: exits[i]!, entry: entries[i]! + ENTRY_BIAS, turn: index / (n - 1) } : { exit: 0, entry: 0, turn: 0.5 }
  })
}

/** Tip on the card edge, opening away from it along (dx, dy) - one of which is 0. */
function arrowAt(x: number, y: number, dx: -1 | 0 | 1, dy: -1 | 0 | 1): string {
  const backX = x - dx * ARROW_LEN
  const backY = y - dy * ARROW_LEN
  const spanX = dy * ARROW_HALF
  const spanY = dx * ARROW_HALF
  return `M ${r(x)},${r(y)} L ${r(backX + spanX)},${r(backY - spanY)} L ${r(backX - spanX)},${r(backY + spanY)} Z`
}

/**
 * The edge between two cards, as right angles, meeting the target square on.
 *
 * Which edge it arrives at follows the space available, and every branch keeps the last
 * leg ARROW_SPACE short of the tip AND every other leg off the head's own rows: an arrow
 * drawn over its own line reads as a thickened line end, not a direction. The side ports
 * are used only where the cards are far enough apart to hold the head between them;
 * closer than that the wire comes in through the top or the bottom, which is also what a
 * card dragged directly above its partner gets.
 *
 * Legs may still pass BEHIND a card - the layer paints under them - which is why the
 * branches are chosen on where the head can go rather than on avoiding the boxes.
 *
 * `portY` is measured from the card's top rather than its middle, so a port holds still
 * however tall a card is drawn.
 */
export function edgeGeometry(from: Point, to: Point, { width, fromHeight, toHeight, portY }: EdgeCards, fan: EdgeFan = CENTRED): EdgeGeometry {
  if (Math.abs(to.x - from.x) - width >= ARROW_SPACE) {
    const forward = to.x > from.x
    const dir = forward ? 1 : -1
    const ax = forward ? from.x + width : from.x
    const ay = from.y + portY + fan.exit
    const tip = forward ? to.x : to.x + width
    const by = to.y + portY + fan.entry
    const end = tip - dir * ARROW_SPACE
    const turn = r(ax + (end - ax) * band(fan.turn))
    return {
      d: ay === by ? `M ${r(ax)},${r(ay)} H ${r(end)}` : `M ${r(ax)},${r(ay)} H ${turn} V ${r(by)} H ${r(end)}`,
      arrow: arrowAt(tip, by, dir, 0),
    }
  }

  const exit = from.x + width / 2 + fan.exit
  const tx = to.x + width / 2 + fan.entry
  const fromBottom = from.y + fromHeight
  const toBottom = to.y + toHeight

  // Down into the target's top. The turn sits in the middle of what is left after the
  // head's own space, so the leg crossing to the entry column cannot run over the head.
  if (to.y - fromBottom >= ARROW_SPACE) {
    const turn = r(fromBottom + (to.y - ARROW_SPACE - fromBottom) * band(fan.turn))
    return {
      d: `M ${r(exit)},${r(fromBottom)} V ${turn} H ${r(tx)} V ${r(to.y - ARROW_SPACE)}`,
      arrow: arrowAt(tx, to.y, 0, 1),
    }
  }
  // Up into the target's bottom.
  if (from.y - toBottom >= ARROW_SPACE) {
    const turn = r(from.y + (toBottom + ARROW_SPACE - from.y) * band(fan.turn))
    return {
      d: `M ${r(exit)},${r(from.y)} V ${turn} H ${r(tx)} V ${r(toBottom + ARROW_SPACE)}`,
      arrow: arrowAt(tx, toBottom, 0, -1),
    }
  }
  // Overlapping every way: around underneath. The leg leaving runs alongside the head
  // here, so its column is pushed clear of the head's own width rather than merely off
  // centre — within ARROW_HALF it clips the head whatever the cards' heights are.
  const below = Math.max(fromBottom, toBottom) + LANE * (0.5 + fan.turn)
  const clear = ARROW_HALF + 2
  const start = Math.abs(exit - tx) > clear ? exit : tx + (exit >= tx ? clear : -clear)
  return {
    d: `M ${r(start)},${r(fromBottom)} V ${r(below)} H ${r(tx)} V ${r(toBottom + ARROW_SPACE)}`,
    arrow: arrowAt(tx, toBottom, 0, -1),
  }
}
