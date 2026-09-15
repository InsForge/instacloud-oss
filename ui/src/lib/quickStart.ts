// The Quick Start page's commands, agent prompt and cards, ported from the console (insta-frontend
// lib/agent-setup.ts and components/project/quick-start/quick-start-page-view.tsx). Pure: every input
// is a parameter, so it runs under the root vitest config.
//
// Self-host divergences, each because the console's version would set the user up on the cloud
// instead of this daemon:
//   - no `insta setup agent`: it registers the cloud MCP server whatever the API URL, and without
//     $INSTA_API_URL it pins the CLI to production. The CLI is installed, pointed at this daemon and
//     links the project instead.
//   - the prompt is written out here rather than fetched from instacloud.com/prompt.md, which walks
//     an agent through the cloud's setup.
//   - server mode signs in with an API token (`--api-key`): the daemon has no browser login, and
//     local mode needs none at all (the daemon trusts loopback).
//   - the service card offers no GitHub source (the daemon has no GitHub deploy), and Read Docs opens
//     the self-hosting guide.

import type { RunMode } from './mode'

export const DOCS_URL = 'https://docs.instacloud.com/self-hosting/overview'
/** The variable the copied server-mode line reads the token from. A key is shown only once, on creation,
 *  so the line cannot carry it; and a `<placeholder>` pasted unedited is a shell redirection, while an
 *  unset variable is only an empty key the CLI rejects. */
export const API_TOKEN_ENV = 'INSTA_API_TOKEN'

const INSTALL = 'npm install -g insta'

/** The setup as one shell command per step: install, point at this daemon, link this project. The Service page's
 *  connect-agent panel gives each its own copy row, as the console does: `&&` is a syntax error in Windows PowerShell
 *  5.1, and a multi-line paste loses queued lines on shells without bracketed paste. */
export function cliSteps(projectId: string, mode: RunMode, apiUrl: string): string[] {
  const point = mode === 'server'
    ? `insta login --api-key "$${API_TOKEN_ENV}" --api-url ${apiUrl}`
    : `export INSTA_API_URL=${apiUrl}`
  return [INSTALL, point, `insta project link ${projectId}`]
}

/** The one CLI line the "CLI" chip copies: the same steps, chained. */
export function cliLine(projectId: string, mode: RunMode, apiUrl: string): string {
  return cliSteps(projectId, mode, apiUrl).join(' && ')
}

/** The one prompt the "Prompt" chip copies, for a coding agent to run the same setup. */
export function setupPrompt(projectId: string, mode: RunMode, apiUrl: string, consoleUrl: string): string {
  const signIn = mode === 'server'
    ? `set ${API_TOKEN_ENV} to an API token I create at ${consoleUrl}/account/tokens (ask me for it) and sign in with "insta login --api-key $${API_TOKEN_ENV} --api-url ${apiUrl}"`
    : `point it at the daemon with "export INSTA_API_URL=${apiUrl}" and keep that set for later insta commands`
  return `Connect this repo to my self-hosted InstaCloud at ${apiUrl}: install the insta CLI with "${INSTALL}", ${signIn}, then run "insta project link ${projectId}". Do not run "insta setup agent" here: it registers the cloud MCP server, not this daemon.`
}

export type QuickStartCard = {
  title: string
  description: string
  cta: string
  href: string
  kind: 'database' | 'service' | 'agent'
}

/** The three cards, each deep-linking into the page and dialog that does it, as on the console. */
export function quickStartCards(projectId: string, branch: string): QuickStartCard[] {
  const env = `/p/${projectId}/${encodeURIComponent(branch)}`
  return [
    {
      title: 'Add a Database',
      description: 'Create a PostgreSQL database in this branch.',
      cta: 'Add Database',
      href: `${env}/services?add=postgres`,
      kind: 'database',
    },
    {
      title: 'Deploy your first service',
      description: 'Add a service from a Docker image, a template, a database, or storage.',
      cta: 'Create Service',
      href: `${env}/services?add=service`,
      kind: 'service',
    },
    {
      title: 'Deploy your agents',
      description: 'Run Claude Code on this box from the claude-code template.',
      cta: 'Deploy Agents',
      href: `${env}/templates?template=claude-code`,
      kind: 'agent',
    },
  ]
}

/** What a Services page `?add=` deep link opens: the Postgres dialog, the full source picker, or nothing. */
export function addIntent(param: string | null): 'postgres' | 'picker' | null {
  if (param === 'postgres') return 'postgres'
  if (param === 'service') return 'picker'
  return null
}
