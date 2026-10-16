// A failed `docker` call becomes three durable things: a log line, the 500 body of the route that
// made it, and (template deploys) the `error` column of a row in state.json. The argv it quotes
// carries every secret a service runs with, so these tests pin the redaction.
import { test, expect } from 'vitest'
import { redactDockerArgs } from '../src/docker'

test('every -e value is redacted, its key kept', () => {
  const line = redactDockerArgs([
    'create', '--name', 'io-demo-main-app-default',
    '-e', 'DATABASE_URL=postgres://postgres:s3cr3t-pw@io-demo-main-pg-db:5432/app',
    '-e', 'POSTGRES_PASSWORD=hunter2',
    '--env', 'AWS_SECRET_ACCESS_KEY=abc123',
    '--env=RCLONE_CONFIG_G_SECRET_ACCESS_KEY=def456',
    'nginx',
  ])
  expect(line).not.toContain('s3cr3t-pw')
  expect(line).not.toContain('hunter2')
  expect(line).not.toContain('abc123')
  expect(line).not.toContain('def456')
  // The keys survive: an operator still learns WHICH variable the failing container was given.
  expect(line).toContain('-e DATABASE_URL=[redacted]')
  expect(line).toContain('-e POSTGRES_PASSWORD=[redacted]')
  expect(line).toContain('--env AWS_SECRET_ACCESS_KEY=[redacted]')
  expect(line).toContain('--env=RCLONE_CONFIG_G_SECRET_ACCESS_KEY=[redacted]')
  // Everything that is not a credential is untouched, or the message stops being debuggable.
  expect(line).toContain('create --name io-demo-main-app-default')
  expect(line).toMatch(/ nginx$/)
})

test('a psql statement is redacted: the password-rotate route puts the new password in the SQL', () => {
  const line = redactDockerArgs([
    'exec', '-i', 'io-demo-main-pg-db', 'psql', '-U', 'postgres', '-d', 'app',
    '-v', 'ON_ERROR_STOP=1', '-tAc', "alter user postgres with password 'brand-new-pw'",
  ])
  expect(line).not.toContain('brand-new-pw')
  expect(line).toContain('-tAc [redacted]')
  expect(line).toContain('exec -i io-demo-main-pg-db psql -U postgres -d app')
  // `-v ON_ERROR_STOP=1` is not a secret flag: docker's own -v is a mount and psql's is a variable.
  expect(line).toContain('-v ON_ERROR_STOP=1')
})

test('a DSN carrying a password is redacted wherever it sits in the argv', () => {
  expect(redactDockerArgs(['run', 'postgres:16-alpine', 'pg_dump', 'postgres://postgres:pw@host:5432/app']))
    .toBe('run postgres:16-alpine pg_dump postgres://postgres:[redacted]@host:5432/app')
  // A URL with no credentials is left alone.
  expect(redactDockerArgs(['run', '-e', 'X=1', 'img', 'curl', 'http://io-garage:3900/health']))
    .toBe('run -e X=[redacted] img curl http://io-garage:3900/health')
})

test('a trailing secret flag with no value does not lose the flag or throw', () => {
  expect(redactDockerArgs(['run', 'img', '-e'])).toBe('run img -e')
  expect(redactDockerArgs([])).toBe('')
})

test('a bare value after -e (no equals) is redacted whole: `-e SECRET` inherits the daemon env', () => {
  expect(redactDockerArgs(['run', '-e', 'POSTGRES_PASSWORD', 'img'])).toBe('run -e [redacted] img')
})
