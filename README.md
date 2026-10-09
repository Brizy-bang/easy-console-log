# Easy Console Log

**English** | [简体中文](./README.zh-CN.md)

A VS Code extension that helps you manage `console.*` statements: insert contextual `console.log` with a single keystroke, explore all console calls in the current file from the sidebar, and batch comment / uncomment / delete them.

## Features

| Command | Keybinding (Win/Linux & Mac) | Description |
| --- | --- | --- |
| `Easy Console Log: Insert Log Statement` | `Ctrl + Alt + L` | Insert a log for the selected expression (or the variable under the cursor) on the appropriate line |
| `Easy Console Log: Comment All Logs` | `Alt + Shift + C` | Comment out all generated logs in the current file |
| `Easy Console Log: Uncomment All Logs` | `Alt + Shift + U` | Restore all commented logs |
| `Easy Console Log: Delete All Logs` | `Alt + Shift + D` | Delete all generated logs in the current file (including commented ones) |
| `Easy Console Log: Toggle Current Log Comment` | `Ctrl + Alt + C` | Toggle comment on the console call under the cursor |
| `Easy Console Log: Comment/Uncomment/Delete All Logs in Workspace` | — | Batch operations across all files in the workspace |

Selecting multiple identifiers separated by commas (e.g. `a, b, c`) generates `console.log({a, b, c})`. Selecting `const x = 1` normalizes to `x`.

## Console Explorer Sidebar

Open the **Easy Console Log** activity bar icon. The sidebar groups every `console.log / debug / info / warn / error` call in the current file by level:

- Click an item to jump to the line.
- Right-click a log item for **Toggle Comment** / **Delete Log** / **Copy Text**.
- Toolbar buttons: **Comment All**, **Uncomment All**, **Delete All**, **Filter Levels** (pick which levels are shown), **Refresh**.
- The view description shows the count of each level (e.g. `log: 3  warn: 1`).
- The list refreshes automatically when you switch editors or change the document.

## Generated Log Format

```ts
const userName = 'devin';
console.log('🪵 ~ app.ts:2 ~ userName:', userName);
```

Member expressions like `this.state.list` and `a['key']` are fully recognized when the cursor sits on them. Multi-cursor is supported.

## Supported Languages

- **JS / TS / JSX / TSX**: full AST-aware statement-boundary insertion.
- **Vue / Svelte**: the `<script>` block is parsed for AST-aware insertion.
- **Python (`.py`)**: generates `print(...)` statements (no semicolon) with line-level insertion.
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
| Arrow concise body `x => x` | Skipped with a notice (nowhere to put a statement) |

Non-JS/TS files fall back to simple "insert on the next line" behavior.

## Settings

Search for `easyConsoleLog` in VS Code settings:

| Setting | Default | Description |
| --- | --- | --- |
| `easyConsoleLog.logMessagePrefix` | `🪵` | Log message prefix; also the marker used by batch operations |
| `easyConsoleLog.quote` | `'` | Quote style (`'` / `"` / `` ` ``) |
| `easyConsoleLog.addSemicolon` | `true` | Append a semicolon to generated statements |
| `easyConsoleLog.logFunction` | `console.log` | Log function, e.g. `console.debug` |
| `easyConsoleLog.includeFilename` | `true` | Include the file name in the message |
| `easyConsoleLog.includeLineNumber` | `true` | Include the line number in the message |
| `easyConsoleLog.messageTemplate` | `${prefix} ~ ${location} ~ ${expr}:` | Message template; placeholders: `${prefix}` `${file}` `${line}` `${location}` `${expr}` |
| `easyConsoleLog.diagnostics.enabled` | `true` | Show diagnostic markers on `console.*` lines (visible in Problems panel) |
| `easyConsoleLog.diagnostics.severity` | `information` | Severity of the diagnostics (`error` / `warning` / `information` / `hint`) |

## Snippets

Type `ecl` (or `ecln` without semicolon) in JS/TS/Vue/Svelte files to expand a console.log statement with file name and line number placeholders.

## Development & Debugging

```bash
npm install
npm run compile   # or npm run watch for continuous compilation
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
- The existing `Comment/Uncomment/Delete All Logs` commands only affect logs generated by this extension (matched by prefix); the sidebar batch buttons affect **all** `console.*` lines in the current file.
- Workspace batch operations affect **all** `console.*` lines in JS/TS/Vue/Svelte/Python files and ask for confirmation first.
