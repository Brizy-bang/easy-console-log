# AGENTS.md

## Commands

- `npm run typecheck`: type check (`src` + `test`)
- `npm run lint`: ESLint (flat config in `eslint.config.mjs`, including `max-len: 120`)
- `npm test`: unit tests (esbuild bundles `test/*.test.ts` into `out-test/`, then runs them with `node --test`)
- `npm run esbuild-base -- --minify`: production bundle to `out/extension.js`
- `npm run vscode:prepublish`: pre-publish check (typecheck + lint + test + bundle)
- Debugging: press `F5` in VS Code (the default build task is `npm run watch`)

## Architecture Conventions

- `consoleScan.ts`, `logStatement.ts`, `lineNumbers.ts` and `astResolver.ts` do not depend on `vscode` and are
  covered directly by unit tests.
- Editor adapters that talk to the vscode API live in `editUtil.ts`; workspace file discovery lives in
  `workspaceScan.ts`.
- `astResolver` (which depends on the TypeScript compiler) must only be loaded dynamically via `loadAst()` in
  `commands.ts`. Do not import it statically, or extension activation will slow down.
- `esbuild-base` produces two bundles: `out/extension.js` (~26 KB, entry) and `out/astResolver.js` (~3.3 MB,
  lazily `import()`ed at runtime via `--external:./astResolver`). Both must stay re-included in `.vscodeignore`.
- Runtime messages use `vscode.l10n.t('English')`, with the Chinese translation added to
  `l10n/bundle.l10n.zh-cn.json`; `test/l10n.test.ts` checks for missing or unused keys. Strings in
  `package.json` go into `package.nls*.json`.
- Maximum line length is 120 characters.
