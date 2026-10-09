import * as vscode from 'vscode';
import { getConfig } from './config';
import { collectConsoleLines } from './consoleScan';

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/** 为文档中的 console.* 行生成诊断 */
export function refreshDiagnostics(
  collection: vscode.DiagnosticCollection,
  doc: vscode.TextDocument
): void {
  const cfg = getConfig();
  if (!cfg.diagnosticsEnabled || doc.uri.scheme !== 'file') {
    collection.delete(doc.uri);
    return;
  }
  const severity = SEVERITY_MAP[cfg.diagnosticsSeverity] ?? vscode.DiagnosticSeverity.Information;
  const diagnostics = collectConsoleLines(doc).map(
    (item) =>
      new vscode.Diagnostic(
        doc.lineAt(item.line).range,
        item.commented
          ? 'Easy Console Log: 已注释的 console 调用'
          : 'Easy Console Log: console 调用',
        severity
      )
  );
  collection.set(doc.uri, diagnostics);
}

/** 注册诊断更新监听 */
export function registerDiagnostics(
  context: vscode.ExtensionContext
): void {
  const collection = vscode.languages.createDiagnosticCollection('easyConsoleLog');
  context.subscriptions.push(collection);

  let timer: NodeJS.Timeout | undefined;
  const schedule = (doc?: vscode.TextDocument) => {
    if (!doc || doc.uri.scheme !== 'file') {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => refreshDiagnostics(collection, doc), 300);
  };

  for (const doc of vscode.workspace.textDocuments) {
    refreshDiagnostics(collection, doc);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => schedule(doc))
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document))
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => schedule(doc))
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('easyConsoleLog.diagnostics')) {
        for (const doc of vscode.workspace.textDocuments) {
          refreshDiagnostics(collection, doc);
        }
      }
    })
  );
}
