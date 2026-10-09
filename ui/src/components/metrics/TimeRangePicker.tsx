// The console's time range control (insta-frontend components/time-range-picker.tsx): a "1 hour PDT"
// trigger whose panel offers quick ranges and a hand-entered From / until, read and written in the viewer's
// zone to match the chart axis. Every choice applies as it is made (a preset, a calendar day, a time, or
// Enter in a field), so there is no Apply button, and focus moving on its own applies nothing.
//
// Self-host divergence: the quick ranges stop at 7 day (no console 30 day) and a custom range may reach
// back only seven days, the daemon's retention (lib/metricRanges.ts).

import { useRef, useState } from 'react'
import { Calendar, ClockColumn, cn, Input, Popover, PopoverContent, PopoverTrigger } from '@insforge/ui'
import { CalendarDays, ChevronDown, Clock } from 'lucide-react'
import {
  activeRange, customRange, HOUR_OPTIONS, localZoneAbbr, MAX_LOOKBACK_DAYS, MINUTE_OPTIONS,
  parseLocalInput, pickerFields, PRESET_KEYS, RANGES, rangeLabel, timeOfDayText, withPickedDay, withPickedTime,
  type ActiveRange, type RangeKey,
} from '../../lib/metricRanges'

/** One end of a hand-entered range: a text field, plus a day grid and time lists to pick with. */
function RangeField({ id, label, value, placeholder, onChange, onCommit }: {
  id: string
  label: string
  value: string
  placeholder: string
  onChange: (next: string) => void
  /** Called with the value to apply, passed explicitly since setState has not landed yet. */
  onCommit: (next: string) => void
}) {
  const [calendarOpen, setCalendarOpen] = useState(false)
  const selected = parseLocalInput(value)
  const [hour, minute] = (timeOfDayText(value) || '00:00').split(':')

  // An hour alone is half a time, so it leaves the panel open; the minute finishes and closes it.
  function applyTime(hhmm: string, done: boolean) {
    const next = withPickedTime(value, hhmm, Date.now())
    onChange(next)
    onCommit(next)
    if (done) setCalendarOpen(false)
  }

  return (
    <div className="min-w-0 flex-1">
      <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={id}>{label}</label>
      <div className="relative">
        <Input id={id} className="pr-9" value={value} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          // Enter, not blur: moving focus to the calendar button is not an edit.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onCommit(value)
            }
          }} />
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger aria-label={`Pick the ${label} date`}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground">
            <CalendarDays className="size-4" />
          </PopoverTrigger>
          {/* Lists, not an <input type="time">: a native one reports a change while the minutes are still
              half-typed, so there is no moment to close on. A picked row is that moment. */}
          <PopoverContent className="flex w-auto gap-3 p-3" align="end">
            <Calendar mode="single"
              selected={selected === null ? undefined : new Date(selected * 1000)}
              defaultMonth={selected === null ? undefined : new Date(selected * 1000)}
              onSelect={(day: Date | undefined) => {
                if (!day) return
                const next = withPickedDay(value, day)
                onChange(next)
                onCommit(next)
                setCalendarOpen(false)
              }} />
            <div className="flex gap-1 border-l border-border pl-3">
              <ClockColumn options={HOUR_OPTIONS} selected={hour ?? '00'} onPick={(h) => applyTime(`${h}:${minute}`, false)} />
              <ClockColumn options={MINUTE_OPTIONS} selected={minute ?? '00'} onPick={(m) => applyTime(`${hour}:${m}`, true)} />
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

export function TimeRangePicker({ value, onChange, busy = false, align = 'start' }: {
  value: ActiveRange
  onChange: (next: ActiveRange) => void
  /** Dims the control while another range's data is still on screen. */
  busy?: boolean
  /** The edge the panel hangs from: the side the trigger sits on, or it has no room. */
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [fromText, setFromText] = useState('')
  const [untilText, setUntilText] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** The pair as last applied, so an unchanged commit can be dropped. */
  const applied = useRef({ from: '', until: '' })

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      // Both ends mirror the window on screen NOW: a preset has rolled since it was picked.
      const { from, until } = pickerFields(value, Date.now())
      setFromText(from)
      setUntilText(until)
      applied.current = { from, until }
      setError(null)
    }
  }

  function pickPreset(key: RangeKey) {
    onChange(activeRange(key, Date.now()))
    setOpen(false)
  }

  /** Apply the pair if it makes a range. An empty From stays quiet; unreadable text is reported. */
  function commit(nextFrom: string, nextUntil: string) {
    if (nextFrom === applied.current.from && nextUntil === applied.current.until) return
    const from = parseLocalInput(nextFrom)
    if (from === null) {
      setError(nextFrom.trim() ? 'Enter a start time as yyyy-mm-dd hh:mm.' : null)
      return
    }
    const nowMs = Date.now()
    // An empty Until means now, which is what the placeholder promises.
    const to = nextUntil.trim() ? parseLocalInput(nextUntil) : Math.floor(nowMs / 1000)
    if (to === null) {
      setError('Enter an end time as yyyy-mm-dd hh:mm, or leave it empty for now.')
      return
    }
    if (to <= from) {
      setError('The end time must come after the start time.')
      return
    }
    const range = to > Math.floor(nowMs / 1000) ? null : customRange(from, to, nowMs)
    if (!range) {
      setError(`Choose a range within the last ${MAX_LOOKBACK_DAYS} days.`)
      return
    }
    setError(null)
    applied.current = { from: nextFrom, until: nextUntil }
    onChange(range)
  }

  const zone = localZoneAbbr(new Date())

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger className={cn(
        'flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-alpha-4',
        busy && 'opacity-70',
      )}>
        <Clock className="size-4 text-muted-foreground" />
        <span>{rangeLabel(value)}</span>
        {zone && <span className="text-muted-foreground">{zone}</span>}
        <ChevronDown className="size-4 text-muted-foreground" />
      </PopoverTrigger>

      {/* A fixed width, because nothing inside has one: the From / until inputs are flex-1 and the preset
          labels can wrap, so an auto-sized panel collapses to min-content. */}
      <PopoverContent align={align} className="w-88 max-w-[calc(100vw-2rem)] p-3">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Quick range</p>
        <div className="grid grid-cols-3 gap-1.5">
          {PRESET_KEYS.map((key) => (
            <button key={key} type="button" onClick={() => pickPreset(key)}
              className={cn(
                'rounded-md border border-border px-2 py-1.5 text-sm whitespace-nowrap transition-colors hover:bg-alpha-4',
                value.range === key ? 'bg-alpha-8 font-medium text-foreground' : 'text-foreground',
              )}>
              {RANGES[key].label}
            </button>
          ))}
        </div>

        <div className="my-3 border-t border-border" />

        <div className="flex items-end gap-1.5">
          <RangeField id="time-range-from" label="From" value={fromText} placeholder="yyyy-mm-dd hh:mm"
            onChange={setFromText} onCommit={(next) => commit(next, untilText)} />
          <RangeField id="time-range-until" label="until" value={untilText} placeholder="Now"
            onChange={setUntilText} onCommit={(next) => commit(fromText, next)} />
        </div>

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
