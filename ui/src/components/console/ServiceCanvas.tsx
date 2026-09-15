// The console's canvas view of an environment's services (insta-frontend services/service-canvas.tsx):
// the same services as ServiceTable, drawn as draggable cards on a pannable, zoomable dot-grid surface
// and wired to each other by the credential bindings between them (lib/serviceLinks.ts). Hand-rolled
// rather than a graph library, as on the console: the surface is small (pan, zoom, drag, fit, tidy)
// and edges are read-only, so nothing needs handles, edge hit-testing or re-routing.
//
// Self-host divergences: no staged "Will be added" or template ghost cards (the daemon applies creates
// and template deploys immediately, so there is nothing staged to draw); a volume is the only attachment
// row (the daemon has no PgBouncer), and its "+ Add Volume" slot opens the Volume tab rather than staging the
// add; no region in the footer (one node); no `?focus=` glide (no dashboard flow links to it). Cards also open
// with Enter/Space, as the list rows do.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@insforge/ui'
import { BrushCleaning, Focus, HardDrive, Plus, ZoomIn, ZoomOut } from 'lucide-react'
import { api, type RuntimeHealthRow, type Service } from '../../api'
import { usePoll } from '../../hooks'
import {
  CARD_HEIGHT, CARD_MAX_HEIGHT, CARD_WIDTH, DOT_SPACING, DRAG_THRESHOLD, FAN_MAX, FIT_PADDING, LAYOUT_METRICS, PORT_Y, WIRE_DASH,
  ADD_ROW_SPACE, autoFit, cardHeight, clampScale, clearPositions, loadPositions, positionsKey, savePositions, snapToGrid, type Camera,
} from '../../lib/canvasLayout'
import { addableFor, attachmentsFor, type AddableAttachment, type Attachment } from '../../lib/serviceAttachments'
import { edgeFans, edgeGeometry, layoutGraph, type Point, type ServiceLink } from '../../lib/serviceGraph'
import { deriveStatus, healthFor } from '../../lib/status'
import type { PendingApproval } from '../ApprovalPrompt'
import { TemplateLogo } from '../ui'
import { ServiceActionsMenu } from './ServiceActionsMenu'
import { ServiceTypeIcon } from './ServiceIcon'
import { ServiceStatusIndicator } from './ServiceStatus'
import { createdDate } from './ServiceTable'

