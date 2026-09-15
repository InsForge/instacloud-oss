// The console's project Settings panel (insta-frontend components/project/project-panels.tsx,
// project-settings-view.tsx, project-delete-section.tsx, project-settings-row.tsx): a modal over whatever page is
// open, URL-driven (`?panel=settings[&settings-tab=agent-governance]`) so the sidebar trigger, deep links, refresh
// and the back button all work. General holds the Project Name and Delete Project; Agent Governance the policy.
//
// Self-host divergences: Agent Governance is the daemon's per-action policy (allow / approve / deny, enforced for
// every caller) rather than the console's governance modes and branch protection, which are a local preview there
// and have no daemon counterpart; a rename or delete confirms inline rather than in a toast; and the old Settings
// page's Recent Events card is gone, since the Activities panel is that timeline.

import { useId, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, cn, DialogMessage, Input } from '@insforge/ui'
import { TriangleAlert } from 'lucide-react'
import { api, type Decision } from '../../api'
import { usePoll } from '../../hooks'
import { SETTINGS_TABS, settingsTabFrom, withoutPanel, withSettings } from '../../lib/panels'
import { readDraftName, writeDraftName } from '../../lib/settingsDraft'
import { afterDelete, DISCLOSE_MESSAGE } from '../../lib/governedDelete'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { highlightUnsavedPanelFooter, PanelModal, PanelSaveFooter } from './PanelModal'
import { refreshProjectsNow, useProjectName } from './ProjectSwitcher'

export function ProjectSettingsPanel({ projectId }: { projectId: string }) {
  const [params] = useSearchParams()
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  if (params.get('panel') !== 'settings') return null
  const active = SETTINGS_TABS.find((tab) => tab.id === settingsTabFrom(params.get('settings-tab')))!
  return (
    <PanelModal title={active.label} closeOnOutsideClick={false} onClose={() => navigate(`${pathname}${withoutPanel(search)}`)}
      bodyClassName="flex overflow-hidden p-0"
      sidebar={
        <aside className="shrink-0 border-b border-border bg-semantic-0 sm:w-[200px] sm:border-r sm:border-b-0">
          <h2 className="px-4 py-3 text-base leading-7 font-medium">Settings</h2>
          <nav aria-label="Project settings" className="flex gap-1.5 overflow-x-auto px-3 pb-2 sm:flex-col">
            {SETTINGS_TABS.map((tab) => (
              <Link key={tab.id} to={`${pathname}${withSettings(search, tab.id)}`} aria-current={active.id === tab.id ? 'page' : undefined}
                // Leaving General unmounts its draft, so a tab switch gets the same unsaved-changes guard as closing.
                onClick={(event) => { if (active.id !== tab.id && highlightUnsavedPanelFooter(document)) event.preventDefault() }}
                className={cn(
                  'flex shrink-0 items-center gap-3 rounded p-1.5 text-sm leading-5 transition-colors hover:bg-alpha-4 focus-visible:outline-2 focus-visible:outline-ring',
                  active.id === tab.id ? 'bg-alpha-8 text-foreground' : 'text-muted-foreground',
                )}>
                <span aria-hidden className="size-5 shrink-0 bg-current" style={{ mask: `url(/settings/${tab.icon}.svg) center / contain no-repeat` }} />
                <span className="whitespace-nowrap">{tab.label}</span>
              </Link>
            ))}
          </nav>
        </aside>
      }>
      {active.id === 'general'
        ? <GeneralSettings key={projectId} projectId={projectId} />
        : <AgentGovernance key={projectId} projectId={projectId} />}
    </PanelModal>
  )
}

function SettingsRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 py-3.5 first:pt-0 @min-[600px]:grid-cols-[minmax(0,320px)_minmax(0,1fr)] @min-[600px]:gap-6">
      <div className="min-w-0">
        <h3 className="py-1.5 text-sm font-normal text-foreground">{label}</h3>
        {hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  )
}

