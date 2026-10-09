import { describe, expect, it } from 'vitest'
import type { ApiResult, SecretTree } from '../api'
import { afterLoad, loadSecretTree, markGated, pollsTree, treeFor } from './secretTreeLoad'

const tree = (name: string): SecretTree => ({ branches: [{ name, services: [] }] }) as unknown as SecretTree
const answering = (r: ApiResult<SecretTree>) => async () => r

describe('loadSecretTree', () => {
  it('tags a tree with the project it was read for', async () => {
    expect(await loadSecretTree(answering({ kind: 'ok', data: tree('main') }), 'A')).toEqual({ projectId: 'A', tree: tree('main'), gated: false })
  })

  it('an approval is gated, with no tree and no throw', async () => {
    const r = await loadSecretTree(answering({ kind: 'approval', action: 'secrets.read', approvalId: 'ap1' }), 'B')
    expect(r).toEqual({ projectId: 'B', tree: null, gated: true })
  })

  it('a refusal is gated too', async () => {
    const r = await loadSecretTree(answering({ kind: 'error', status: 403, error: 'denied by policy' }), 'B')
    expect(r.gated).toBe(true)
  })

  it('any other failure throws, so the poll retries it', async () => {
    await expect(loadSecretTree(answering({ kind: 'error', status: 500, error: 'boom' }), 'A')).rejects.toThrow('boom')
  })
})

describe('treeFor', () => {
  it("never draws project A's tree on project B (the poll hook keeps A's data across the switch)", () => {
    expect(treeFor({ projectId: 'A', tree: tree('main'), gated: false }, 'B')).toBeUndefined()
  })

  it('draws the tree on the project it was read for', () => {
    expect(treeFor({ projectId: 'A', tree: tree('main'), gated: false }, 'A')).toEqual(tree('main'))
  })

  it('authorized A, then approval-gated B: B draws nothing', () => {
    expect(treeFor({ projectId: 'B', tree: null, gated: true }, 'B')).toBeUndefined()
    expect(treeFor(undefined, 'B')).toBeUndefined()
  })
})

describe('pollsTree, markGated and afterLoad', () => {
  const none: ReadonlySet<string> = new Set()
  const gatedLoad = (projectId: string) => ({ projectId, tree: null, gated: true })

  it('only the canvas polls', () => {
    expect(pollsTree(none, 'A', 'list')).toBe(false)
    expect(pollsTree(none, 'A', 'canvas')).toBe(true)
  })

  it('stops for a project whose read was gated, and not for another project', () => {
    const gated = afterLoad(none, gatedLoad('A'))
    expect(pollsTree(gated, 'A', 'canvas')).toBe(false)
    expect(pollsTree(gated, 'B', 'canvas')).toBe(true)
  })

  it('out of order: B comes back gated, then a stale read for A comes back gated; B stays gated', () => {
    const gated = afterLoad(afterLoad(none, gatedLoad('B')), gatedLoad('A'))
    expect(pollsTree(gated, 'B', 'canvas')).toBe(false)
    expect(pollsTree(gated, 'A', 'canvas')).toBe(false)
  })

  it('a stale read for A that came back authorized leaves B gated', () => {
    const gated = afterLoad(none, gatedLoad('B'))
    expect(afterLoad(gated, { projectId: 'A', tree: tree('main'), gated: false })).toBe(gated)
    expect(pollsTree(gated, 'B', 'canvas')).toBe(false)
  })

  it('marking a project that is already gated returns the same set, so there is no extra render', () => {
    const gated = markGated(none, 'B')
    expect(markGated(gated, 'B')).toBe(gated)
  })
})
