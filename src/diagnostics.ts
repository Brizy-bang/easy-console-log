import * as vscode from 'vscode';
import { getConfig } from './config';
import { scanConsole } from './consoleScan';
import { docLines, JS_LANGS } from './editUtil';

export const DIAGNOSTIC_SOURCE = 'easy-console-log';

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/** 为文档中未注释的 console.* 调用生成诊断 */
export function refreshDiagnostics(
  collection: vscode.DiagnosticCollection,
  doc: vscode.TextDocument
): void {
  const cfg = getConfig();
  if (!cfg.diagnosticsEnabled || doc.uri.scheme !== 'file' || !JS_LANGS.has(doc.languageId)) {
    collection.delete(doc.uri);
    return;
  }
  const severity = SEVERITY_MAP[cfg.diagnosticsSeverity] ?? vscode.DiagnosticSeverity.Hint;
  const diagnostics = scanConsole(docLines(doc), doc.fileName)
    .filter((b) => !b.commented)
    .map((b) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(b.line, b.indentLen, b.endLine, b.endChar),
        vscode.l10n.t('console call'),
        severity
      );
      d.source = DIAGNOSTIC_SOURCE;
      return d;
    });
  collection.set(doc.uri, diagnostics);
}

/** 注册诊断更新监听 */
export function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('easyConsoleLog');
  // 按文档分别防抖，避免多个文件同时变化时只刷新最后一个
  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        refreshDiagnostics(collection, doc);
      }, 300)
    );
  };
  const refreshAll = () => {
    for (const doc of vscode.workspace.textDocuments) {
      refreshDiagnostics(collection, doc);
    }
  };

  refreshAll();
  context.subscriptions.push(
    collection,
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearTimeout(timers.get(doc.uri.toString()));
      collection.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('easyConsoleLog.diagnostics')) {
        refreshAll();
      }
    })
  );
}
