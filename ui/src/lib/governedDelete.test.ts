import { describe, expect, it } from 'vitest'
import { afterDelete } from './governedDelete'

describe('afterDelete', () => {
  it('never grants an approval the confirm did not disclose: a pending or failed policy read showed only "Delete"', () => {
    expect(afterDelete({ kind: 'approval', approvalId: 'a1' }, false)).toEqual({ do: 'disclose', approvalId: 'a1' })
  })

  it('grants and retries when the confirm was made with "Approve & delete" showing', () => {
    expect(afterDelete({ kind: 'approval', approvalId: 'a1' }, true)).toEqual({ do: 'grant', approvalId: 'a1' })
  })

  it('finishes on success and reports a refusal, whatever was disclosed', () => {
    expect(afterDelete({ kind: 'ok' }, false)).toEqual({ do: 'done' })
    expect(afterDelete({ kind: 'ok' }, true)).toEqual({ do: 'done' })
    expect(afterDelete({ kind: 'error', error: 'project not found' }, true)).toEqual({ do: 'fail', message: 'project not found' })
  })
})
