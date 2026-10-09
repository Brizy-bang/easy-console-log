# Easy Console Log

**English** | [简体中文](./README.zh-CN.md)

A VS Code extension that helps you manage `console.*` statements: insert contextual `console.log` with a single keystroke, explore all console calls in the current file from the sidebar, and batch comment / uncomment / delete them.

## Features

| Command | Keybinding (Win/Linux & Mac) | Description |
| --- | --- | --- |
| `Easy Console Log: Insert Log Statement` | `Ctrl + Alt + L` | Insert a log for the selected expression (or the variable under the cursor) on the appropriate line |
| `Easy Console Log: Insert Log Statement with Level...` | — | Pick `log / info / debug / warn / error / trace` first; the last choice is listed first |
| `Easy Console Log: Update Log Line Numbers` | — | Refresh the stale `file:line` in generated logs of the current file |
| `Easy Console Log: Comment All Logs` | `Alt + Shift + C` | Comment out all generated logs in the current file |
| `Easy Console Log: Uncomment All Logs` | `Alt + Shift + U` | Restore all commented logs |
| `Easy Console Log: Delete All Logs` | `Alt + Shift + D` | Delete all generated logs in the current file (including commented ones) |
| `Easy Console Log: Toggle Current Log Comment` | `Ctrl + Alt + C` | Toggle comment on the console call(s) under the cursor or selection; multi-cursor supported |
| `Easy Console Log: Comment/Uncomment/Delete All Logs in Workspace` | — | Batch operations across all files in the workspace |

Selecting multiple identifiers separated by commas (e.g. `a, b, c`) generates `console.log({a, b, c})`. Selecting `const x = 1` normalizes to `x`, and `const { a, b } = obj` generates `console.log({a, b})`.

All comment / uncomment / delete operations work on the **whole call**: a `console.log(...)` spanning multiple lines (e.g. wrapped by Prettier) is handled as a unit, so no half-broken code is left behind.

To bind a key to a specific level, pass `args` to `easyConsoleLog.insert` in `keybindings.json`:

```json
{ "key": "ctrl+alt+w", "command": "easyConsoleLog.insert", "args": { "level": "warn" } }
```

### Quick Fix

With the cursor on a console call, click the light bulb (when a diagnostic is shown) or press `Ctrl + .` to comment / uncomment or delete the call, or comment / delete all console calls in the file.

## Console Explorer Sidebar

Open the **Easy Console Log** activity bar icon. The sidebar has two views; the level filter applies to both.

**Consoles** (current file) groups every `console.log / info / debug / warn / error / trace` call in the current file by level:

- Click an item to jump to the line.
- Inline item actions: **Toggle Comment** / **Delete Log** / **Copy Text**.
- Toolbar buttons: **Comment All**, **Uncomment All**, **Delete All**, **Filter Levels** (pick which levels are shown), **Refresh**.
- The view description shows the count of each level (e.g. `log: 3  warn: 1`).
- The list refreshes automatically when you switch editors or change the document.

**Workspace** groups the console calls of the whole workspace by file (collapsed by default; scanned on first expand):

- Files are updated incrementally on edits and on disk changes (e.g. switching branches).
- Toolbar buttons: workspace **Comment All**, **Uncomment All**, **Delete All**, plus **Filter Levels** and **Refresh**.
- Item actions are the same as in the current-file view.

## Generated Log Format

```ts
const userName = 'devin';
console.log('🪵 ~ app.ts:2 ~ userName:', userName);
```

Member expressions like `this.state.list`, `a?.b` and `a['key']` are fully recognized when the cursor sits on them; keywords, numbers and object-literal keys are ignored. Multi-cursor is supported, and line numbers in the generated messages account for the other inserted logs.

## Supported Languages

- **JS / TS / JSX / TSX**: full AST-aware statement-boundary insertion.
- **Vue / Svelte**: every `<script>` block (including `<script setup>`, parsed according to `lang`) is used for AST-aware insertion; the template area is skipped with a notice.
- **Python (`.py`)**: generates `print(...)` statements (no semicolon) with line-level insertion, indenting one level after lines ending with `:` (`def`, `if`, ...). Comment / delete commands handle generated `print` logs using `#`.
- Other files fall back to "insert on the next line".

