// ttyd prints its credential at startup; the entrypoints must keep it out of the log and still exec.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ttydTemplates = readdirSync(root).filter((d) => {
  const f = join(root, d, 'entrypoint.sh');
  return existsSync(f) && /^exec ttyd /m.test(readFileSync(f, 'utf8'));
});

const CREDS = [
  { label: 'short', user: 'admin', password: '123456' },
  // Long enough that GNU base64 wraps its output at 76 columns.
  { label: 'long', user: 'admin', password: `p@ss w0rd!$"'\`\\${'x'.repeat(120)}` },
];

let work;
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'ttyd-entrypoint-')); });
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Stand-in for ttyd 1.7.7: prints its pid, then its startup banner to stderr the way lws does.
function fakeTtyd(bin, b64) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ttyd'), `#!/bin/bash
echo "pid $$"
{
  echo "[2026/09/23 19:12:21:4948] N: tty configuration:"
  echo "[2026/09/23 19:12:21:4948] N:   credential: ${b64}"
  echo "[2026/09/23 19:12:21:4948] N:   start command: bash"
  echo "[2026/09/23 19:12:21:5605] N:  Listening on port: 7681"
} >&2
exit 7
`);
  chmodSync(join(bin, 'ttyd'), 0o755);
}

/** Run a command with the stand-in ttyd first on PATH. */
function run(argv, { user, password }) {
  const dir = mkdtempSync(join(work, 'run-'));
  const b64 = Buffer.from(`${user}:${password}`).toString('base64');
  fakeTtyd(join(dir, 'bin'), b64);
  const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: join(dir, 'home'), ADMIN_USERNAME: user, ADMIN_PASSWORD: password };
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ pid: child.pid, stdout, stderr, status, b64 }));
  });
}

describe('ttyd entrypoints keep the credential out of the log', () => {
  it('covers every ttyd template', () => {
    expect(ttydTemplates).toEqual(expect.arrayContaining(['claude-code', 'codex', 'pi']));
  });

  it('control: the stand-in alone does print the credential', async () => {
    const r = await run(['ttyd', '-c', 'x'], CREDS[0]);
    expect(r.stderr).toContain(r.b64);
  });

  const cases = ttydTemplates.flatMap((code) => CREDS.map((cred) => ({ code, cred, label: cred.label })));
  it.each(cases)('$code, $label credential', async ({ code, cred }) => {
    const r = await run(['bash', join(root, code, 'entrypoint.sh')], cred);
    expect(r.stderr).not.toContain(r.b64);
    expect(r.stderr).toContain('N:   start command: bash');
    expect(r.stderr).toContain('N:  Listening on port: 7681');
    // Same pid and exit code as the spawned shell: ttyd is still exec'd, not wrapped in a pipeline.
    expect(r.stdout).toBe(`pid ${r.pid}\n`);
    expect(r.status).toBe(7);
  });
});
