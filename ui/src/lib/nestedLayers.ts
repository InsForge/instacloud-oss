// Which open layers a hand-rolled overlay (ServiceDetailModal, PanelModal) must defer its Escape and focus trap to.
// Pure so the root vitest covers it; components/console/nestedDialog.ts queries the document with it.
//
// The kit's Radix layers portal to document.body, outside the overlay's DOM root, and every one of them is marked
// `data-state="open"` while open:
//   dialog / alertdialog   Dialog, AlertDialog, and Popover content (the Metrics time range picker)
//   menu                   DropdownMenu content (the Variables sort and row menus, the Logs Severity and Copy Logs menus)
//   listbox                Select content
// A menu or listbox missed here closed the whole overlay on one Escape: the overlay listens on window capture, which
// runs before Radix's document-capture dismiss can prevent the event.

export const NESTED_LAYER_ROLES = ['dialog', 'alertdialog', 'menu', 'listbox'] as const

/** `[role="dialog"][data-state="open"],…` for every role above. */
export const OPEN_NESTED_LAYER_SELECTOR = NESTED_LAYER_ROLES.map((role) => `[role="${role}"][data-state="open"]`).join(',')
