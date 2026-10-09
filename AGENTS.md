# AGENTS.md

## 常用命令

- `npm run typecheck`：类型检查（`tsc --noEmit`）
- `npm run esbuild-base -- --minify`：生产打包到 `out/extension.js`
- `npm run vscode:prepublish`：发布前检查（typecheck + 打包）
- 调试：VSCode 中按 `F5`（默认构建任务为 `npm run watch`）

## 架构约定

- `src/consoleScan.ts`、`src/logStatement.ts`、`src/astResolver.ts` 不依赖 `vscode`，可直接用 esbuild 打包后以 `node --test` 做单测。
- 与 vscode API 交互的编辑适配放在 `src/editUtil.ts`。
- `astResolver`（依赖 TypeScript 编译器）只能通过 `commands.ts` 中的 `loadAst()` 动态加载，不要静态 import，否则会拖慢扩展激活。
- 单行最大 120 字符。
