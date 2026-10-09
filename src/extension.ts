import * as vscode from 'vscode';
import {
  commentAllLogs,
  deleteAllLogs,
  insertLog,
  uncommentAllLogs,
} from './commands';
import {
  ConsoleLogExplorerProvider,
  explorerCommentAll,
  explorerDeleteAll,
  explorerUncommentAll,
  revealLine,
} from './logExplorer';

export function activate(context: vscode.ExtensionContext): void {
  const registrations: [string, (...args: unknown[]) => Promise<void> | void][] = [
    ['easyConsoleLog.insert', insertLog],
    ['easyConsoleLog.commentAll', commentAllLogs],
    ['easyConsoleLog.uncommentAll', uncommentAllLogs],
    ['easyConsoleLog.deleteAll', deleteAllLogs],
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

  context.subscriptions.push(
    vscode.commands.registerCommand('easyConsoleLog.explorer.refresh', () =>
      provider.refresh()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('easyConsoleLog.explorer.revealLine', revealLine)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('easyConsoleLog.explorer.commentAll', explorerCommentAll)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'easyConsoleLog.explorer.uncommentAll',
      explorerUncommentAll
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('easyConsoleLog.explorer.deleteAll', explorerDeleteAll)
  );

  // 活动编辑器或文档变化时刷新侧边栏
  const refresh = (editor?: vscode.TextEditor) => provider.refresh(editor?.document);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => refresh(editor))
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        provider.refresh(e.document);
      }
    })
  );
  refresh(vscode.window.activeTextEditor);
}

export function deactivate(): void {}
