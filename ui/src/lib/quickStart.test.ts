import { describe, expect, it } from 'vitest'
import { addIntent, API_TOKEN_ENV, cliLine, DOCS_URL, quickStartCards, setupPrompt } from './quickStart'

const LOCAL = 'http://127.0.0.1:8080'
const SERVER = 'https://api.example.test'

describe('cliLine', () => {
  it('local mode points the CLI at this daemon and links the project, with no login', () => {
    const line = cliLine('pr_1', 'local', LOCAL)
    expect(line).toContain('npm install -g insta')
    expect(line).toContain(`export INSTA_API_URL=${LOCAL}`)
    expect(line).toContain('insta project link pr_1')
    expect(line).not.toContain('insta login')
  })

  it('server mode signs in with an API token against this daemon, then links', () => {
    const line = cliLine('pr_1', 'server', SERVER)
    expect(line).toContain(`insta login --api-key "$${API_TOKEN_ENV}" --api-url ${SERVER}`)
    expect(line).toContain('insta project link pr_1')
  })

  it('is safe to paste unedited: no <placeholder> for the shell to read as a redirection', () => {
    for (const mode of ['local', 'server'] as const) expect(cliLine('pr_1', mode, SERVER)).not.toMatch(/[<>]/)
  })

  it('never uses `setup agent`, which wires the machine to the cloud', () => {
    for (const mode of ['local', 'server'] as const) expect(cliLine('pr_1', mode, LOCAL)).not.toContain('setup agent')
  })
})

describe('setupPrompt', () => {
  it('carries this daemon and this project, not the cloud prompt doc', () => {
    for (const mode of ['local', 'server'] as const) {
      const prompt = setupPrompt('pr_1', mode, SERVER, 'https://console.example.test')
      expect(prompt).toContain(SERVER)
      expect(prompt).toContain('insta project link pr_1')
      expect(prompt).not.toContain('prompt.md')
      expect(prompt).toContain('Do not run "insta setup agent"')
    }
  })

  it('server mode sends the human to create a token on this console', () => {
    expect(setupPrompt('pr_1', 'server', SERVER, 'https://console.example.test')).toContain('https://console.example.test/account/tokens')
  })

  it('local mode keeps INSTA_API_URL set rather than logging in', () => {
    const prompt = setupPrompt('pr_1', 'local', LOCAL, LOCAL)
    expect(prompt).toContain(`export INSTA_API_URL=${LOCAL}`)
    expect(prompt).not.toContain('--api-key')
  })
})

describe('quickStartCards', () => {
  it('deep-links each card into its dialog, on this environment', () => {
    expect(quickStartCards('pr_1', 'main').map((c) => [c.cta, c.href])).toEqual([
      ['Add Database', '/p/pr_1/main/services?add=postgres'],
      ['Create Service', '/p/pr_1/main/services?add=service'],
      ['Deploy Agents', '/p/pr_1/main/templates?template=claude-code'],
    ])
  })

  it('encodes the environment name', () => {
    expect(quickStartCards('pr_1', 'feat/x')[0]!.href).toBe('/p/pr_1/feat%2Fx/services?add=postgres')
  })

  it('offers no GitHub source, which the daemon cannot deploy', () => {
    expect(quickStartCards('pr_1', 'main').some((c) => /github/i.test(c.description))).toBe(false)
  })

  it('reads docs from the self-hosting guide', () => {
    expect(DOCS_URL).toBe('https://docs.instacloud.com/self-hosting/overview')
  })
})

describe('addIntent', () => {
  it('maps the console deep links and ignores anything else', () => {
    expect(addIntent('postgres')).toBe('postgres')
    expect(addIntent('service')).toBe('picker')
    expect(addIntent('redis')).toBeNull()
    expect(addIntent(null)).toBeNull()
  })
})
