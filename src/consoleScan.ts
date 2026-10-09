import * as vscode from 'vscode';

/** 匹配所有 console.* 调用行（含被注释的），group4 为级别 */
export const CONSOLE_LINE_RE =
  /^(\s*)(\/\/\s*)?(console\.(log|debug|info|warn|error)\s*\()/;

export interface ConsoleLogLine {
  /** 0-based 行号 */
  line: number;
  /** 去除首尾空白后的文本 */
  text: string;
  /** 是否已被注释 */
  commented: boolean;
  /** log / debug / info / warn / error */
  level: string;
  /** 行前缩进长度 */
  indentLen: number;
  /** 注释符 "// " 的长度，未注释为 0 */
  commentLen: number;
}

/** 收集文档中所有 console.* 调用行 */
export function collectConsoleLines(doc: vscode.TextDocument): ConsoleLogLine[] {
  const items: ConsoleLogLine[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const m = text.match(CONSOLE_LINE_RE);
    if (m) {
      items.push({
        line: i,
        text: text.trim(),
        commented: m[2] !== undefined,
        level: m[4],
        indentLen: m[1].length,
        commentLen: m[2]?.length ?? 0,
      });
    }
  }
  return items;
}

/** 在 editBuilder 中对一条 console 行执行注释/取消注释/删除 */
export function applyToLine(
  builder: vscode.TextEditorEdit,
  doc: vscode.TextDocument,
  item: ConsoleLogLine,
  mode: 'comment' | 'uncomment' | 'delete'
): void {
  const line = doc.lineAt(item.line);
  if (mode === 'comment' && !item.commented) {
    builder.insert(new vscode.Position(item.line, item.indentLen), '// ');
  } else if (mode === 'uncomment' && item.commented) {
    builder.delete(
      new vscode.Range(
        item.line,
        item.indentLen,
        item.line,
        item.indentLen + item.commentLen
      )
    );
  } else if (mode === 'delete') {
    if (item.line === doc.lineCount - 1 && doc.lineCount > 1) {
      builder.delete(
        new vscode.Range(doc.lineAt(item.line - 1).range.end, line.range.end)
      );
    } else {
      builder.delete(line.rangeIncludingLineBreak);
    }
  }
}