function GeneralSettings({ projectId }: { projectId: string }) {
  const formId = useId()
  const listName = useProjectName(projectId) ?? ''
  // The saved name until the shared project list catches up with it, so the field never flashes the old one.
  const [renamedTo, setRenamedTo] = useState<string | null>(null)
  if (renamedTo !== null && listName === renamedTo) setRenamedTo(null)
  const projectName = renamedTo ?? listName
  // `null` = untouched, mirroring the saved name; a string once edited. Kept in lib/settingsDraft.ts as well, so
  // browser Back or Forward, which unmount the panel without its close guard, cannot lose it.
  const [draftName, setDraft] = useState<string | null>(() => readDraftName(projectId))
  const setDraftName = (next: string | null) => {
    writeDraftName(projectId, next)
    setDraft(next)
  }
  const name = draftName ?? projectName
  // A collision with another project's name is about what was typed, so it sits by the field.
  const [renameError, setRenameError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [renamed, setRenamed] = useState(false)

  const nameDirty = draftName !== null && draftName !== projectName
  const canSave = nameDirty && name.trim().length > 0 && name.trim() !== projectName

  const save = async () => {
    if (!canSave || saving) return
    setSaving(true)
    setRenameError(null)
    const result = await api.renameProject(projectId, name.trim())
    setSaving(false)
    if (result.kind === 'error') { setRenameError(result.error); return }
    if (result.kind === 'approval') { setRenameError(`Renaming needs approval (${result.action}).`); return }
    setRenamedTo(result.data.project.name)
    setDraftName(null)
    setRenamed(true)
    refreshProjectsNow()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="@container flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
        <form id={formId} className="shrink-0 border-b border-border" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <SettingsRow label="Project Name">
            <Input value={name} disabled={saving} aria-label="Project name" aria-invalid={renameError ? true : undefined}
              onChange={(e) => {
                setDraftName(e.target.value)
                if (renameError) setRenameError(null)
                if (renamed) setRenamed(false)
              }} />
            {renameError && <p role="alert" className="text-sm text-destructive">{renameError}</p>}
            {renamed && !nameDirty && <p role="status" className="text-sm text-muted-foreground">Project renamed.</p>}
          </SettingsRow>
        </form>
        <div className="shrink-0">
          <DeleteProjectSection projectId={projectId} projectName={projectName} />
        </div>
      </div>
      {nameDirty && (
        <PanelSaveFooter>
          <DialogMessage icon={null}>Unsaved changes</DialogMessage>
          <Button type="button" variant="outline" size="sm" disabled={saving}
            onClick={() => { setDraftName(null); setRenameError(null) }}>Discard</Button>
          <Button type="submit" form={formId} variant="primary" size="sm" disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </PanelSaveFooter>
      )}
    </div>
  )
}

function DeleteProjectSection({ projectId, projectName }: { projectId: string; projectName: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gated, setGated] = useState(false)
  // Read while the dialog is open, so a governed delete says "Approve & delete" BEFORE the confirm, not only once
  // the DELETE has come back asking. `gated` still covers a policy changed after this read.
  const { data: policy } = usePoll(() => api.policy(projectId), [projectId], { intervalMs: 30_000, enabled: open })
  const needsApproval = gated || policy?.['project.delete'] === 'approve'
  // The confirm dialog closes once its action resolves; a failed delete marks itself here so that close is skipped
  // and the error stays readable. Cancel still closes, because only the failure's own close is consumed.
  const failed = useRef(false)
  // A delete in flight: Cancel is disabled and every other close is refused until it answers, so the dialog can
  // neither be dismissed mid-request nor reopened to send a second DELETE. A ref, because the close handler runs
  // right after the request settles, before a re-render could refresh a state value.
  const deleting = useRef(false)
  const [busy, setBusy] = useState(false)

  const fail = (message: string) => {
    setError(message)
    failed.current = true
  }

  // An approval the daemon asked for on an earlier, undisclosed confirm: the next confirm grants THIS one rather
  // than raising another (lib/governedDelete.ts).
  const pendingApproval = useRef<string | null>(null)

  const remove = async () => {
    if (deleting.current) return
    deleting.current = true
    setBusy(true)
    // What the confirm button said when it was clicked: only a confirm made with "Approve & delete" showing may grant.
    const disclosed = needsApproval
    try {
      await attemptDelete(disclosed)
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  const grantAndRetry = async (approvalId: string) => {
    const grant = await api.decide(projectId, approvalId, 'approve')
    if (grant.kind === 'error') return fail(grant.error)
    pendingApproval.current = null
    const retried = await api.deleteProject(projectId)
    if (retried.kind === 'error') return fail(retried.error)
    if (retried.kind === 'approval') return fail('The delete still needs approval. Open Notifications to approve it.')
    finish()
  }

  const finish = () => {
    refreshProjectsNow()
    navigate('/')
  }

  const attemptDelete = async (disclosed: boolean) => {
    setError(null)
    // A second confirm after a disclosure grants the approval the first one raised.
    if (disclosed && pendingApproval.current) return grantAndRetry(pendingApproval.current)
    const result = await api.deleteProject(projectId)
    const next = afterDelete(result.kind === 'approval' ? { kind: 'approval', approvalId: result.approvalId } : result.kind === 'error' ? result : { kind: 'ok' }, disclosed)
    if (next.do === 'done') return finish()
    if (next.do === 'fail') return fail(next.message)
    if (next.do === 'grant') return grantAndRetry(next.approvalId)
    pendingApproval.current = next.approvalId
    setGated(true)
    fail(DISCLOSE_MESSAGE)
  }

  return (
    <>
      <section className="flex flex-col gap-4 rounded-md border border-destructive/50 bg-destructive/5 p-4 @min-[600px]:flex-row @min-[600px]:items-center">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-normal text-foreground">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
            Delete Project
          </h3>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Deleting the project will permanently delete all services and data stored. This can not be undone.
          </p>
        </div>
        <Button type="button" variant="destructive" size="sm" className="shrink-0 self-end @min-[600px]:self-center"
          onClick={() => { setError(null); setGated(pendingApproval.current !== null); failed.current = false; setOpen(true) }}>
          Delete Project
        </Button>
      </section>

      <ConfirmDeleteDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && failed.current) { failed.current = false; return }
          if (!next && deleting.current) return
          setOpen(next)
        }}
        title="Delete Project"
        name={projectName}
        description={
          <span className="flex flex-col gap-2">
            <span>
              This permanently deletes <span className="font-semibold text-foreground">{projectName}</span> and destroys all of its
              resources. This action cannot be undone.
            </span>
            {needsApproval && (
              <span className="rounded-md bg-warning/10 px-2.5 py-2 text-[13px] leading-[18px] text-warning">
                This project&apos;s policy requires approval to delete it. Confirming approves the request and deletes the project in one step.
              </span>
            )}
            {error && <span role="alert" className="text-[13px] leading-[18px] text-destructive">{error}</span>}
          </span>
        }
        confirmText={needsApproval ? 'Approve & delete' : 'Delete'}
        cancelText="Cancel"
        isLoading={busy}
        onConfirm={remove}
      />
    </>
  )
}

