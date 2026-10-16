// Custom domains (02 section 10; decision 25). The four routes are the cloud's hidden ones, and the
// envelope is exactly what the CLI renders: `configured` carries the verdict, `dns[].status` is one
// of the cloud's four DnsRecordCheck values, and there is NO `ssl`, `origin`, `edgeOrigin`,
// `originOk` or `originStatus` key. An `ssl` key would make `insta compute check-domain` treat the
// answer as a cloud plane response, demand an ownership TXT record and print UNCONFIRMED.
import { promises as dnsPromises } from 'node:dns'
import type { Config } from '../config'
import { assertHostLabel } from './table'

/** The cloud's DnsRecordCheck (insta-platform adapters/types.ts:271). `pending` is deliberately
 *  absent: the CLI renders it as `unchecked` plus a blocker line. */
export type DnsStatus = 'ok' | 'missing' | 'mismatch' | 'unchecked'

export interface DnsRecordCheck {
  type: 'CNAME'
  name: string
  value: string
  note?: string
  status: DnsStatus
}

export interface ComputeDomainResult {
  hostname: string
  flyApp: string
  configured: boolean
  status: 'pending' | 'ready' | 'not added'
  dns: DnsRecordCheck[]
  service: string
  region: string
}

/** Thrown with `status` so `server.ts` answers 400/404/409 without a second error taxonomy. */
export class DomainError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** An IPv4 or bracketless IPv6 literal is never a routable custom domain. */
const isIpLiteral = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')

/** trim, lowercase, strip a trailing dot, validate every label, refuse IP literals and our own
 *  suffix (a name under `<domain>` is minted, not attached). */
export function normalizeHostname(raw: unknown, cfg: Config): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new DomainError(400, 'hostname required')
  const h = raw.trim().toLowerCase().replace(/\.$/, '')
  if (isIpLiteral(h)) throw new DomainError(400, `invalid hostname ${h}: an IP address cannot be a custom domain`)
  try { assertHostLabel(h) } catch (e) { throw new DomainError(400, e instanceof Error ? e.message : String(e)) }
  if (!h.includes('.')) throw new DomainError(400, `invalid hostname ${h}: a custom domain needs at least one dot`)
  if (h === cfg.domain || h.endsWith(`.${cfg.domain}`)) {
    throw new DomainError(400, `${h} is under ${cfg.domain}, which this daemon already serves; custom domains are names you own elsewhere`)
  }
  return h
}

export interface Resolver {
  resolve4(host: string): Promise<string[]>
  resolveCname(host: string): Promise<string[]>
}

/** Per-query budget for the four domain routes. The stock resolver retries a silent server four
 *  times at five seconds each, so one `insta compute check-domain` against a name whose nameserver
 *  drops packets held an API request for the better part of a minute; `insta compute domains` does
 *  that for every attached name at once. Two tries of two seconds is an upper bound of about eight
 *  seconds for the pair of lookups, and a query that runs out reads as `unchecked`, which is one of
 *  the cloud's four DnsRecordCheck values and exactly what it means. */
export const DNS_TIMEOUT_MS = 2000
export const DNS_TRIES = 2

export const systemResolver: Resolver = {
  resolve4: (host) => new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES }).resolve4(host),
  resolveCname: (host) => new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES }).resolveCname(host),
}

const NOT_FOUND = new Set(['ENOTFOUND', 'NXDOMAIN', 'ENODATA'])
const errCode = (e: unknown): string => String((e as { code?: string }).code ?? '')

/** The addresses that count as "us": the API name's A records plus the recorded public IP.
 *  Resolved ONCE per request by a caller with several hostnames to check. */
export async function ourAddresses(cfg: Config, resolver: Resolver = systemResolver): Promise<Set<string>> {
  const ours = new Set<string>(cfg.publicIp ? [cfg.publicIp] : [])
  try { for (const a of await resolver.resolve4(`api.${cfg.domain}`)) ours.add(a) } catch { /* the API name may be unresolvable on a private box */ }
  return ours
}

/** Run `fn` over `items` with at most `limit` in flight, in order. A `Promise.all` over an
 *  unbounded list of domains fans every one of them into the resolver at once: there is no
 *  project-level cap on domains, so an admin with a large list can start hundreds of
 *  simultaneous DNS operations by accident, on a box whose whole premise is one node. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/** The one record we ask for: a CNAME to `api.<domain>`, or an A record to the box when the installer
 *  recorded a public address. `status` never leaves the cloud's four values. */
export async function checkDns(hostname: string, cfg: Config, resolver: Resolver = systemResolver, ours?: Set<string>): Promise<DnsRecordCheck> {
  const target = `api.${cfg.domain}`
  const record: DnsRecordCheck = {
    type: 'CNAME',
    name: hostname,
    value: target,
    ...(cfg.publicIp ? { note: `or an A record to ${cfg.publicIp}` } : {}),
    status: 'unchecked',
  }

  // What "us" resolves to. It is the SAME lookup for every row of a listing, so a caller with
  // more than one hostname to check resolves it once and passes it in (`ourAddresses`); a list
  // of a few hundred domains otherwise repeats this identical query a few hundred times.
  const addressesOfUs = ours ?? await ourAddresses(cfg, resolver)

  let cnames: string[] = []
  try { cnames = await resolver.resolveCname(hostname) } catch (e) {
    if (!NOT_FOUND.has(errCode(e))) cnames = []
  }
  const cnameHit = cnames.map((c) => c.toLowerCase().replace(/\.$/, '')).includes(target)
  if (cnameHit) return { ...record, status: 'ok' }

  try {
    const addrs = await resolver.resolve4(hostname)
    if (!addrs.length) return { ...record, status: 'missing' }
    if (addrs.some((a) => addressesOfUs.has(a))) return { ...record, status: 'ok' }
    // A CNAME to us that we could not read directly still resolves to our addresses, so a plain
    // address comparison is the honest test; anything else is pointed elsewhere.
    return { ...record, status: 'mismatch' }
  } catch (e) {
    if (NOT_FOUND.has(errCode(e))) return { ...record, status: 'missing' }
    return { ...record, status: 'unchecked' }
  }
}

/** The bound-domain envelope. `configured` = the record resolves to us and (server mode) the edge
 *  holds a certificate; `status` is `ready` once configured, `pending` before. */
export function domainResult(opts: { hostname: string; flyApp: string; service: string; dns: DnsRecordCheck; certOk: boolean }): ComputeDomainResult {
  const configured = opts.dns.status === 'ok' && opts.certOk
  return {
    hostname: opts.hostname,
    flyApp: opts.flyApp,
    configured,
    status: configured ? 'ready' : 'pending',
    dns: [opts.dns],
    service: opts.service,
    region: 'local',
  }
}

/** The unbound answer: the CLI prints `not added` and the CNAME to create. */
export function notAdded(hostname: string, flyApp: string, service: string): ComputeDomainResult {
  return { hostname, flyApp, configured: false, status: 'not added', dns: [], service, region: 'local' }
}
