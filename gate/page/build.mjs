// Builds dist/insta-gate.mjs: the server in src/server.mjs with the sign-in page baked in.
// The page is rendered once, here, from the @insforge/ui components and the console theme that ui/
// already pins, so the gate looks like the console and ships no React to the browser.
// Needs `npm --prefix ui ci` and `npm --prefix gate ci` first.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const gateDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const uiDir = join(gateDir, '..', 'ui')
const outDir = join(gateDir, 'dist')
const scratch = join(outDir, '.page')
const kitDir = join(uiDir, 'node_modules', '@insforge', 'ui')
const fontFile = join(uiDir, 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2')
const tailwind = join(gateDir, 'node_modules', '.bin', 'tailwindcss')

for (const [path, fix] of [[kitDir, 'npm --prefix ui ci'], [tailwind, 'npm --prefix gate ci']]) {
  if (!existsSync(path)) throw new Error(`missing ${path}: run \`${fix}\` first`)
}

// One React for the kit and for us: the kit's own `import 'react'` resolves from ui/node_modules too.
const uiRequire = createRequire(join(uiDir, 'package.json'))
const React = uiRequire('react')
const { renderToStaticMarkup } = uiRequire('react-dom/server')
const { Eye, EyeOff, CircleAlert } = uiRequire('lucide-react')
const kit = (file) => import(pathToFileURL(join(kitDir, 'dist', 'components', file)).href)
const { Button } = await kit('Button.js')
const { Input } = await kit('Input.js')
const h = React.createElement

// The role sits on the <svg>: Chrome drops a role from a display:contents wrapper.
const svg = (file, className, label) =>
  readFileSync(join(gateDir, 'page', 'assets', file), 'utf8')
    .replace(/<\?xml[^>]*>\s*/, '')
    .replace('<svg ', `<svg class="${className}" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'} focusable="false" `)
// Two copies of each mark, one per theme; the hidden one is display:none, so out of the a11y tree.
const mark = (light, dark, className, label) => [
  h('span', { key: 'l', className: 'contents dark:hidden', dangerouslySetInnerHTML: { __html: svg(light, className, label) } }),
  h('span', { key: 'd', className: 'hidden dark:contents', dangerouslySetInnerHTML: { __html: svg(dark, className, label) } }),
]

// The theme follows the visitor's system; the kit and the console key dark mode on `.dark`.
const SCRIPT = `(()=>{const d=document.documentElement,m=matchMedia('(prefers-color-scheme: dark)'),t=()=>d.classList.toggle('dark',m.matches);t();m.addEventListener('change',t);document.addEventListener('DOMContentLoaded',()=>{const b=document.getElementById('toggle-password'),p=document.getElementById('password');if(!b||!p)return;b.hidden=false;b.addEventListener('click',()=>{const s=p.type==='password';p.type=s?'text':'password';b.setAttribute('aria-pressed',String(s));b.setAttribute('aria-label',s?'Hide password':'Show password');b.querySelector('[data-icon=show]').classList.toggle('hidden',s);b.querySelector('[data-icon=hide]').classList.toggle('hidden',!s)})})})()`

const field = (id, label, input) =>
  h('div', { className: 'flex flex-col gap-1.5' },
    h('label', { htmlFor: id, className: 'text-sm font-medium leading-5 text-foreground' }, label),
    input)

const card = h('main', { className: 'flex w-full max-w-[360px] flex-col border border-border bg-card shadow-[0px_8px_6px_rgba(0,0,0,0.04)]' },
  h('form', { method: 'post', action: '/_insta/sign-in', 'aria-labelledby': 'title', className: 'flex flex-col gap-4 px-7 pb-6 pt-7' },
    h('div', { className: 'mb-2 flex flex-col items-center gap-2.5 text-center' },
      ...mark('instacloud-wordmark.svg', 'instacloud-wordmark-inverse.svg', 'h-6 w-auto', 'InstaCloud'),
      h('p', { id: 'title', className: 'text-sm leading-5 text-muted-foreground' },
        'Sign in to ', h('span', { className: 'font-medium text-foreground' }, '__INSTA_NAME__'))),
    h('insta-error'),
    h('input', { type: 'hidden', name: 'next', value: '__INSTA_NEXT__' }),
    field('username', 'Username', h(Input, { id: 'username', name: 'username', defaultValue: '__INSTA_USER__', autoComplete: 'username', autoCapitalize: 'none', spellCheck: false, required: true, autoFocus: true })),
    field('password', 'Password',
      h('div', { className: 'relative' },
        h(Input, { id: 'password', name: 'password', type: 'password', autoComplete: 'current-password', required: true, className: 'pr-9' }),
        h(Button, { id: 'toggle-password', type: 'button', variant: 'ghost', size: 'icon-sm', hidden: true, 'aria-label': 'Show password', 'aria-pressed': 'false', 'aria-controls': 'password', className: 'absolute right-0.5 top-1/2 -translate-y-1/2' },
          h(Eye, { 'data-icon': 'show', 'aria-hidden': true }),
          h(EyeOff, { 'data-icon': 'hide', className: 'hidden', 'aria-hidden': true })))),
    h(Button, { type: 'submit', size: 'lg', className: 'mt-2 w-full' }, 'Sign In')),
  h('footer', { className: 'flex items-center justify-center gap-1.5 border-t border-border bg-semantic-1 px-6 py-3 text-xs leading-4 text-muted-foreground' },
    'Powered by',
    h('a', { href: 'https://instacloud.com', target: '_blank', rel: 'noopener', className: 'inline-flex items-center gap-1.5 font-semibold text-foreground hover:underline' },
      ...mark('instacloud-icon.svg', 'instacloud-icon-inverse.svg', 'size-3.5'),
      'InstaCloud')))

const alert = (text) => renderToStaticMarkup(
  h('p', { role: 'alert', className: 'flex items-center gap-1.5 text-[13px] leading-[18px] text-destructive' },
    h(CircleAlert, { className: 'size-4 shrink-0', 'aria-hidden': true }),
    text))
const errors = {
  incorrect: alert('Incorrect username or password'),
  throttled: alert('Too many sign-in attempts. Try again in a few seconds.'),
}

const page = '<!doctype html>' + renderToStaticMarkup(
  h('html', { lang: 'en' },
    h('head', null,
      h('meta', { charSet: 'utf-8' }),
      h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { name: 'robots', content: 'noindex' }),
      h('title', null, 'Sign in to __INSTA_NAME__'),
      h('style', { dangerouslySetInnerHTML: { __html: '__INSTA_CSS__' } }),
      h('script', { dangerouslySetInnerHTML: { __html: SCRIPT } })),
    h('body', { className: 'flex min-h-screen items-center justify-center px-4 py-12 antialiased' }, card)))
  .replace('<insta-error></insta-error>', '<!--insta:error-->')

