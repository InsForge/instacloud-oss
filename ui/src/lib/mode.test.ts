import { describe, expect, it } from 'vitest'
import { readBoot } from './mode'

describe('readBoot', () => {
  it('falls back to local mode when window.__INSTA_OSS__ is absent', () => {
    const boot = readBoot({ location: { origin: 'http://127.0.0.1:8080' } }, undefined, undefined)
    expect(boot).toEqual({ mode: 'local', setupRequired: false, apiUrl: 'http://127.0.0.1:8080', consoleUrl: 'http://127.0.0.1:8080', alwaysOnDefault: true })
  })

  it('honours the Vite dev fallback mode when nothing is injected', () => {
    expect(readBoot({ location: { origin: 'http://localhost:5173' } }, 'server', undefined).mode).toBe('server')
    expect(readBoot({ location: { origin: 'http://localhost:5173' } }, 'nonsense', undefined).mode).toBe('local')
  })

  it('passes server flags through from the injected shell', () => {
    const boot = readBoot({
      __INSTA_OSS__: { mode: 'server', setupRequired: true, apiUrl: 'https://api.x.test', consoleUrl: 'https://console.x.test' },
      location: { origin: 'https://console.x.test' },
    }, undefined, undefined)
    // No alwaysOnDefault in this shell: a daemon older than the field, whose default was off.
    expect(boot).toEqual({ mode: 'server', setupRequired: true, apiUrl: 'https://api.x.test', consoleUrl: 'https://console.x.test', alwaysOnDefault: false })
  })

  it('fills missing injected fields from the origin and never trusts a foreign mode string', () => {
    const boot = readBoot({ __INSTA_OSS__: { mode: 'cloud' as never }, location: { origin: 'http://h:1' } }, 'server', undefined)
    expect(boot).toEqual({ mode: 'local', setupRequired: false, apiUrl: 'http://h:1', consoleUrl: 'http://h:1', alwaysOnDefault: false })
  })

  it('treats an injected null as absent', () => {
    expect(readBoot({ __INSTA_OSS__: null, location: { origin: 'http://h:1' } }, undefined, undefined).mode).toBe('local')
  })

  it('runs without a window at all', () => {
    expect(readBoot(undefined, undefined, undefined)).toEqual({ mode: 'local', setupRequired: false, apiUrl: '', consoleUrl: '', alwaysOnDefault: true })
  })

  it('reports the always-on default the daemon actually has, including off', () => {
    // The add dialog starts its switch from this and sends nothing when it is untouched, so a
    // wrong value here is a switch that shows one thing while the daemon creates the other.
    const shell = (alwaysOnDefault?: boolean) =>
      readBoot({ __INSTA_OSS__: { mode: 'server', ...(alwaysOnDefault === undefined ? {} : { alwaysOnDefault }) }, location: { origin: 'https://c.x' } }, undefined, undefined).alwaysOnDefault
    expect(shell(true)).toBe(true)
    expect(shell(false)).toBe(false)
    expect(shell(undefined)).toBe(false)   // an older daemon: its default was off
    // The Vite dev server has no shell and says what its daemon runs with.
    const dev = (v: string | undefined) => readBoot({ location: { origin: 'http://localhost:5173' } }, undefined, v).alwaysOnDefault
    expect(dev('0')).toBe(false)
    expect(dev('false')).toBe(false)
    expect(dev('1')).toBe(true)
    expect(dev(undefined)).toBe(true)
  })
})
