import * as vscode from 'vscode';
import {
  changedCommentAll,
  changedDeleteAll,
  changedUncommentAll,
  commentAllLogs,
  deleteAllLogs,
  InsertArgs,
  insertLog,
  insertLogWithLevel,
  registerLineNumbersOnSave,
  toggleCurrentLog,
  uncommentAllLogs,
  updateLineNumbers,
  workspaceCommentAll,
  workspaceDeleteAll,
  workspaceUncommentAll,
} from './commands';
import { registerCodeActions } from './codeActions';
import {
  batchOnCurrentFile,
  ConsoleLogExplorerProvider,
  copyLogText,
  CURRENT_VIEW_ID,
  deleteLogItem,
  filterLevels,
  LogItem,
  revealLine,
  toggleLogItem,
  WORKSPACE_VIEW_ID,
  WorkspaceLogProvider,
} from './logExplorer';
import { registerDiagnostics } from './diagnostics';

export function activate(context: vscode.ExtensionContext): void {
  // register the sidebar views: current file + workspace
  const provider = new ConsoleLogExplorerProvider();
  const treeView = vscode.window.createTreeView(CURRENT_VIEW_ID, { treeDataProvider: provider });
  provider.attach(treeView);
  const workspaceProvider = new WorkspaceLogProvider();
  const workspaceView = vscode.window.createTreeView(WORKSPACE_VIEW_ID, {
    treeDataProvider: workspaceProvider,
    showCollapseAll: true,
  });
  workspaceProvider.attach(workspaceView);
  context.subscriptions.push(provider, treeView, workspaceProvider, workspaceView);

  const onStale = () => {
    provider.refresh();
    workspaceProvider.refresh();
  };

  const registrations: [string, (...args: unknown[]) => Promise<void> | void][] = [
    ['easyConsoleLog.insert', (args) => insertLog(args as InsertArgs | undefined)],
    ['easyConsoleLog.insertWithLevel', insertLogWithLevel],
    ['easyConsoleLog.updateLineNumbers', updateLineNumbers],
    ['easyConsoleLog.commentAll', commentAllLogs],
    ['easyConsoleLog.uncommentAll', uncommentAllLogs],
    ['easyConsoleLog.deleteAll', deleteAllLogs],
    ['easyConsoleLog.toggleCurrentLog', toggleCurrentLog],
    ['easyConsoleLog.changed.commentAll', changedCommentAll],
    ['easyConsoleLog.changed.uncommentAll', changedUncommentAll],
    ['easyConsoleLog.changed.deleteAll', changedDeleteAll],
    ['easyConsoleLog.workspace.commentAll', workspaceCommentAll],
    ['easyConsoleLog.workspace.uncommentAll', workspaceUncommentAll],
    ['easyConsoleLog.workspace.deleteAll', workspaceDeleteAll],
    ['easyConsoleLog.workspace.refresh', () => workspaceProvider.refresh()],
    ['easyConsoleLog.explorer.refresh', () => provider.refresh()],
    ['easyConsoleLog.explorer.revealLine', (uri, line) =>
      revealLine(uri as vscode.Uri, line as number)],
    ['easyConsoleLog.explorer.commentAll', () => batchOnCurrentFile('comment')],
    ['easyConsoleLog.explorer.uncommentAll', () => batchOnCurrentFile('uncomment')],
    ['easyConsoleLog.explorer.deleteAll', () => batchOnCurrentFile('delete')],
    ['easyConsoleLog.explorer.filter', filterLevels],
    ['easyConsoleLog.explorer.toggleItem', (item) => toggleLogItem(item as LogItem, onStale)],
    ['easyConsoleLog.explorer.deleteItem', (item) => deleteLogItem(item as LogItem, onStale)],
    ['easyConsoleLog.explorer.copyText', (item) => copyLogText(item as LogItem)],
  ];
  for (const [command, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }

  // refresh immediately on editor switch; debounce while typing to avoid rebuilding the tree on every keystroke
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      workspaceProvider.onDocumentChanged(e.document);
      if (e.document === vscode.window.activeTextEditor?.document) {
        clearTimeout(timer);
        timer = setTimeout(() => provider.refresh(), 200);
      }
    }),
    { dispose: () => clearTimeout(timer) }
  );
  provider.refresh();

  registerDiagnostics(context);
  registerCodeActions(context);
  registerLineNumbersOnSave(context);
}

export function deactivate(): void {}
