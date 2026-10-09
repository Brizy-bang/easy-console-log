# Easy Console Log

[English](./README.md) | **简体中文**

一个 VSCode 扩展，用于管理 `console.*` 调试语句：一键生成带文件名、行号、变量名的 `console.log`，在侧边栏查看当前文件所有 console 调用，并批量注释 / 恢复 / 删除。

## 功能

| 命令 | 快捷键 (Win/Linux / Mac) | 说明 |
| --- | --- | --- |
| `Easy Console Log: 插入日志语句` | `Ctrl + Alt + L` | 为选中的表达式（或光标下的变量）在合适位置插入日志 |
| `Easy Console Log: 注释所有日志` | `Alt + Shift + C` | 注释当前文件内所有生成的日志 |
| `Easy Console Log: 取消注释所有日志` | `Alt + Shift + U` | 恢复所有被注释的日志 |
| `Easy Console Log: 删除所有日志` | `Alt + Shift + D` | 删除当前文件内所有生成的日志（含被注释的） |
| `Easy Console Log: 切换当前行日志注释` | `Ctrl + Alt + C` | 切换光标所在（或选区覆盖的）console 调用的注释状态，支持多光标 |
| `Easy Console Log: 注释/取消注释/删除工作区所有日志` | — | 对整个工作区批量操作 |

选中 `a, b, c` 这类逗号分隔的多个标识符会生成 `console.log({a, b, c})`；选中 `const x = 1` 会自动取 `x`，选中 `const { a, b } = obj` 会生成 `console.log({a, b})`。

所有注释 / 取消注释 / 删除操作都以**完整调用**为单位，跨多行的 `console.log(...)`（如被 Prettier 折行）会整体处理，不会留下半截语法错误的代码。

## Console 侧边栏

点击活动栏上的 **Easy Console Log** 图标打开侧边栏，按级别分组列出当前文件中所有 `console.log / debug / info / warn / error` 调用：

- 点击列表项跳转到对应代码行。
- 右键单条日志可**切换注释**、**删除日志**、**复制文本**。
- 顶部工具栏：**注释全部**、**取消注释全部**、**删除全部**、**筛选级别**（勾选要显示的级别）、**刷新**。
- 视图描述栏会显示各级别数量统计（如 `log: 3  warn: 1`）。
- 切换编辑器或修改文档时列表自动刷新。

## 生成的日志格式

```ts
const userName = 'devin';
console.log('🪵 ~ app.ts:2 ~ userName:', userName);
```

光标放在 `this.state.list`、`a?.b`、`a['key']` 这类成员表达式上也能完整识别；光标在关键字、数字或对象字面量的键名上时不会生成日志。支持多光标，多条日志中的行号会互相校正。

## 支持的语言

- **JS / TS / JSX / TSX**：完整 AST 语句边界感知插入。
- **Vue / Svelte**：解析所有 `<script>` 块（含 `<script setup>`，按 `lang` 选择 TS/JS/TSX 解析）进行 AST 感知插入；光标在模板区时跳过并提示。
- **Python（`.py`）**：生成 `print(...)` 语句（不带分号），按行级插入，在 `def` / `if` 等以冒号结尾的行之后会自动缩进一级；注释/删除命令使用 `#` 处理生成的 `print` 日志。
- 其他文件降级为"当前行下一行插入"。

## AST 智能插入（JS/TS/JSX/TSX）

扩展会用 TypeScript AST 定位表达式所属的**语句边界**，而非简单插在光标行下面：

| 场景 | 插入位置 |
| --- | --- |
| `const obj = { a: x }` 中选中 `x` | 整条声明语句之后 |
| `return x` 中选中 `x` | `return` 语句**之前**（避免死代码） |
| `function f(param)` 中选中 `param` | 函数体第一行 |
| `for (const item of list)` 中选中 `item` | 循环体第一行 |
| `interface` / `type` / `enum` 中选中 | 跳过并提示（类型无运行时值） |
| 箭头函数表达式体 `x => x` 的参数或内部表达式 | 跳过并提示（无法插入语句 / 外层不在作用域） |
| `function f(a) { return a; }` 这类花括号首尾同行的代码块 | 跳过并提示（插入会落到块外） |

非 JS/TS 系文件自动降级为"当前行下一行插入"。

## 配置项

在 VSCode 设置中搜索 `easyConsoleLog`：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `easyConsoleLog.logMessagePrefix` | `🪵` | 日志消息前缀，也是批量操作的识别标记（为空时拒绝批量操作，避免误删手写日志） |
| `easyConsoleLog.quote` | `'` | 引号风格（`'` / `"` / `` ` ``） |
| `easyConsoleLog.addSemicolon` | `true` | 末尾是否加分号 |
| `easyConsoleLog.logFunction` | `console.log` | 日志函数，可改为 `console.debug` 等 |
| `easyConsoleLog.includeFilename` | `true` | 消息中是否包含文件名 |
| `easyConsoleLog.includeLineNumber` | `true` | 消息中是否包含行号 |
| `easyConsoleLog.messageTemplate` | `${prefix} ~ ${location} ~ ${expr}:` | 消息模板，占位符：`${prefix}` `${file}` `${line}` `${location}` `${expr}` |
| `easyConsoleLog.diagnostics.enabled` | `true` | 是否为未注释的 `console.*` 调用显示诊断提示（仅 JS/TS/Vue/Svelte） |
| `easyConsoleLog.diagnostics.severity` | `hint` | 诊断提示级别（`error` / `warning` / `information` / `hint`）；`hint` 只显示淡色标记，不进入 Problems 面板 |

**识别规则**：生成日志通过消息开头的固定文本识别，即模板中第一个非 `${prefix}` 占位符之前的部分（默认为 `🪵 ~ `）。调用函数可以是 `console.log/debug/info/warn/error` 或配置的 `logFunction`（如 `logger.info`）。

## 代码片段

在 JS/TS/Vue/Svelte 文件中输入 `ecl`（或 `ecln` 不带分号）可展开一条带文件名和行号的 console.log 语句。

## 本地开发与调试

```bash
npm install
npm run compile   # 或 npm run watch 持续编译
npm run typecheck # 仅类型检查
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
- `注释/取消注释/删除所有日志` 命令只处理本扩展生成的日志；侧边栏批量按钮会处理当前文件**所有** `console.*` 调用。
- `console.log(a); foo();` 这类与其他代码同行的调用：注释时会跳过并提示，删除时只删除调用本身。
- 工作区批量操作扫描 JS/TS/Vue/Svelte 文件，跳过 `node_modules`、`dist`、`coverage`、`.next` 等目录以及 `*.min.js` 和含超长行的打包产物；执行前可选择"仅本扩展生成的日志"或"所有 console.*"，修改后不会自动保存，可在提示中一键保存。
