# Changelog

All notable changes to the "Easy Console Log" extension are documented in this file.

## [Unreleased]

### Added

- **Multi-line call support**: comment / uncomment / delete now treat a `console.*` call spanning several lines
  (e.g. wrapped by Prettier) as one unit, so no half-commented code is left behind.
- **Destructuring selection**: selecting `const { a, b } = obj` generates `console.log({a, b})`.
- **Toggle Current Log Comment** works on every call covered by the selection and supports multi-cursor.
- **Workspace batch scope**: before running, choose between "generated logs only" and "all `console.*`", with
  per-scope log / file counts. The result notification offers a one-click **Save** for the touched files.
- Workspace scan shows a cancellable progress notification and uses unsaved editor content for open files.
- Optional chaining (`a?.b`) and non-null assertions (`a!`) are recognized as loggable expressions.
- Inline icons for the sidebar item actions (Toggle Comment / Delete / Copy).
- `npm run typecheck` script.

### Changed

- **Generated-log detection** is now based on the fixed text at the start of the message template (`🪵 ~ ` by
  default) and also matches the configured `logFunction`. Batch commands are refused when the marker cannot be
  determined (e.g. empty prefix) to protect hand-written logs.
- **Diagnostics**: default severity changed from `information` to `hint`; only uncommented calls are marked, the
  range covers the whole call, and only JS/TS/Vue/Svelte files are checked. Debouncing is now per document.
- **Vue / Svelte**: every `<script>` block (including `<script setup>`) is parsed according to its `lang`; the
  template area is skipped with a notice.
- **Python**: fallback insertion indents one level after lines ending with `:`; comment / delete commands use `#`;
  backtick quote setting falls back to `'`.
- Workspace batch operations no longer scan Python files, and additionally skip `coverage`, `.next`, `.nuxt`,
  `.output`, `.svelte-kit`, `*.min.js` and bundled files with very long lines.
- Keybindings are only active in supported languages; removed the `onLanguage:json` activation event.
- Sidebar item commands are hidden from the Command Palette.
- The TypeScript compiler is lazy-loaded on first use to speed up activation, and moved to `devDependencies`
  (it is bundled by esbuild). `vscode:prepublish` now runs a type check instead of a full `tsc` build.
- `out/**` except the bundled `out/extension.js` is excluded from the VSIX package.
- Snippets now use the full file name (`TM_FILENAME`) to match generated logs.
- Sidebar scans the document once per refresh and debounces refreshes while typing.
- Scanning and edit computation in `consoleScan` no longer depend on the `vscode` API; editor adapters moved to
  the new `editUtil` module.

### Fixed

- Line numbers in generated messages are correct when inserting multiple logs with multi-cursor; duplicate logs
  for the same expression and statement are inserted only once.
- Keywords, numbers and object-literal keys are no longer picked up as expressions; for `user.getName()` the
  object `user` is logged instead of the method reference.
- No insertion when braces open and close on the same line (e.g. `function f(a) { return a; }`), where the log
  would land outside the block; expressions inside arrow concise bodies are skipped as well.
- Multi-line expressions are collapsed to a single line in the message string, and `${` is escaped correctly in
  template-literal messages.
- Calls sharing a line with other code are skipped when commenting, and only the call itself is removed when
  deleting.
- Sidebar item actions re-locate the log before editing and refresh the list if the item is outdated.
- Unknown template placeholders are left as-is instead of being dropped.

## [0.2.0] - 2026-10-09

### Added

- **Toggle Current Log Comment** command (`Ctrl + Alt + C`): toggle the comment on the `console.*` call under the cursor.
- **Workspace batch commands**: Comment / Uncomment / Delete all `console.*` calls across JS/TS/Vue/Svelte/Python
  files in the workspace, with a confirmation dialog. `node_modules`, `dist`, `out`, `build`, `.git` and `vendor`
  are excluded.
- **Multi-identifier logging**: selecting `a, b, c` generates `console.log({a, b, c})`.
- **Message template** setting `easyConsoleLog.messageTemplate` with placeholders
  `${prefix}` `${file}` `${line}` `${location}` `${expr}`.
- **Diagnostics**: `console.*` lines are marked in the editor and the Problems panel, configurable via
  `easyConsoleLog.diagnostics.enabled` and `easyConsoleLog.diagnostics.severity`.
- **Language support**:
  - Vue / Svelte: the `<script>` block is parsed for AST-aware insertion.
  - Python: generates `print(...)` statements without a trailing semicolon.
- **Snippets**: `ecl` / `ecln` (no semicolon) for JS/TS/JSX/TSX/Vue/Svelte.
- **Console Explorer sidebar**:
  - Logs are grouped by level (`log` / `debug` / `info` / `warn` / `error`).
  - Inline item actions: **Toggle Comment**, **Delete Log**, **Copy Text**.
  - **Filter Levels** toolbar button to choose which levels are shown.
  - Per-level counts shown in the view description (e.g. `log: 3  warn: 1`).

### Changed

- Activity bar and view icons switched from PNG to SVG.
- Removed redundant `onCommand` / `onView` activation events (auto-generated by VS Code); added
  `onLanguage:svelte` and `onLanguage:python`.
- Console line scanning extracted into a shared `consoleScan` module, reused by the sidebar, diagnostics and
  workspace commands.
- `tsconfig.json` now declares `types: ["node"]` explicitly.

### Documentation

- README (EN / zh-CN) updated with new commands, supported languages, settings, snippets and notes.