export function ServiceCanvas({ projectId, branch, services, links, health, isWaking, onOpen, onAddFirstService, onDone, onError, onApproval }: {
  projectId: string
  branch: string
  services: Service[]
  /** Which service feeds a credential into which (lib/serviceLinks.ts). */
  links: ServiceLink[]
  health?: RuntimeHealthRow[]
  isWaking: (id: string) => boolean
  /** `tab` names the detail tab to open on, for an attachment row; omitted, the service's default tab. */
  onOpen: (service: Service, tab?: string) => void
  /** When set and there are no services, a dashed "Add Your First Service" node renders at the origin —
   *  inside the camera transform, so it pans and zooms like a card. */
  onAddFirstService?: () => void
  onDone: () => void
  onError: (message: string) => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const storageKey = positionsKey(projectId, branch)
  // The bundled catalog, for template logos (ServiceTable reads the same); it changes only with the daemon.
  const { data: templates } = usePoll(api.templates, [], 300_000)
  const logos = useMemo(() => new Map((templates ?? []).map((t) => [t.code, t.logoUrl])), [templates])

  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 })
  // Only dragged cards are stored; everything else sits at its layout slot, so a new service slots in
  // without any migration of saved layouts.
  const [positions, setPositions] = useState<Record<string, Point>>(() => loadPositions(storageKey))

  const wrapperRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; cam: Camera } | null>(null)
  const dragRef = useRef<{ pointerId: number; service: Service; startX: number; startY: number; origin: Point; moved: boolean; last: Point | null } | null>(null)

  const nodeIds = useMemo(() => services.map((s) => s.id), [services])
  const layout = useMemo(() => layoutGraph(nodeIds, links, LAYOUT_METRICS), [nodeIds, links])
  const nodes = useMemo(
    () => services.map((service) => ({ id: service.id, service, point: positions[service.id] ?? layout[service.id]! })),
    [services, positions, layout],
  )
  const nodeSignature = useMemo(() => nodes.map((n) => `${n.id}@${n.point.x},${n.point.y}`).sort().join('|'), [nodes])

  // Both ends resolved to where their card actually is, dragged or not. An edge whose card is gone is
  // dropped first, so it cannot take a fan slot from the edges that have both cards.
  const edges = useMemo(() => {
    const pointOf = new Map(nodes.map((n) => [n.id, n.point]))
    const live = links.filter((l) => pointOf.has(l.sourceId) && pointOf.has(l.targetId))
    // Two cards' columns name the corridor a wire pivots in.
    const fans = edgeFans(live, FAN_MAX, (l) => `${pointOf.get(l.sourceId)!.x}>${pointOf.get(l.targetId)!.x}`)
    // The height a card is actually drawn at, since an edge may come in through its top or bottom edge:
    // the same attachment list the card renders.
    const rowsOf = new Map(nodes.map((n) => [n.id, attachmentsFor(n.service).length]))
    const heightOf = (id: string) => cardHeight(rowsOf.get(id) ?? 0)
    return live.map((l, i) => ({
      id: `${l.sourceId}>${l.targetId}`,
      ...edgeGeometry(pointOf.get(l.sourceId)!, pointOf.get(l.targetId)!, { width: CARD_WIDTH, fromHeight: heightOf(l.sourceId), toHeight: heightOf(l.targetId), portY: PORT_Y }, fans[i]),
    }))
  }, [links, nodes])

  // Mirrors for event handlers and imperative callbacks, which must read the latest values without
  // re-binding on every render.
  const nodesRef = useRef(nodes)
  const positionsRef = useRef(positions)
  useEffect(() => {
    nodesRef.current = nodes
    positionsRef.current = positions
  }, [nodes, positions])

  // --- camera animation ---
  // Programmatic moves (Fit, Tidy, auto-fit) glide; direct manipulation (pan, drag, wheel) stays 1:1
  // with the pointer and CANCELS any glide in flight, so the camera never fights the hand. A JS tween,
  // because the dot-grid background derives from the same camera and its gradient radius is not
  // CSS-animatable.
  const animRef = useRef<number | null>(null)
  const cameraRef = useRef(camera)
  useEffect(() => { cameraRef.current = camera }, [camera])
  const stopCameraAnimation = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current)
      animRef.current = null
    }
  }, [])
  useEffect(() => stopCameraAnimation, [stopCameraAnimation])
  const animateCameraTo = useCallback((target: Camera) => {
    stopCameraAnimation()
    const from = cameraRef.current
    const start = performance.now()
    const DURATION_MS = 450
    // easeInOutCubic — settles gently at both ends.
    const ease = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS)
      const k = ease(t)
      setCamera({ x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k, scale: from.scale + (target.scale - from.scale) * k })
      animRef.current = t < 1 ? requestAnimationFrame(step) : null
    }
    animRef.current = requestAnimationFrame(step)
  }, [stopCameraAnimation])

  const fitView = useCallback((points?: Point[], opts?: { animate?: boolean }) => {
    const el = wrapperRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // With no cards the add-first node sits at the origin: fit that, so an empty canvas opens centered on it.
    const pts = points ?? (nodesRef.current.length > 0 ? nodesRef.current.map((n) => n.point) : [{ x: 0, y: 0 }])
    if (pts.length === 0 || rect.width === 0 || rect.height === 0) return
    const minX = Math.min(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y))
    const width = Math.max(...pts.map((p) => p.x)) - minX + CARD_WIDTH
    // The tallest card, not the shortest: a bottom-row card with a volume row must land inside the fit.
    const height = Math.max(...pts.map((p) => p.y)) - minY + CARD_MAX_HEIGHT
    // Fitting a few cards must not blow them up past 100%.
    const scale = clampScale(Math.min((rect.width - FIT_PADDING * 2) / width, (rect.height - FIT_PADDING * 2) / height, 1))
    const target = { x: (rect.width - width * scale) / 2 - minX * scale, y: (rect.height - height * scale) / 2 - minY * scale, scale }
    if (opts?.animate) animateCameraTo(target)
    else {
      stopCameraAnimation()
      setCamera(target)
    }
  }, [animateCameraTo, stopCameraAnimation])

  // Open centered on the layout, then follow it: the bindings arrive after mount and reshape it. See
  // `autoFit` for what stops that from overruling the user or firing on every render.
  const cameraClaimedRef = useRef(false)
  const fittedRef = useRef<string | null>(null)
  // Another environment's saved layout, and its camera, belong to that environment: switching opens the
  // new one fitted, even after the user panned or zoomed the last. Before the fit below, which then sees
  // an unclaimed camera.
  const keyRef = useRef(storageKey)
  useLayoutEffect(() => {
    if (keyRef.current === storageKey) return
    keyRef.current = storageKey
    cameraClaimedRef.current = false
    fittedRef.current = null
    setPositions(loadPositions(storageKey))
  }, [storageKey])
  useLayoutEffect(() => {
    const { fit, animate } = autoFit(cameraClaimedRef.current, fittedRef.current, nodeSignature)
    if (!fit) return
    // THIS render's points: the mirror above is a passive effect and has not written yet.
    const points = nodes.map((n) => n.point)
    fitView(points.length > 0 ? points : [{ x: 0, y: 0 }], { animate })
    fittedRef.current = nodeSignature
  }, [fitView, nodeSignature, nodes])

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    // Direct manipulation — take the camera back from any glide in flight.
    cameraClaimedRef.current = true
    stopCameraAnimation()
    setCamera((cam) => {
      const scale = clampScale(cam.scale * factor)
      const k = scale / cam.scale
      return { x: cx - (cx - cam.x) * k, y: cy - (cy - cam.y) * k, scale }
    })
  }, [stopCameraAnimation])

  const zoomAtCenter = (factor: number) => {
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (rect) zoomAt(rect.width / 2, rect.height / 2, factor)
  }

  // Native listener: React's onWheel is passive, so it can't preventDefault the page scroll while zooming.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const tidy = () => {
    setPositions({})
    clearPositions(storageKey)
    fitView(Object.values(layout), { animate: true })
  }

  // --- background pan ---
  const onBackgroundPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    cameraClaimedRef.current = true
    stopCameraAnimation()
    panRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, cam: camera }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onBackgroundPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== e.pointerId) return
    setCamera({ ...pan.cam, x: pan.cam.x + (e.clientX - pan.startX), y: pan.cam.y + (e.clientY - pan.startY) })
  }
  const onBackgroundPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null
  }

  // --- card drag (and click-through to the service) ---
  const onCardPointerDown = (e: PointerEvent<HTMLDivElement>, service: Service, origin: Point) => {
    if (e.button !== 0) return
    e.stopPropagation() // keep the background from panning
    // The camera is claimed when a drag actually starts (below), not here: a plain click opens the
    // service and must leave auto-fit following the bindings still to arrive.
    dragRef.current = { pointerId: e.pointerId, service, startX: e.clientX, startY: e.clientY, origin, moved: false, last: null }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onCardPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!drag.moved) {
      drag.moved = true
      cameraClaimedRef.current = true
      stopCameraAnimation()
    }
    const point = { x: snapToGrid(drag.origin.x + dx / camera.scale), y: snapToGrid(drag.origin.y + dy / camera.scale) }
    drag.last = point
    setPositions((prev) => ({ ...prev, [drag.service.id]: point }))
  }
  const onCardPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (drag.moved) {
      const next = {
        ...positionsRef.current,
        [drag.service.id]: { x: snapToGrid(drag.origin.x + (e.clientX - drag.startX) / camera.scale), y: snapToGrid(drag.origin.y + (e.clientY - drag.startY) / camera.scale) },
      }
      setPositions(next)
      savePositions(storageKey, next)
    } else {
      onOpen(drag.service)
    }
  }
  // The browser took the pointer back (a scroll gesture, a lost capture): not a click, so never an open.
  // A drag already under way keeps where it had got to.
  const onCardPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (!drag.moved || !drag.last) return
    // From the drag itself, not the positions mirror, which its passive effect may not have refreshed yet.
    const next = { ...positionsRef.current, [drag.service.id]: drag.last }
    setPositions(next)
    savePositions(storageKey, next)
  }

  return (
    <div
      ref={wrapperRef}
      // Borderless and unrounded: the canvas is full-bleed against the chrome.
      className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-page active:cursor-grabbing"
      style={{
        // The dot radius scales with the camera along with the grid pitch, so zooming reads as the
        // surface itself getting closer, not just wider.
        backgroundImage: `radial-gradient(var(--alpha-12) ${camera.scale}px, transparent ${camera.scale}px)`,
        backgroundSize: `${DOT_SPACING * camera.scale}px ${DOT_SPACING * camera.scale}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
      onPointerCancel={onBackgroundPointerUp}
    >
      <div className="absolute top-0 left-0" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`, transformOrigin: '0 0' }}>
        {nodes.length === 0 && onAddFirstService && (
          <button
            type="button"
            onClick={onAddFirstService}
            // Keep the press from starting a background pan; click still fires.
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute flex cursor-pointer flex-col items-center justify-center gap-2.5 border-2 border-dashed border-alpha-16 bg-semantic-2 text-sm font-medium transition-colors hover:bg-card"
            style={{ left: 0, top: 0, width: CARD_WIDTH, height: CARD_HEIGHT }}
          >
            <Plus className="size-5" />
            Add Your First Service
          </button>
        )}
        {edges.length > 0 && (
          // First child, so every edge paints under the cards it joins. Sized 1×1 and drawn outside
          // itself: the polylines share the cards' coordinate space, including negative coordinates.
          <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1} aria-hidden>
            {edges.map((edge) => (
              <g key={edge.id} className="fill-alpha-16 stroke-alpha-16">
                <path d={edge.d} fill="none" strokeWidth={2} strokeDasharray={WIRE_DASH} />
                <path d={edge.arrow} stroke="none" />
              </g>
            ))}
          </svg>
        )}
        {nodes.map(({ id, service, point }) => {
          const logo = service.type === 'compute' && service.template_code ? logos.get(service.template_code) : undefined
          return (
            <ServiceCard
              key={id}
              point={point}
              service={service}
              mark={logo ? <TemplateLogo src={logo} name={service.name} className="size-8 bg-transparent p-0" /> : <ServiceTypeIcon type={service.type} className="size-8" />}
              status={<ServiceStatusIndicator status={deriveStatus(service, healthFor(health, service.id), isWaking(service.id))} />}
              actions={<ServiceActionsMenu projectId={projectId} branch={branch} service={service} onDone={onDone} onError={onError} onApproval={onApproval} iconClassName="size-5 text-disabled" />}
              onOpen={() => onOpen(service)}
              attachments={attachmentsFor(service)}
              onOpenAttachment={(att) => onOpen(service, att.tab ?? undefined)}
              addable={addableFor(service)}
              onAddAttachment={(att) => onOpen(service, att.tab)}
              onPointerDown={(e) => onCardPointerDown(e, service, point)}
              onPointerMove={onCardPointerMove}
              onPointerUp={onCardPointerUp}
              onPointerCancel={onCardPointerCancel}
            />
          )
        })}
      </div>
      {/* Squared, matching the view toggle. */}
      <div className="absolute right-6 bottom-6 flex flex-col border border-border bg-card" onPointerDown={(e) => e.stopPropagation()}>
        <CanvasControl label="Tidy layout" onClick={tidy}><BrushCleaning className="size-5" /></CanvasControl>
        <CanvasControl label="Fit view" onClick={() => fitView(undefined, { animate: true })}><Focus className="size-5" /></CanvasControl>
        <CanvasControl label="Zoom in" onClick={() => zoomAtCenter(1.2)}><ZoomIn className="size-5" /></CanvasControl>
        <CanvasControl label="Zoom out" onClick={() => zoomAtCenter(1 / 1.2)}><ZoomOut className="size-5" /></CanvasControl>
      </div>
    </div>
  )
}

