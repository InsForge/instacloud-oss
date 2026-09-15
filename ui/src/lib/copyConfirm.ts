// Which copy row of the connect-agent panel says "Copied". Pure so the root vitest covers it.
//
// The confirmation belongs to what was copied, not to a row position. Each mode's first row used to share index key 0,
// so React kept that row's "Copied" state across a Use CLI / Use Prompt switch and confirmed text that was never copied.
// The panel now remembers the key of the row that was copied, and a row is confirmed only when its own key matches.

export type CopyMode = 'prompt' | 'cli'

/** A row's identity: its mode and its exact text. Also its React key, so a mode switch remounts the rows. The mode is
 *  a fixed word with no `|`, so everything before the first `|` is always the mode and no two rows can collide. */
export function copyRowKey(mode: CopyMode, text: string): string {
  return `${mode}|${text}`
}

/** Whether the row showing `text` in `mode` is the one that was copied. */
export function isCopyConfirmed(copiedKey: string | null, mode: CopyMode, text: string): boolean {
  return copiedKey !== null && copiedKey === copyRowKey(mode, text)
}
