import { describe, expect, it } from 'vitest'
import { bucketFromEndpoint, contentTypeFor, formatBytes, objectRows, uploadContentType } from './objectRows'

describe('bucketFromEndpoint', () => {
  it('reads the bucket segment off host[:port]/bucket', () => {
    expect(bucketFromEndpoint('io-garage:3900/io-demo-main-files')).toBe('io-demo-main-files')
    expect(bucketFromEndpoint('host/bucket')).toBe('bucket')
  })
  it('is null without an endpoint or a bucket segment', () => {
    expect(bucketFromEndpoint(undefined)).toBeNull()
    expect(bucketFromEndpoint(null)).toBeNull()
    expect(bucketFromEndpoint('')).toBeNull()
    expect(bucketFromEndpoint('io-garage:3900')).toBeNull()
    expect(bucketFromEndpoint('io-garage:3900/')).toBeNull()
  })
})

describe('formatBytes', () => {
  it('whole bytes under 1 KB, one decimal above', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })
  it('em-dash for garbage', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('contentTypeFor', () => {
  it('guesses from the extension, through folders', () => {
    expect(contentTypeFor('logo.png')).toBe('image/png')
    expect(contentTypeFor('assets/site/logo.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('report.pdf')).toBe('application/pdf')
  })
  it('null for no extension, a dotfile, or an unknown one', () => {
    expect(contentTypeFor('README')).toBeNull()
    expect(contentTypeFor('.env')).toBeNull()
    expect(contentTypeFor('data.xyz9')).toBeNull()
  })
})

describe('uploadContentType', () => {
  it('prefers what the browser says', () => {
    expect(uploadContentType('a.png', 'image/png')).toBe('image/png')
  })
  it('falls back to the extension, then octet-stream (the daemon requires one)', () => {
    expect(uploadContentType('a.png', '')).toBe('image/png')
    expect(uploadContentType('README', '')).toBe('application/octet-stream')
  })
})

describe('objectRows', () => {
  const entry = (key: string, size = 1) => ({ key, size, lastModified: '2026-09-17T00:00:00Z', etag: 'e' })
  it('derives name, type and size text', () => {
    const [row] = objectRows([entry('assets/logo.png', 2048)], '')
    expect(row).toMatchObject({ name: 'logo.png', type: 'image/png', sizeText: '2.0 KB' })
  })
  it('em-dash type for unknown extensions', () => {
    expect(objectRows([entry('README')], '')[0].type).toBe('—')
  })
  it('filters on the FULL key, case-insensitively', () => {
    const rows = objectRows([entry('logos/acme.png'), entry('data.csv')], 'LOGOS')
    expect(rows.map((r) => r.name)).toEqual(['acme.png'])
  })
})