function CanvasControl({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    // 36px button with a 32px inner state box, like the view toggle.
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className="group flex size-9 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground">
      <span className="flex size-8 items-center justify-center transition-colors group-hover:bg-alpha-4">{children}</span>
    </button>
  )
}

function ServiceCard({ point, service, mark, status, actions, onOpen, attachments, onOpenAttachment, addable, onAddAttachment, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: {
  point: Point
  service: Service
  mark: ReactNode
  status: ReactNode
  actions: ReactNode
  onOpen: () => void
  /** What is mounted, drawn as rows inside the card below its footer (lib/serviceAttachments.ts). */
  attachments: Attachment[]
  onOpenAttachment: (att: Attachment) => void
  /** What the service could still mount: hover-revealed "+ Add" slots under the card. */
  addable: AddableAttachment[]
  onAddAttachment: (att: AddableAttachment) => void
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys from the nested actions menu are not an open: Enter on "Delete Service" must not also open the card.
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen()
    }
  }
  return (
    // Named hover group (`/node`): ServiceActionsMenu declares a bare `group` of its own, and an unnamed
    // one here would light its kebab up from anywhere on the card. The shell, not the card, is the group the
    // "+ Add" slots watch, and while there are slots it pads itself by the row's space: hovering a slot then keeps
    // its own group lit, and the 8px gap between card and slot belongs to the group rather than to neither.
    <div className="group/node absolute select-none"
      style={{ left: point.x, top: point.y, width: CARD_WIDTH, paddingBottom: addable.length > 0 ? ADD_ROW_SPACE : undefined }}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${service.name}`}
        onKeyDown={onKeyDown}
        className={cn(
          // Squared, hairline-bordered card. isolate keeps the -z-10 hover wash above the card's own
          // background; the border steps up to foreground on hover.
          'relative isolate flex cursor-pointer flex-col border border-border bg-card',
          "group-hover/node:border-foreground after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:content-[''] group-hover/node:after:bg-alpha-4",
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {/* 100px header + 40px footer, fixed rather than flexed: the card body is exactly 140px. */}
        <div className="flex h-25 items-start justify-between p-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center bg-semantic-1">{mark}</span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm leading-6">{service.name}</span>
              {status}
            </div>
          </div>
          {/* Keep kebab interactions from starting a drag or an open. */}
          <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>{actions}</span>
        </div>
        <div className="flex h-10 items-center justify-between gap-2 p-3 text-xs whitespace-nowrap">
          <span className="truncate text-muted-foreground">Created {createdDate(service.created_at ?? service.updated_at)}</span>
        </div>
        {attachments.length > 0 && (
          // What is mounted, drawn inside the card below a hairline rule: page-dark rows inset 4px, label left,
          // figure right, each row deep-linking into the tab that manages it. A press on one must not start a
          // drag, and its click must not also open the card.
          <div className="flex flex-col gap-1 border-t border-border p-1" onPointerDown={(e) => e.stopPropagation()}>
            {attachments.map((att) => (
              <button
                key={att.kind}
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenAttachment(att) }}
                className={cn(
                  // The row lifts its own background a notch on hover: the card's alpha-4 wash again, isolated so
                  // the pseudo lands above bg-page and below the label.
                  'relative isolate flex items-center gap-2 bg-page p-2 text-xs text-muted-foreground',
                  "cursor-pointer after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:content-[''] hover:text-foreground hover:after:bg-alpha-4",
                )}
              >
                <HardDrive className="size-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{att.label}</span>
                <span className="shrink-0">{att.meta}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {addable.length > 0 && (
        // What could still be mounted, revealed on hover or keyboard focus 8px clear of the card: equal-width
        // buttons in the card's own chrome. Opacity, not `invisible`, so the buttons stay in the focus order;
        // pointer-events-none keeps a click off a button nobody can see. A press must not pan the canvas beneath.
        <div
          className="pointer-events-none absolute bottom-0 left-0 flex w-full gap-2 opacity-0 transition-opacity group-focus-within/node:pointer-events-auto group-focus-within/node:opacity-100 group-hover/node:pointer-events-auto group-hover/node:opacity-100"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {addable.map((att) => (
            <button
              key={att.kind}
              type="button"
              onClick={() => onAddAttachment(att)}
              className="relative isolate flex h-8 flex-1 cursor-pointer items-center justify-center border border-border bg-card p-1.5 text-sm font-medium text-muted-foreground after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:content-[''] hover:text-foreground hover:after:bg-alpha-4"
            >
              <Plus className="size-5 shrink-0" />
              <span className="truncate px-1">Add {att.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
