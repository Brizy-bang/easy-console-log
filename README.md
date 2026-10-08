# Easy Console Log

**English** | [简体中文](./README.zh-CN.md)

A Turbo Console Log–style VS Code extension: insert contextual `console.log` statements with a single keystroke, and batch comment / uncomment / delete every generated log.

## Features

| Command | Keybinding (Win/Linux & Mac) | Description |
| --- | --- | --- |
| `Easy Console Log: Insert Log Statement` | `Ctrl + Alt + L` | Insert a log for the selected expression (or the variable under the cursor) on the appropriate line |
| `Easy Console Log: Comment All Logs` | `Alt + Shift + C` | Comment out all generated logs in the current file |
| `Easy Console Log: Uncomment All Logs` | `Alt + Shift + U` | Restore all commented logs |
| `Easy Console Log: Delete All Logs` | `Alt + Shift + D` | Delete all generated logs in the current file (including commented ones) |

## Generated Log Format

```ts
const userName = 'devin';
console.log('🪵 ~ app.ts:2 ~ userName:', userName);
```

Member expressions like `this.state.list` and `a['key']` are fully recognized when the cursor sits on them. Multi-cursor is supported.

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
- Batch comment/delete operations only affect the **current file**, not the workspace.
- When packaging for distribution, consider bundling with esbuild/webpack — the `typescript` dependency is large (~8MB).
