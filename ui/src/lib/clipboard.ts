// Copying text on a self-hosted dashboard. `navigator.clipboard` exists only in a secure context (HTTPS or
// localhost), and a self-hosted daemon is often reached over plain HTTP on a LAN address, where it is
// undefined. The fallback is the pre-Clipboard-API route: a selected, off-screen textarea and
// `document.execCommand('copy')`. The browser objects are parameters, so this runs under the root vitest
// config with fakes.

export type ClipboardEnv = {
  clipboard?: { writeText(text: string): Promise<void> }
  document?: {
    createElement(tag: 'textarea'): { value: string; style: { position: string; opacity: string }; setAttribute(name: string, value: string): void; select(): void }
    execCommand(command: 'copy'): boolean
    body: { appendChild(node: unknown): unknown; removeChild(node: unknown): unknown }
  }
}

/** Copies `text`, and resolves whether it actually reached the clipboard: callers show "Copied" only then. */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text)
      return true
    } catch {
      // Denied (permissions, an unfocused document): the fallback below may still work.
    }
  }
  const doc = env.document
  if (!doc) return false
  const area = doc.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  doc.body.appendChild(area)
  try {
    area.select()
    return doc.execCommand('copy')
  } catch {
    return false
  } finally {
    doc.body.removeChild(area)
  }
}

function browserEnv(): ClipboardEnv {
  if (typeof window === 'undefined') return {}
  return {
    clipboard: window.isSecureContext ? navigator.clipboard : undefined,
    document: document as unknown as ClipboardEnv['document'],
  }
}
