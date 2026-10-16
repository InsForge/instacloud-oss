import { describe, expect, it } from 'vitest'
import type { Service } from '../api'
import { servicesFor } from './servicesLoad'

const web = { id: 'cp-web', type: 'compute', name: 'web' } as unknown as Service

describe('servicesFor', () => {
  it('draws a read for the scope on screen, an empty one included', () => {
    expect(servicesFor({ projectId: 'p1', branch: 'main', services: [web] }, 'p1', 'main')).toEqual([web])
    expect(servicesFor({ projectId: 'p1', branch: 'main', services: [] }, 'p1', 'main')).toEqual([])
  })
  it("ignores the previous branch's or project's read while the new one is loading, or after it failed", () => {
    // The reported case: an empty branch's read must not make the next branch look empty.
    const emptyFeat = { projectId: 'p1', branch: 'feat', services: [] }
    expect(servicesFor(emptyFeat, 'p1', 'main')).toBeUndefined()
    expect(servicesFor({ projectId: 'p2', branch: 'main', services: [] }, 'p1', 'main')).toBeUndefined()
  })
  it('treats no read yet as not loaded', () => {
    expect(servicesFor(undefined, 'p1', 'main')).toBeUndefined()
  })
})
