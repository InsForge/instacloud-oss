// Shared by the dashboard's hand-rolled overlays (ServiceDetailModal, PanelModal), which are plain fixed divs
// rather than the kit's Dialog and so run their own focus trap and Escape handling. Both mark themselves
// `data-state="open"` like a Radix dialog, so each can tell when the other is stacked on top of it: Settings opens
// over an open service detail (`?service=` survives `?panel=settings`).

/** Is a dialog OPEN above this overlay?
 *
 *  Restart, Delete and the approval prompt are the kit's Radix Dialog, which PORTALS to
 *  document.body — outside the overlay's DOM root. So does a Radix Popover: the Metrics tab's time range
 *  picker renders its panel as `role="dialog"` with `data-state="open"`, so it is covered too, and Tab
 *  walks its quick ranges while one Escape closes only the picker. Both the focus trap and the Escape handler have
 *  to stand down for them: the trap because the nested dialog's own buttons look like "focus
 *  outside", and Escape because Radix dismisses on it without guaranteeing the native event is
 *  default-prevented, so one press would close the dialog AND the overlay behind it.
 *
 *  Keyed on `data-state="open"`, not mere presence, so an unrelated dialog element or one still
 *  mounted through a close animation cannot silently disable either guard.
 *
 *  Only a dialog LATER in the document counts, because later is on top here: portals append to the end of body,
 *  and Settings mounts after the page that holds the service detail. Without that, the Settings panel would find
 *  the service detail underneath it and stand its own trap and Escape down, and the two would each defer to the
 *  other. */
export function hasOpenNestedDialog(root: HTMLElement | null): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]'),
  ).some((d) => d !== root && !root?.contains(d)
    && (!root || (root.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0))
}
