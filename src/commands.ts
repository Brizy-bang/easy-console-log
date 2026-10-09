import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import {
  createInsertTargetResolver,
  InsertMode,
  scriptKindForFile,
} from './astResolver';
import { getConfig } from './config';
import { buildLogStatement, logLineRegExp } from './logStatement';
import { collectConsoleLines, CONSOLE_LINE_RE } from './consoleScan';

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

/** 按顶层逗号拆分表达式，忽略括号/引号内的逗号 */
function splitTopLevelCommas(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote && expr[i - 1] !== '\\') {
        quote = undefined;
      }
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

const IDENT_RE = /^[a-zA-Z_$][\w$]*$/;

/** 提取 Vue/Svelte 的 <script> 块内容及其在文档中的偏移 */
function extractScriptBlock(
  doc: vscode.TextDocument
): { text: string; offset: number; startLine: number } | undefined {
  const m = doc.getText().match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (!m || m.index === undefined) {
    return undefined;
  }
  const offset = m.index + m[0].indexOf('>') + 1;
  return { text: m[1], offset, startLine: doc.positionAt(offset).line };
}

/** 构建针对当前文档的插入点解析器，支持 Vue/Svelte 的 <script> 块 */
function buildResolver(
  doc: vscode.TextDocument
): ((offset: number) => ReturnType<ReturnType<typeof createInsertTargetResolver>>) | undefined {
  const kind = scriptKindForFile(doc.fileName);
  if (kind !== undefined) {
    return createInsertTargetResolver(doc.getText(), doc.fileName, kind);
  }
  if (/\.(vue|svelte)$/i.test(doc.fileName)) {
    const block = extractScriptBlock(doc);
    if (block) {
      const inner = createInsertTargetResolver(block.text, doc.fileName, ts.ScriptKind.TS);
      return (offset) => {
        const r = inner(offset - block.offset);
        if (r.ok) {
          return {
            ok: true,
            target: {
              ...r.target,
              anchorLine: r.target.anchorLine + block.startLine,
              indentLine: r.target.indentLine + block.startLine,
            },
          };
        }
        return r;
      };
    }
  }
  return undefined;
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

  const resolver = buildResolver(doc);
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
      let expr = normalizeDeclarationExpr(raw.trim().replace(/;+\s*$/, ''));
      if (expr) {
        const parts = splitTopLevelCommas(expr);
        if (parts.length > 1 && parts.every((p) => IDENT_RE.test(p))) {
          // 多个标识符 → console.log({a, b})
          expr = `{${parts.join(', ')}}`;
        }
      }
      expression = expr;
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

/** 切换光标所在行 console 调用的注释状态 */
export async function toggleCurrentLog(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const line = doc.lineAt(editor.selection.active.line);
  const m = line.text.match(CONSOLE_LINE_RE);
  if (!m) {
    vscode.window.showInformationMessage('Easy Console Log: 当前行不是 console 调用');
    return;
  }
  const commented = m[2] !== undefined;
  await editor.edit((builder) => {
    if (commented) {
      builder.delete(
        new vscode.Range(
          line.lineNumber,
          m[1].length,
          line.lineNumber,
          m[1].length + m[2].length
        )
      );
    } else {
      builder.insert(new vscode.Position(line.lineNumber, m[1].length), '// ');
    }
  });
}

const WORKSPACE_GLOB = '**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts,vue,svelte,py}';
const EXCLUDE_GLOB = '**/{node_modules,dist,out,build,.git,vendor}/**';

/** 对整个工作区执行 console.* 批量操作 */
async function batchOnWorkspace(mode: 'comment' | 'uncomment' | 'delete') {
  const files = await vscode.workspace.findFiles(WORKSPACE_GLOB, EXCLUDE_GLOB);
  if (files.length === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 工作区中没有找到相关文件');
    return;
  }
  const modeText =
    mode === 'comment' ? '注释' : mode === 'uncomment' ? '取消注释' : '删除';
  const confirm = await vscode.window.showWarningMessage(
    `将在 ${files.length} 个文件中${modeText}所有 console.* 调用，确认继续？`,
    { modal: true },
    '确认'
  );
  if (confirm !== '确认') {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  let total = 0;
  for (const uri of files) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const targets = collectConsoleLines(doc).filter((t) =>
      mode === 'comment'
        ? !t.commented
        : mode === 'uncomment'
          ? t.commented
          : true
    );
    // 从后往前删，避免行号偏移
    const ordered = [...targets].sort((a, b) => b.line - a.line);
    for (const t of ordered) {
      if (mode === 'comment') {
        edit.insert(uri, new vscode.Position(t.line, t.indentLen), '// ');
      } else if (mode === 'uncomment') {
        edit.delete(
          uri,
          new vscode.Range(
            t.line,
            t.indentLen,
            t.line,
            t.indentLen + t.commentLen
          )
        );
      } else {
        const line = doc.lineAt(t.line);
        if (t.line === doc.lineCount - 1 && doc.lineCount > 1) {
          edit.delete(
            uri,
            new vscode.Range(doc.lineAt(t.line - 1).range.end, line.range.end)
          );
        } else {
          edit.delete(uri, line.rangeIncludingLineBreak);
        }
      }
      total++;
    }
  }
  if (total === 0) {
    vscode.window.showInformationMessage(`Easy Console Log: 没有可${modeText}的日志`);
    return;
  }
  await vscode.workspace.applyEdit(edit);
  vscode.window.showInformationMessage(
    `Easy Console Log: 已在工作区中${modeText} ${total} 条日志`
  );
}

export function workspaceCommentAll(): Promise<void> {
  return batchOnWorkspace('comment');
}

export function workspaceUncommentAll(): Promise<void> {
  return batchOnWorkspace('uncomment');
}

export function workspaceDeleteAll(): Promise<void> {
  return batchOnWorkspace('delete');
}
