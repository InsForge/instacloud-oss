// Bidirectional byte splice with backpressure, half-close propagation and an idle cut (02 section 7).
// Every non-empty chunk in either direction calls `onBytes` (the TCP lanes stamp activity there:
// sleep-and-wake.md 1.2, TCP row); a silent open connection stamps nothing and is cut after
// `idleMs` (0 disables the cut, used by WebSocket passthrough which is time-held instead).
import type { Duplex } from 'node:stream'

export interface SpliceOpts {
  idleMs: number
  onBytes: () => void
  onClose?: () => void
}

export function splice(a: Duplex, b: Duplex, opts: SpliceOpts): void {
  let last = Date.now()
  let ended = 0
  let closed = false
  let timer: NodeJS.Timeout | null = null
  let drain: NodeJS.Timeout | null = null
  const finish = (): void => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    if (drain) clearTimeout(drain)
    a.destroy()
    b.destroy()
    opts.onClose?.()
  }
  const pump = (src: Duplex, dst: Duplex): void => {
    src.on('data', (chunk: Buffer) => {
      if (chunk.length) { last = Date.now(); opts.onBytes() }
      if (!dst.write(chunk)) {
        src.pause()
        dst.once('drain', () => src.resume())
      }
    })
    src.on('end', () => {
      dst.end()
      // half-close: let the other direction drain for 2 s, then tear both down
      if (++ended === 1 && !drain) { drain = setTimeout(finish, 2000); drain.unref() }
    })
    src.on('error', finish)
    src.on('close', finish)
  }
  pump(a, b)
  pump(b, a)
  a.resume()
  b.resume()
  if (opts.idleMs > 0) {
    timer = setInterval(() => { if (Date.now() - last >= opts.idleMs) finish() }, Math.min(opts.idleMs, 30_000))
    timer.unref()
  }
}
