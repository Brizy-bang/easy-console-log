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
  ConsoleLogExplorerProvider,
  copyLogText,
  deleteLogItem,
  explorerCommentAll,
  explorerDeleteAll,
  explorerUncommentAll,
  filterLevels,
  LogItem,
  revealLine,
  toggleLogItem,
} from './logExplorer';
import { registerDiagnostics } from './diagnostics';

export function activate(context: vscode.ExtensionContext): void {
  const registrations: [string, (...args: unknown[]) => Promise<void> | void][] = [
    ['easyConsoleLog.insert', insertLog],
    ['easyConsoleLog.commentAll', commentAllLogs],
    ['easyConsoleLog.uncommentAll', uncommentAllLogs],
    ['easyConsoleLog.deleteAll', deleteAllLogs],
    ['easyConsoleLog.toggleCurrentLog', toggleCurrentLog],
    ['easyConsoleLog.workspace.commentAll', workspaceCommentAll],
    ['easyConsoleLog.workspace.uncommentAll', workspaceUncommentAll],
    ['easyConsoleLog.workspace.deleteAll', workspaceDeleteAll],
  ];
  for (const [command, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }

  // 注册侧边栏 Console 视图
  const provider = new ConsoleLogExplorerProvider();
  const treeView = vscode.window.createTreeView('easyConsoleLog.explorer', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  const explorerCommands: [
    string,
    (...args: unknown[]) => Promise<void> | void
  ][] = [
    ['easyConsoleLog.explorer.refresh', () => provider.refresh()],
    ['easyConsoleLog.explorer.revealLine', (uri, line) =>
      revealLine(uri as vscode.Uri, line as number)],
    ['easyConsoleLog.explorer.commentAll', explorerCommentAll],
    ['easyConsoleLog.explorer.uncommentAll', explorerUncommentAll],
    ['easyConsoleLog.explorer.deleteAll', explorerDeleteAll],
    ['easyConsoleLog.explorer.filter', () => filterLevels(provider)],
    ['easyConsoleLog.explorer.toggleItem', (item) => toggleLogItem(item as LogItem)],
    ['easyConsoleLog.explorer.deleteItem', (item) => deleteLogItem(item as LogItem)],
    ['easyConsoleLog.explorer.copyText', (item) => copyLogText(item as LogItem)],
  ];
  for (const [command, handler] of explorerCommands) {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }

  // 活动编辑器或文档变化时刷新侧边栏，同时更新统计描述
  const refresh = () => {
    provider.refresh();
    treeView.description = provider.stats;
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refresh())
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        refresh();
      }
    })
  );
  refresh();

  registerDiagnostics(context);
}

export function deactivate(): void {}
