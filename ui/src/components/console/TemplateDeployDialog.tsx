// The console's Deploy a Template dialog (insta-frontend console/templates/template-deploy-dialog.tsx,
// template-picker.tsx, template-category-rail.tsx): the add-service wizard's View Templates source. An autofocused
// search box over the catalog (↑/↓ and Enter, the combobox pattern), a category rail beside the results, rows with
// logo, name, tagline and category, and Browse All under the list. Picking hands the template's code up; the config
// and deploy come after.
//
// Self-host divergences: rows carry no project count, success rate or maintainer (the daemon's catalog is bundled and
// counts nothing), and show an "only" badge when this machine cannot run the image; Browse All opens the dashboard's
// own gallery page rather than the marketing site.

import { useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Badge, Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@insforge/ui'
import { Check, ChevronRight, LayoutTemplate, Search } from 'lucide-react'
import { api, type TemplateListItem } from '../../api'
import { usePoll } from '../../hooks'
import { ALL_CATEGORIES, runsHere } from '../../lib/catalog'
import { clampHighlight, moveHighlight, pickerView, templateCategoryLabel, type PickerCategory } from '../../lib/templatePicker'
import { TemplateLogo } from '../ui'

function CategoryRail({ categories, total, active, onSelect }: {
  categories: PickerCategory[]; total: number; active: string; onSelect: (key: string) => void
}) {
  const rows = [{ key: ALL_CATEGORIES, label: 'All', count: total }, ...categories]
  return (
    <nav aria-label="Filter by category" className="flex flex-wrap gap-1 sm:w-[200px] sm:shrink-0 sm:flex-col sm:flex-nowrap sm:gap-0">
      {rows.map((row) => {
        const isActive = row.key === active
        return (
          <button key={row.key} type="button" aria-pressed={isActive} onClick={() => onSelect(row.key)}
            className={cn('flex items-center gap-1.5 rounded-md py-2 pr-3 pl-2 text-sm transition-colors sm:w-full',
              isActive ? 'bg-alpha-4 font-medium text-foreground' : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground')}>
            {/* The check keeps its box on every row, so selecting one does not shift the labels. */}
            <Check aria-hidden className={cn('size-4 shrink-0', isActive ? 'opacity-100' : 'opacity-0')} />
            <span className="min-w-0 flex-1 truncate text-left">{row.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{row.count}</span>
          </button>
        )
      })}
    </nav>
  )
}

function ResultRow({ template, id, highlighted, onPick, onHover }: {
  template: TemplateListItem; id: string; highlighted: boolean; onPick: () => void; onHover: () => void
}) {
  return (
    <li role="option" id={id} aria-selected={highlighted}>
      {/* Focus stays on the search input (combobox); the highlight rides aria-activedescendant. */}
      <button type="button" tabIndex={-1} onClick={onPick} onMouseEnter={onHover}
        className={cn('flex w-full items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-colors',
          highlighted ? 'bg-alpha-8' : 'hover:bg-alpha-4')}>
        <TemplateLogo src={template.logoUrl} name={template.name} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">{template.name}</span>
          <span className="line-clamp-1 text-[13px] text-muted-foreground">{template.tagline}</span>
          <span className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
            {template.category && <Badge className="text-muted-foreground">{templateCategoryLabel(template.category)}</Badge>}
            {!runsHere(template) && (
              <Badge className="font-mono text-muted-foreground" title={`This machine is ${template.hostArchitecture}`}>
                {(template.architectures ?? []).join('/')} only
              </Badge>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}

export function TemplateDeployDialog({ open, projectId, branch, onOpenChange, onPicked }: {
  open: boolean; projectId: string; branch: string
  onOpenChange: (open: boolean) => void
  /** The picked template's code. */
  onPicked: (code: string) => void
}) {
  const { data, error, reload } = usePoll(api.templates, [], 60000)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const view = pickerView(data ?? [], query, category)
  const active = clampHighlight(highlight, view.results.length)
  const optionId = (index: number) => `template-option-${index}`

  const move = (delta: number) => {
    if (view.results.length === 0) return
    const next = moveHighlight(active, delta, view.results.length)
    setHighlight(next)
    listRef.current?.querySelector(`#${optionId(next)}`)?.scrollIntoView({ block: 'nearest' })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter') {
      event.preventDefault()
      const picked = view.results[active]
      if (picked) onPicked(picked.code)
    }
  }

  let body
  if (error && !data) {
    body = (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm font-medium">Could not load templates</p>
        <p className="text-sm text-muted-foreground">Something went wrong while fetching the template registry.</p>
        <Button variant="secondary" onClick={reload}>Retry</Button>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus role="combobox" aria-expanded={view.results.length > 0} aria-controls="template-search-results"
            aria-activedescendant={view.results.length > 0 ? optionId(active) : undefined} aria-label="Search templates"
            placeholder="Search templates..." autoComplete="off" spellCheck={false} className="pl-9" value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0) }} onKeyDown={onKeyDown} />
        </div>
        {!data ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-[4.5rem] animate-pulse rounded-lg bg-alpha-8" />)}
          </div>
        ) : view.byQuery.length === 0 ? (
          // Two different nothings: a search that matched nothing, and a catalog with nothing in it.
          query.trim() ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No templates match &ldquo;{query}&rdquo;.</p>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border px-6 py-12 text-center">
              <LayoutTemplate className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">No templates published yet</p>
              <p className="text-sm text-muted-foreground">The registry is empty.</p>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
            <CategoryRail categories={view.categories} total={view.total} active={category}
              onSelect={(next) => { setCategory(next); setHighlight(0) }} />
            {/* The third nothing: the search matched, just not inside the selected category. */}
            {view.results.length === 0 ? (
              <p className="flex-1 py-8 text-center text-sm text-muted-foreground">No matches in this category.</p>
            ) : (
              <ul ref={listRef} id="template-search-results" role="listbox" aria-label="Templates"
                className="flex max-h-[26rem] min-w-0 flex-1 flex-col gap-1 overflow-y-auto">
                {view.results.map((template, index) => (
                  <ResultRow key={template.code} template={template} id={optionId(index)} highlighted={index === active}
                    onPick={() => onPicked(template.code)} onHover={() => setHighlight(index)} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[900px]">
        <DialogHeader>
          <DialogTitle>Deploy a Template</DialogTitle>
        </DialogHeader>
        <DialogBody className="max-h-[70vh] overflow-y-auto">{body}</DialogBody>
        <DialogFooter className="justify-start">
          <Link to={`/p/${projectId}/${branch}/templates`} onClick={() => onOpenChange(false)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            Browse All
            <ChevronRight aria-hidden className="size-3.5" />
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