const DECISIONS: Decision[] = ['allow', 'approve', 'deny']
const HINT: Record<Decision, string> = {
  allow: 'Runs immediately.',
  approve: 'Queues for a human grant (202).',
  deny: 'Always rejected (403).',
}

function DecisionToggle({ label, value, onChange }: { label: string; value: Decision; onChange: (d: Decision) => void }) {
  return (
    <div role="group" aria-label={label} className="grid w-fit grid-cols-3 border border-border bg-card">
      {DECISIONS.map((d) => (
        <button key={d} type="button" aria-pressed={value === d} title={HINT[d]} onClick={() => onChange(d)}
          className={cn('h-8 w-24 px-2 text-[13px] capitalize transition-colors',
            value === d
              ? d === 'deny' ? 'bg-destructive/15 font-medium text-destructive'
                : d === 'approve' ? 'bg-warning/15 font-medium text-warning'
                : 'bg-success/15 font-medium text-success'
              : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground')}>
          {d}
        </button>
      ))}
    </div>
  )
}

function AgentGovernance({ projectId }: { projectId: string }) {
  const { data: policy, error: loadError, reload } = usePoll(() => api.policy(projectId), [projectId])
  const [error, setError] = useState<string | null>(null)

  const set = async (action: string, decision: Decision) => {
    setError(null)
    const result = await api.setPolicy(projectId, action, decision)
    if (result.kind === 'error') return setError(result.error)
    reload()
  }

  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      <p className="pb-4 text-xs leading-5 text-muted-foreground">
        Per-action gates, enforced by the daemon for every caller: the CLI, an agent, or this dashboard.
      </p>
      {error && <p role="alert" className="pb-3 text-sm text-destructive">{error}</p>}
      {!policy ? (
        <p className="text-sm text-muted-foreground">{loadError ? "The daemon couldn't return the policy." : 'Loading…'}</p>
      ) : (
        <div className="divide-y divide-border">
          {Object.entries(policy).map(([action, decision]) => (
            <SettingsRow key={action} label={action} hint={HINT[decision]}>
              <DecisionToggle label={action} value={decision} onChange={(d) => { void set(action, d) }} />
            </SettingsRow>
          ))}
        </div>
      )}
    </div>
  )
}