## AST-Aware Insertion (JS/TS/JSX/TSX)

The extension parses the file with the TypeScript compiler API and locates the **statement boundary** of the selected expression, instead of naively inserting on the next line:

| Scenario | Insert position |
| --- | --- |
| `x` inside `const obj = { a: x }` | After the whole declaration statement |
| `x` inside `return x` | **Before** the `return` statement (avoids dead code) |
| `param` inside `function f(param)` | First line of the function body |
| `item` inside `for (const item of list)` | First line of the loop body |
| Inside `interface` / `type` / `enum` | Skipped with a notice (types have no runtime value) |
| Parameter or expression in an arrow concise body `x => x` | Skipped with a notice (nowhere to put a statement / out of scope outside) |
| Braces opening and closing on the same line, e.g. `function f(a) { return a; }` | Skipped with a notice (the log would land outside the block) |

Non-JS/TS files fall back to simple "insert on the next line" behavior.

## Settings

Search for `easyConsoleLog` in VS Code settings:

| Setting | Default | Description |
| --- | --- | --- |
| `easyConsoleLog.logMessagePrefix` | `🪵` | Log message prefix; also the marker used by batch operations (batch operations are refused when it is empty, to protect hand-written logs) |
| `easyConsoleLog.quote` | `'` | Quote style (`'` / `"` / `` ` ``) |
| `easyConsoleLog.addSemicolon` | `true` | Append a semicolon to generated statements |
| `easyConsoleLog.logFunction` | `console.log` | Log function, e.g. `console.debug` |
| `easyConsoleLog.includeFilename` | `true` | Include the file name in the message |
| `easyConsoleLog.includeLineNumber` | `true` | Include the line number in the message |
| `easyConsoleLog.messageTemplate` | `${prefix} ~ ${location} ~ ${expr}:` | Message template; placeholders: `${prefix}` `${file}` `${line}` `${location}` `${expr}` |
| `easyConsoleLog.diagnostics.enabled` | `true` | Show diagnostic markers on uncommented `console.*` calls (JS/TS/Vue/Svelte only) |
| `easyConsoleLog.updateLineNumbersOnSave` | `false` | Update file names and line numbers in generated logs on save |
| `easyConsoleLog.diagnostics.severity` | `hint` | Severity of the diagnostics (`error` / `warning` / `information` / `hint`); `hint` only shows a faint marker and stays out of the Problems panel |

**How generated logs are recognized**: by the fixed text at the start of the message, i.e. the part of the template before the first placeholder other than `${prefix}` (`🪵 ~ ` by default). The call can be `console.log/debug/info/warn/error` or the configured `logFunction` (e.g. `logger.info`).

## Snippets

Type `ecl` (or `ecln` without semicolon) in JS/TS/Vue/Svelte files to expand a console.log statement with file name and line number placeholders.

## Development & Debugging

```bash
npm install
npm run compile   # or npm run watch for continuous compilation
npm run typecheck # type check (including tests)
npm run lint      # ESLint
npm test          # unit tests (bundled with esbuild, run with node:test)
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host window — open any JS/TS file there to try it out.

## Install Locally

```bash
npm install -g @vscode/vsce
vsce package            # produces easy-console-log-<version>.vsix
code --install-extension easy-console-log-<version>.vsix
```

## Known Limitations

- Parameters/expressions inside arrow concise bodies (`x => x + 1`) cannot be logged and will be skipped with a notice.
- For brace-less single-statement branches like `if (cond) doThing(x)`, the log is inserted after the whole `if` statement (semantically safe, but evaluated after the branch finishes).
- The `Comment/Uncomment/Delete All Logs` commands only affect logs generated by this extension; the sidebar batch buttons affect **all** `console.*` calls in the current file.
- Calls sharing a line with other code (`console.log(a); foo();`) are skipped with a notice when commenting; deleting removes only the call itself.
- Workspace batch operations scan JS/TS/Vue/Svelte files, skipping `node_modules`, `dist`, `coverage`, `.next`, etc., as well as `*.min.js` and bundled files with very long lines. You choose between "generated logs only" and "all console.*" before running; changes are not saved automatically, but the result notification offers a one-click save.
