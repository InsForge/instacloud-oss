import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // src/fsclone.cjs is the dependency-free CommonJS copy program that the daemon runs as a child
  // and the helper container runs from stdin (04 section H): require() is its only import form, and
  // it must stay loadable by a bare `node -` with no bundler and no node_modules.
  {
    files: ['src/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // Same shape, same reason, in a template's overlay image: a `.cjs` under templates/ is there to
  // be preloaded by `node --require` inside the container, which only loads CommonJS. It is
  // copied into the image as a file, never imported by anything in this repository, so require()
  // is its only import form too. templates/twenty/sni.cjs is the first.
  {
    files: ['templates/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // ui/ has its own toolchain (Vite + tsc in `npm --prefix ui run build`); linting it here
  // would need the React plugin set and trips over ui/dist locally.
  { ignores: ['dist/', 'node_modules/', 'ui/'] },
)
