// What Delete Project does after the daemon answers a DELETE, pure so the root vitest covers it. The console chains
// a `project.delete` approval straight into approve + retry, on the grounds that whoever confirmed the delete can
// grant it. That only holds if the dialog TOLD them it would: the policy is read after the dialog opens, so a
// confirm can land while that read is pending or failed, with the button still saying "Delete". An approval the
// user was not shown is therefore never granted on that click; the dialog discloses it and asks for a second
// confirm, which grants that same approval.

export type DeleteAnswer = { kind: 'ok' } | { kind: 'error'; error: string } | { kind: 'approval'; approvalId: string }

export type DeleteNext =
  | { do: 'done' }
  | { do: 'fail'; message: string }
  /** The confirm was made with "Approve & delete" showing: grant this approval and retry the delete. */
  | { do: 'grant'; approvalId: string }
  /** The confirm said only "Delete": show the approval and ask again, keeping this approval for that confirm. */
  | { do: 'disclose'; approvalId: string }

export function afterDelete(answer: DeleteAnswer, disclosed: boolean): DeleteNext {
  if (answer.kind === 'ok') return { do: 'done' }
  if (answer.kind === 'error') return { do: 'fail', message: answer.error }
  return disclosed ? { do: 'grant', approvalId: answer.approvalId } : { do: 'disclose', approvalId: answer.approvalId }
}

export const DISCLOSE_MESSAGE = "This project's policy requires approval to delete it. Confirm again to approve the request and delete the project."
