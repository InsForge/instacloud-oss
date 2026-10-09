// Root tests run without ui/node_modules; their UI imports must not require UI-only packages.
import { test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const LIB = join(import.meta.dirname, '..', 'ui', 'src', 'lib')

/** Bare specifiers the ROOT install cannot resolve. Relative and node: imports are always fine. */
const UI_ONLY = /^(react|react-dom|react-router-dom|recharts|lucide-react|@insforge\/|@radix-ui\/)/

const importsOf = (src: string): string[] =>
  [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

test('ui/src/lib modules imported by root tests import nothing the root install lacks', () => {
  const files = readdirSync(LIB).filter((f) => f.endsWith('.ts'))
  const tested = new Set(files.filter((f) => f.endsWith('.test.ts')).map((f) => f.replace('.test.ts', '.ts')).filter((f) => files.includes(f)))
  for (const file of readdirSync(import.meta.dirname, { recursive: true }) as string[]) {
    if (!file.endsWith('.test.ts')) continue
    const path = join(import.meta.dirname, file)
    for (const spec of importsOf(readFileSync(path, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = relative(LIB, resolve(dirname(path), spec))
      if (!target.startsWith('..')) tested.add(target.endsWith('.ts') ? target : `${target}.ts`)
    }
  }
  expect(tested.size).toBeGreaterThan(5)

  const offenders: string[] = []
  for (const f of tested) {
    for (const spec of importsOf(readFileSync(join(LIB, f), 'utf8'))) {
      if (UI_ONLY.test(spec)) offenders.push(`${f} imports ${spec}`)
    }
  }
  expect(offenders, 'move the pure half into its own module and test that instead').toEqual([])
})

test('the test files themselves import nothing the root install lacks', () => {
  const offenders: string[] = []
  for (const f of readdirSync(LIB).filter((f) => f.endsWith('.test.ts'))) {
    for (const spec of importsOf(readFileSync(join(LIB, f), 'utf8'))) {
      if (UI_ONLY.test(spec)) offenders.push(`${f} imports ${spec}`)
    }
  }
  expect(offenders).toEqual([])
})
