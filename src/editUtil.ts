import * as vscode from 'vscode';
import {
  batchEdits,
  BatchMode,
  commentTokenFor,
  LineEdit,
  LogBlock,
  splitLines,
} from './consoleScan';

/** Languages supported by the sidebar, diagnostics and workspace batch ops (console.* semantics) */
export const JS_LANGS = new Set([
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'vue',
  'svelte',
]);

/** Edit sink that works with both TextEditorEdit and WorkspaceEdit */
export interface EditSink {
  insert(pos: vscode.Position, text: string): void;
  delete(range: vscode.Range): void;
  replace(range: vscode.Range, text: string): void;
}

export function docLines(doc: vscode.TextDocument): string[] {
  return splitLines(doc.getText());
}

export function applyLineEdits(sink: EditSink, edits: readonly LineEdit[]): void {
  for (const e of edits) {
    if (e.kind === 'insert') {
      sink.insert(new vscode.Position(e.line, e.char), e.text);
    } else if (e.kind === 'delete') {
      sink.delete(new vscode.Range(e.line, e.char, e.endLine, e.endChar));
    } else {
      sink.replace(new vscode.Range(e.line, e.char, e.endLine, e.endChar), e.text);
    }
  }
}

export function workspaceSink(edit: vscode.WorkspaceEdit, uri: vscode.Uri): EditSink {
  return {
    insert: (pos, text) => edit.insert(uri, pos, text),
    delete: (range) => edit.delete(uri, range),
    replace: (range, text) => edit.replace(uri, range, text),
  };
}

/** Convert to a TextEdit array (for onWillSaveTextDocument and similar) */
export function toTextEdits(edits: readonly LineEdit[]): vscode.TextEdit[] {
  const out: vscode.TextEdit[] = [];
  applyLineEdits(
    {
      insert: (pos, text) => out.push(vscode.TextEdit.insert(pos, text)),
      delete: (range) => out.push(vscode.TextEdit.delete(range)),
      replace: (range, text) => out.push(vscode.TextEdit.replace(range, text)),
    },
    edits
  );
  return out;
}

/** Verb for a batch mode, used to compose result messages */
export function modeVerb(mode: BatchMode): string {
  return mode === 'comment'
    ? vscode.l10n.t('comment out')
    : mode === 'uncomment'
      ? vscode.l10n.t('uncomment')
      : vscode.l10n.t('delete');
}

function skippedSuffix(skipped: number): string {
  return skipped ? vscode.l10n.t(' ({0} skipped because they share a line with other code)', skipped) : '';
}

/** Batch operation result message; count === 0 means "no logs to process" */
export function batchResultMessage(mode: BatchMode, count: number, skipped: number): string {
  if (count === 0) {
    return vscode.l10n.t('Easy Console Log: no logs to {0}', modeVerb(mode)) + skippedSuffix(skipped);
  }
  const done =
    mode === 'comment'
      ? vscode.l10n.t('Easy Console Log: commented out {0} log(s)', count)
      : mode === 'uncomment'
        ? vscode.l10n.t('Easy Console Log: uncommented {0} log(s)', count)
        : vscode.l10n.t('Easy Console Log: deleted {0} log(s)', count);
  return done + skippedSuffix(skipped);
}

/** Apply a set of block operations to the current editor and show a result message
 * (notify=false only reports failures) */
export async function applyBatchToEditor(
  editor: vscode.TextEditor,
  lines: readonly string[],
  blocks: readonly LogBlock[],
  mode: BatchMode,
  notify = true
): Promise<void> {
  const token = commentTokenFor(editor.document.fileName);
  const { edits, count, skipped } = batchEdits(lines, blocks, mode, token);
  if (count > 0) {
    await editor.edit((builder) => applyLineEdits(builder, edits));
  }
  if (notify || count === 0) {
    vscode.window.showInformationMessage(batchResultMessage(mode, count, skipped));
  }
}
