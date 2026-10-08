import * as vscode from 'vscode';
import {
  commentAllLogs,
  deleteAllLogs,
  insertLog,
  uncommentAllLogs,
} from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const registrations: [string, () => Promise<void>][] = [
    ['easyConsoleLog.insert', insertLog],
    ['easyConsoleLog.commentAll', commentAllLogs],
    ['easyConsoleLog.uncommentAll', uncommentAllLogs],
    ['easyConsoleLog.deleteAll', deleteAllLogs],
  ];
  for (const [command, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }
}

export function deactivate(): void {}
