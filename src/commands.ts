import * as path from 'path';
import * as vscode from 'vscode';
import {
  createInsertTargetResolver,
  InsertMode,
  scriptKindForFile,
} from './astResolver';
import { getConfig } from './config';
import { buildLogStatement, logLineRegExp } from './logStatement';

/** 匹配成员表达式 / 链式访问，如 a.b.c、a['x']、this.state.list */
const MEMBER_EXPR = /[$\w]+(?:\.[$\w]+|\[(?:\d+|["'`][^\]"'`]*["'`])\])*/;

/** 用户整行选中了 `const x = 1` 这类声明时，提取出可输出的标识符 */
function normalizeDeclarationExpr(expr: string): string | undefined {
  const m = expr.match(/^(?:const|let|var)\s+/);
  if (!m) {
    return expr;
  }
  return expr.slice(m[0].length).match(/[\w$]+/)?.[0];
}

interface Target {
  expression: string;
  mode: InsertMode;
  /** 插入锚点行（0-based） */
  anchorLine: number;
  /** 日志语句的缩进 */
  indent: string;
  /** 日志最终所在的行号（1-based），用于消息文本 */
  logLine: number;
}

/** 为选中/光标下的表达式插入日志语句 */
export async function insertLog(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const cfg = getConfig();
  const fileName = path.basename(doc.fileName);

  const kind = scriptKindForFile(doc.fileName);
  const resolver =
    kind !== undefined
      ? createInsertTargetResolver(doc.getText(), doc.fileName, kind)
      : undefined;
  const indentUnit = editor.options.insertSpaces
    ? ' '.repeat(Number(editor.options.tabSize) || 4)
    : '\t';
  const indentOf = (line: number) => doc.lineAt(line).text.match(/^\s*/)?.[0] ?? '';

  const targets: Target[] = [];
  const skippedReasons = new Set<string>();

  for (const sel of editor.selections) {
    let expression: string | undefined;
    // 用于 AST 定位的偏移（表达式首字符）
    let probe: vscode.Position;
    // 无 AST 时的降级插入行
    let fallbackLine: number;

    if (!sel.isEmpty) {
      const raw = doc.getText(sel);
      const leadingWs = raw.length - raw.trimStart().length;
      expression = normalizeDeclarationExpr(raw.trim().replace(/;+\s*$/, ''));
      probe = sel.start.translate(0, leadingWs);
      fallbackLine = sel.end.line;
      if (sel.end.character === 0 && sel.end.line > sel.start.line) {
        fallbackLine--;
      }
    } else {
      const range = doc.getWordRangeAtPosition(sel.active, MEMBER_EXPR);
      if (!range) {
        continue;
      }
      expression = doc.getText(range);
      probe = range.start;
      fallbackLine = sel.active.line;
    }
    if (!expression) {
      continue;
    }

    if (resolver) {
      const res = resolver(doc.offsetAt(probe));
      if (res.ok) {
        const { mode, anchorLine, indentLine } = res.target;
        targets.push({
          expression,
          mode,
          anchorLine,
          indent: indentOf(indentLine) + (mode === 'inside-start' ? indentUnit : ''),
          // 日志实际落在 anchorLine 的下一行（before 则是自身行）
          logLine: mode === 'before' ? anchorLine + 1 : anchorLine + 2,
        });
      } else if (res.skip) {
        skippedReasons.add(res.reason);
      } else {
        targets.push({
          expression,
          mode: 'after',
          anchorLine: fallbackLine,
          indent: indentOf(fallbackLine),
          logLine: fallbackLine + 2,
        });
      }
    } else {
      targets.push({
        expression,
        mode: 'after',
        anchorLine: fallbackLine,
        indent: indentOf(fallbackLine),
        logLine: fallbackLine + 2,
      });
    }
  }

  if (targets.length === 0) {
    const detail = skippedReasons.size
      ? `（${[...skippedReasons].join('、')}）`
      : '';
    vscode.window.showWarningMessage(
      `Easy Console Log: 未找到可输出的变量或表达式${detail}`
    );
    return;
  }

  await editor.edit((builder) => {
    for (const t of targets) {
      const stmt = buildLogStatement(t.expression, fileName, t.logLine, t.indent, cfg);
      if (t.mode === 'before') {
        builder.insert(new vscode.Position(t.anchorLine, 0), `${stmt}\n`);
      } else {
        builder.insert(doc.lineAt(t.anchorLine).range.end, `\n${stmt}`);
      }
    }
  });

  if (skippedReasons.size) {
    vscode.window.showWarningMessage(
      `Easy Console Log: 已跳过部分位置（${[...skippedReasons].join('、')}）`
    );
  }
}

/** 遍历全文，返回所有由本扩展生成的日志行信息 */
function collectLogLines(doc: vscode.TextDocument, re: RegExp) {
  const items: { line: number; indentLen: number; commented: boolean; commentLen: number }[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const m = doc.lineAt(i).text.match(re);
    if (m) {
      items.push({
        line: i,
        indentLen: m[1].length,
        commented: m[2] !== undefined,
        commentLen: m[2]?.length ?? 0,
      });
    }
  }
  return items;
}

/** 注释掉文件内所有生成的日志 */
export async function commentAllLogs(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const targets = collectLogLines(doc, logLineRegExp(getConfig().prefix)).filter(
    (t) => !t.commented
  );
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 没有可注释的日志');
    return;
  }
  await editor.edit((builder) => {
    for (const t of targets) {
      builder.insert(new vscode.Position(t.line, t.indentLen), '// ');
    }
  });
  vscode.window.showInformationMessage(`Easy Console Log: 已注释 ${targets.length} 条日志`);
}

/** 取消注释文件内所有被注释的生成日志 */
export async function uncommentAllLogs(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const targets = collectLogLines(doc, logLineRegExp(getConfig().prefix)).filter(
    (t) => t.commented
  );
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 没有可取消注释的日志');
    return;
  }
  await editor.edit((builder) => {
    for (const t of targets) {
      const range = new vscode.Range(
        t.line,
        t.indentLen,
        t.line,
        t.indentLen + t.commentLen
      );
      builder.delete(range);
    }
  });
  vscode.window.showInformationMessage(`Easy Console Log: 已恢复 ${targets.length} 条日志`);
}

/** 删除文件内所有生成的日志（含被注释的） */
export async function deleteAllLogs(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const targets = collectLogLines(doc, logLineRegExp(getConfig().prefix));
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 没有可删除的日志');
    return;
  }
  await editor.edit((builder) => {
    for (const t of targets) {
      const line = doc.lineAt(t.line);
      if (t.line === doc.lineCount - 1 && doc.lineCount > 1) {
        // 最后一行没有换行符，连同前一行的换行一起删掉，避免残留空行
        builder.delete(new vscode.Range(doc.lineAt(t.line - 1).range.end, line.range.end));
      } else {
        builder.delete(line.rangeIncludingLineBreak);
      }
    }
  });
  vscode.window.showInformationMessage(`Easy Console Log: 已删除 ${targets.length} 条日志`);
}
