# Easy Console Log

[English](./README.md) | **简体中文**

一个类似 Turbo Console Log 的 VSCode 扩展：一键生成带文件名、行号、变量名的 `console.log` 调试语句，并能批量注释 / 恢复 / 删除所有生成的日志。

## 功能

| 命令 | 快捷键 (Win/Linux / Mac) | 说明 |
| --- | --- | --- |
| `Easy Console Log: 插入日志语句` | `Ctrl + Alt + L` | 为选中的表达式（或光标下的变量）在合适位置插入日志 |
| `Easy Console Log: 注释所有日志` | `Alt + Shift + C` | 注释当前文件内所有生成的日志 |
| `Easy Console Log: 取消注释所有日志` | `Alt + Shift + U` | 恢复所有被注释的日志 |
| `Easy Console Log: 删除所有日志` | `Alt + Shift + D` | 删除当前文件内所有生成的日志（含被注释的） |

## 生成的日志格式

```ts
const userName = 'devin';
console.log('🪵 ~ app.ts:2 ~ userName:', userName);
```

光标放在 `this.state.list`、`a['key']` 这类成员表达式上也能完整识别。支持多光标。

## AST 智能插入（JS/TS/JSX/TSX）

扩展会用 TypeScript AST 定位表达式所属的**语句边界**，而非简单插在光标行下面：

| 场景 | 插入位置 |
| --- | --- |
| `const obj = { a: x }` 中选中 `x` | 整条声明语句之后 |
| `return x` 中选中 `x` | `return` 语句**之前**（避免死代码） |
| `function f(param)` 中选中 `param` | 函数体第一行 |
| `for (const item of list)` 中选中 `item` | 循环体第一行 |
| `interface` / `type` / `enum` 中选中 | 跳过并提示（类型无运行时值） |
| 箭头函数表达式体 `x => x` | 跳过并提示（无法插入语句） |

非 JS/TS 系文件自动降级为"当前行下一行插入"。

## 配置项

在 VSCode 设置中搜索 `easyConsoleLog`：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `easyConsoleLog.logMessagePrefix` | `🪵` | 日志消息前缀，也是批量操作的识别标记 |
| `easyConsoleLog.quote` | `'` | 引号风格（`'` / `"` / `` ` ``） |
| `easyConsoleLog.addSemicolon` | `true` | 末尾是否加分号 |
| `easyConsoleLog.logFunction` | `console.log` | 日志函数，可改为 `console.debug` 等 |
| `easyConsoleLog.includeFilename` | `true` | 消息中是否包含文件名 |
| `easyConsoleLog.includeLineNumber` | `true` | 消息中是否包含行号 |

## 本地开发与调试

```bash
npm install
npm run compile   # 或 npm run watch 持续编译
```

在 VSCode 中打开本目录后按 `F5`，会启动一个加载了本扩展的 Extension Development Host 窗口，在里面打开任意 JS/TS 文件即可试用。

## 打包安装到本地 VSCode

```bash
npm install -g @vscode/vsce
vsce package            # 生成 easy-console-log-<version>.vsix
code --install-extension easy-console-log-<version>.vsix
```

## 已知限制

- 箭头函数表达式体（`x => x + 1`）中的参数/表达式无法插入日志，会跳过并提示。
- `if (cond) doThing(x)` 这类无花括号的单语句分支，日志会插到整个 `if` 语句之后（追加日志不改变语义，但执行时机在分支结束之后）。
- 批量注释/删除操作只处理**当前文件**，不支持跨文件。
- 打包发布时建议用 esbuild/webpack 打包压缩，`typescript` 依赖体积较大（~8MB）。
