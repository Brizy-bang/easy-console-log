import * as vscode from 'vscode';
import {
  batchEdits,
  BatchMode,
  commentTokenFor,
  LineEdit,
  LogBlock,
  MODE_TEXT,
  splitLines,
} from './consoleScan';

/** 侧边栏、诊断、工作区批量操作支持的语言（console.* 语义） */
export const JS_LANGS = new Set([
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'vue',
  'svelte',
]);

/** 可同时适配 TextEditorEdit 与 WorkspaceEdit 的编辑接收器 */
export interface EditSink {
  insert(pos: vscode.Position, text: string): void;
  delete(range: vscode.Range): void;
}

export function docLines(doc: vscode.TextDocument): string[] {
  return splitLines(doc.getText());
}

export function applyLineEdits(sink: EditSink, edits: readonly LineEdit[]): void {
  for (const e of edits) {
    if (e.kind === 'insert') {
      sink.insert(new vscode.Position(e.line, e.char), e.text);
    } else {
      sink.delete(new vscode.Range(e.line, e.char, e.endLine, e.endChar));
    }
  }
}

export function workspaceSink(edit: vscode.WorkspaceEdit, uri: vscode.Uri): EditSink {
  return {
    insert: (pos, text) => edit.insert(uri, pos, text),
    delete: (range) => edit.delete(uri, range),
  };
}

/** 对当前编辑器执行一批块操作，并给出结果提示（notify=false 时只提示失败） */
export async function applyBatchToEditor(
  editor: vscode.TextEditor,
  lines: readonly string[],
  blocks: readonly LogBlock[],
  mode: BatchMode,
  notify = true
): Promise<void> {
  const token = commentTokenFor(editor.document.fileName);
  const { edits, count, skipped } = batchEdits(lines, blocks, mode, token);
  const text = MODE_TEXT[mode];
  if (count === 0) {
    const reason = skipped ? `（${skipped} 条与其他代码位于同一行，已跳过）` : '';
    vscode.window.showInformationMessage(`Easy Console Log: 没有可${text}的日志${reason}`);
    return;
  }
  await editor.edit((builder) => applyLineEdits(builder, edits));
  if (!notify) {
    return;
  }
  const extra = skipped ? `，跳过 ${skipped} 条（与其他代码位于同一行）` : '';
  vscode.window.showInformationMessage(`Easy Console Log: 已${text} ${count} 条日志${extra}`);
}