// Tailwind scans only the rendered markup (its working directory) plus the kit's own sources.
mkdirSync(scratch, { recursive: true })
writeFileSync(join(scratch, 'page.html'), page + Object.values(errors).join(''))
const cssOut = join(scratch, 'page.css')
execFileSync(tailwind, ['--input', join(gateDir, 'page', 'entry.css'), '--output', cssOut, '--minify', '--cwd', scratch], { stdio: 'inherit' })

// The fonts arrive as relative url()s, which a single file cannot serve: keep latin Inter, inlined.
const font = `url(data:font/woff2;base64,${readFileSync(fontFile).toString('base64')})`
const css = readFileSync(cssOut, 'utf8').replace(/@font-face\{[^}]*\}/g, (block) =>
  /inter-latin-wght-normal\.woff2/.test(block) ? block.replace(/url\([^)]*\)/, font) : '')

const built = {
  page: page.replace('__INSTA_CSS__', css),
  errors,
  scriptHashes: [`sha256-${createHash('sha256').update(SCRIPT).digest('base64')}`],
}

// What the release promises: nothing loads from elsewhere, and the CSP hash matches the script.
const urls = [...built.page.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0])
// SVG namespaces, the Powered by link, and Tailwind's MIT banner comment (kept, it is the license).
const allowed = /^https?:\/\/(www\.w3\.org\/|instacloud\.com$|tailwindcss\.com$)/
const stray = urls.filter((u) => !allowed.test(u))
if (stray.length) throw new Error(`unexpected URLs in the page: ${stray.join(', ')}`)
if (/url\((?!data:)/.test(css)) throw new Error('a url() in the CSS is not inlined')
if (/<script[^>]+src=/.test(built.page)) throw new Error('the page loads a script')
for (const marker of ['__INSTA_NAME__', '__INSTA_NEXT__', '__INSTA_USER__', '<!--insta:error-->']) {
  if (!built.page.includes(marker)) throw new Error(`the page lost its ${marker} marker`)
}

const version = JSON.parse(readFileSync(join(gateDir, 'package.json'), 'utf8')).version
const source = readFileSync(join(gateDir, 'src', 'server.mjs'), 'utf8')
const slot = 'const BUILT = null'
if (source.split(slot).length !== 2) throw new Error(`src/server.mjs must contain exactly one \`${slot}\``)
const out = `// insta-gate ${version}, built from InsForge/instacloud-oss gate/. Do not edit: run \`npm --prefix gate run build\`.\n`
  + source.replace(slot, `const BUILT = ${JSON.stringify(built)}`)
writeFileSync(join(outDir, 'insta-gate.mjs'), out)
console.log(`gate/dist/insta-gate.mjs: ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB, page ${(Buffer.byteLength(built.page) / 1024).toFixed(0)} KB`)
