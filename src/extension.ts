import * as vscode from 'vscode';
import {
  commentAllLogs,
  deleteAllLogs,
  insertLog,
  toggleCurrentLog,
  uncommentAllLogs,
  workspaceCommentAll,
  workspaceDeleteAll,
  workspaceUncommentAll,
} from './commands';
import {
  batchOnCurrentFile,
  ConsoleLogExplorerProvider,
  copyLogText,
  deleteLogItem,
  filterLevels,
  LogItem,
  revealLine,
  toggleLogItem,
} from './logExplorer';
import { registerDiagnostics } from './diagnostics';

export function activate(context: vscode.ExtensionContext): void {
  // 注册侧边栏 Console 视图
  const provider = new ConsoleLogExplorerProvider();
  const treeView = vscode.window.createTreeView('easyConsoleLog.explorer', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  provider.attach(treeView);
  context.subscriptions.push(treeView);

  const registrations: [string, (...args: unknown[]) => Promise<void> | void][] = [
    ['easyConsoleLog.insert', insertLog],
    ['easyConsoleLog.commentAll', commentAllLogs],
    ['easyConsoleLog.uncommentAll', uncommentAllLogs],
    ['easyConsoleLog.deleteAll', deleteAllLogs],
    ['easyConsoleLog.toggleCurrentLog', toggleCurrentLog],
    ['easyConsoleLog.workspace.commentAll', workspaceCommentAll],
    ['easyConsoleLog.workspace.uncommentAll', workspaceUncommentAll],
    ['easyConsoleLog.workspace.deleteAll', workspaceDeleteAll],
    ['easyConsoleLog.explorer.refresh', () => provider.refresh()],
    ['easyConsoleLog.explorer.revealLine', (uri, line) =>
      revealLine(uri as vscode.Uri, line as number)],
    ['easyConsoleLog.explorer.commentAll', () => batchOnCurrentFile('comment')],
    ['easyConsoleLog.explorer.uncommentAll', () => batchOnCurrentFile('uncomment')],
    ['easyConsoleLog.explorer.deleteAll', () => batchOnCurrentFile('delete')],
    ['easyConsoleLog.explorer.filter', () => filterLevels(provider)],
    ['easyConsoleLog.explorer.toggleItem', (item) => toggleLogItem(provider, item as LogItem)],
    ['easyConsoleLog.explorer.deleteItem', (item) => deleteLogItem(provider, item as LogItem)],
    ['easyConsoleLog.explorer.copyText', (item) => copyLogText(item as LogItem)],
  ];
  for (const [command, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }

  // 活动编辑器变化时立即刷新；输入时防抖，避免每次按键都全量重建树
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        clearTimeout(timer);
        timer = setTimeout(() => provider.refresh(), 200);
      }
    }),
    { dispose: () => clearTimeout(timer) }
  );
  provider.refresh();

  registerDiagnostics(context);
}

export function deactivate(): void {}
