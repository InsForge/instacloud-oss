// The nanobot entrypoint starts as root, hands the volume to uid 1000 and re-execs as that user.
// Review found the order wrong: the instance root and the seeded config were created above the
// privilege drop, so root made them, and the one guard that would have fixed the ownership reads
// the volume's own owner and skips when that is already 1000. A volume handed over on an earlier
// boot but carrying no instance root (clearing a bad config through the agent's own shell tool is
// enough) therefore came back with a root-owned config.json nanobot could not write. What keeps
// that from coming back is the ORDER, which is what these tests pin.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'nanobot');
const entrypoint = join(dir, 'entrypoint.sh');
const seed = join(dir, 'config.seed.json');

// The root half of the script reaches for id, stat, chown, cp and setpriv. Stubbing all five runs
// it as root on any machine without being root, macOS included, where `stat -c` does not exist.
// The stubs are thin: `setpriv` records what the volume held at the moment privileges were dropped
// and then re-execs the script exactly as the real one does, which is the shape under test.
function run({ owner, password = 'house-secret' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'nanobot-entrypoint-'));
  const bin = join(work, 'bin');
  const home = join(work, 'data');
  mkdirSync(bin);
  mkdirSync(home); // the volume's mount point, as the platform presents it

  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };

  stub('id', 'if [ -f "$NB_DROPPED" ]; then echo 1000; else echo 0; fi');
  stub('stat', 'echo "$NB_OWNER"');
  stub('chown', 'echo "chown $*" >> "$NB_CALLS"');
  // The image carries the seed at /opt/nanobot; passing any other path through unchanged is what
  // makes a moved seed fail here rather than on someone's deploy.
  stub('cp', 'src="$1"; [ "$src" = /opt/nanobot/config.seed.json ] && src="$NB_SEED"; exec /bin/cp "$src" "$2"');
  // Drops the three --reuid/--regid/--init-groups flags and re-execs the script the way the real
  // setpriv does. The image's copy lives at /entrypoint.sh, so pointing that one path at the
  // repository's copy is also what makes a renamed re-exec target fail here.
  stub(
    'setpriv',
    'ls -A "$HOME" > "$NB_AT_DROP"; : > "$NB_DROPPED"; shift 3; ' +
      'target="$1"; shift; [ "$target" = /entrypoint.sh ] && target="$NB_ENTRYPOINT"; exec sh "$target" "$@"',
  );
  stub('nanobot', 'echo "nanobot $*" >> "$NB_CALLS"');

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    NB_OWNER: String(owner),
    NB_SEED: seed,
    NB_ENTRYPOINT: entrypoint,
    NB_CALLS: join(work, 'calls'),
    NB_AT_DROP: join(work, 'at-drop'),
    NB_DROPPED: join(work, 'dropped'),
    ...(password === null ? {} : { ADMIN_PASSWORD: password }),
  };
  const r = spawnSync('sh', [entrypoint], { env, encoding: 'utf8' });
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return {
    status: r.status,
    stderr: r.stderr,
    calls: read(env.NB_CALLS),
    volumeAtDrop: read(env.NB_AT_DROP).trim(),
    volume: readdirSync(home),
    config: join(home, '.nanobot', 'config.json'),
  };
}

describe('nanobot entrypoint', () => {
  it('hands a root-owned volume to uid 1000 on the first boot, then starts the gateway', () => {
    const r = run({ owner: 0 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain('chown -R nanobot:nanobot');
    expect(r.calls).toContain('nanobot gateway');
  });

  it('skips the recursive chown once the volume is already owned by uid 1000', () => {
    const r = run({ owner: 1000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain('chown');
  });

  // The regression guard. Root creating either of these is the bug: on a volume already owned by
  // uid 1000 the chown above is skipped, so anything root left behind stays root's.
  it('creates the instance root and seeds the config only after dropping privileges', () => {
    const r = run({ owner: 1000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.volumeAtDrop).toBe('');
    expect(readFileSync(r.config, 'utf8')).toBe(readFileSync(seed, 'utf8'));
  });

  it('keeps the password a literal placeholder in the seeded config, so rotating the variable rotates it', () => {
    const r = run({ owner: 0 });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(r.config, 'utf8')).toContain('${ADMIN_PASSWORD}');
    expect(readFileSync(r.config, 'utf8')).not.toContain('house-secret');
  });

  it('refuses to start without the password, before anything is written to the volume', () => {
    const r = run({ owner: 0, password: null });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ADMIN_PASSWORD is required');
    // The whole volume, not just the config: the instance root is written to it too, and the
    // claim this case makes is that the refusal happens before any of it.
    expect(r.volume).toEqual([]);
    expect(existsSync(r.config)).toBe(false);
    expect(r.calls).toBe('');
  });
});
