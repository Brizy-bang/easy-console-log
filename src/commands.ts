import * as path from 'path';
import * as vscode from 'vscode';
import type { InsertMode, ResolveResult, Resolver } from './astResolver';
import { getConfig } from './config';
import { buildLogStatement, isPythonFile } from './logStatement';
import {
  batchEdits,
  BatchMode,
  blockAtLine,
  commentTokenFor,
  isApplicable,
  LineEdit,
  LogBlock,
  MODE_TEXT,
  scanConsole,
  scanGenerated,
  splitLines,
} from './consoleScan';
import { applyBatchToEditor, applyLineEdits, docLines, workspaceSink } from './editUtil';

type AstModule = typeof import('./astResolver');
let astModule: Promise<AstModule> | undefined;

/** TypeScript 编译器体积较大，首次需要时再加载，避免拖慢扩展激活 */
function loadAst(): Promise<AstModule> {
  return (astModule ??= import('./astResolver'));
}

/** 匹配成员表达式 / 链式访问，如 a.b.c、a?.b、a['x']（无 AST 时的降级方案） */
const MEMBER_EXPR = /[$\w]+(?:\??\.[$\w]+|\[(?:\d+|["'`][^\]"'`]*["'`])\])*/;

/** 降级匹配时需要排除的关键字（JS + Python） */
const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new typeof ' +
    'instanceof in of class extends import export from default try catch finally throw async await ' +
    'yield delete void def lambda pass elif not and or is None True False with as global nonlocal ' +
    'raise except del assert'
  ).split(' ')
);

const IDENT_RE = /^[a-zA-Z_$][\w$]*$/;
const AST_FILE_RE = /\.([cm]?[jt]sx?|vue|svelte)$/i;
const SFC_FILE_RE = /\.(vue|svelte)$/i;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

const MARKER_WARNING =
  'Easy Console Log: 无法识别本扩展生成的日志。' +
  '请确认 logMessagePrefix 不为空，且 messageTemplate 以固定文本或 ${prefix} 开头';

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

interface DocResolver extends Resolver {
  /** offset 是否处于可做 AST 分析的区域（Vue/Svelte 中即 <script> 块内） */
  covers(offset: number): boolean;
}

/** 构建针对当前文档的解析器，支持 Vue/Svelte 的多个 <script> 块 */
async function buildResolver(doc: vscode.TextDocument): Promise<DocResolver | undefined> {
  if (!AST_FILE_RE.test(doc.fileName)) {
    return undefined;
  }
  const ast = await loadAst();
  if (!SFC_FILE_RE.test(doc.fileName)) {
    const kind = ast.scriptKindForFile(doc.fileName);
    return kind === undefined
      ? undefined
      : { ...ast.createResolver(doc.getText(), doc.fileName, kind), covers: () => true };
  }

  const blocks = [...doc.getText().matchAll(SCRIPT_RE)].map((m) => {
    const start = (m.index ?? 0) + m[0].indexOf('>') + 1;
    const lang = /\blang\s*=\s*["']?(\w+)/.exec(m[1])?.[1];
    return {
      start,
      end: start + m[2].length,
      startLine: doc.positionAt(start).line,
      resolver: ast.createResolver(m[2], doc.fileName, ast.scriptKindForLang(lang)),
    };
  });
  const find = (offset: number) => blocks.find((b) => offset >= b.start && offset <= b.end);

  return {
    covers: (offset) => find(offset) !== undefined,
    resolve(offset): ResolveResult {
      const b = find(offset);
      if (!b) {
        return { ok: false, reason: '不在 <script> 块内', skip: true };
      }
      const r = b.resolver.resolve(offset - b.start);
      if (!r.ok) {
        return r;
      }
      const { anchorLine, indentLine } = r.target;
      return {
        ok: true,
        target: { ...r.target, anchorLine: anchorLine + b.startLine, indentLine: indentLine + b.startLine },
      };
    },
    expressionAt(offset) {
      const b = find(offset);
      const r = b?.resolver.expressionAt(offset - b.start);
      return b && r ? { ...r, start: r.start + b.start, end: r.end + b.start } : undefined;
    },
  };
}

/** 从选中文本得到要输出的表达式 */
async function expressionFromSelection(raw: string): Promise<string | undefined> {
  const expr = raw.trim().replace(/;+\s*$/, '');
  if (/^(?:const|let|var)\s/.test(expr)) {
    // 选中整条声明时提取绑定名，支持解构：const { a, b } = obj → {a, b}
    const names = (await loadAst()).declarationNames(expr);
    if (!names) {
      return undefined;
    }
    return names.length === 1 ? names[0] : `{${names.join(', ')}}`;
  }
  const parts = splitTopLevelCommas(expr);
  if (parts.length > 1 && parts.every((p) => IDENT_RE.test(p))) {
    // 多个标识符 → console.log({a, b})
    return `{${parts.join(', ')}}`;
  }
  return expr || undefined;
}

/** 取光标处的表达式：AST 可用时以 AST 为准，否则用正则降级 */
function expressionAtCursor(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  resolver: DocResolver | undefined
): { text: string; start: vscode.Position } | undefined {
  const offset = doc.offsetAt(pos);
  if (resolver?.covers(offset)) {
    const r = resolver.expressionAt(offset);
    return r && { text: r.text, start: doc.positionAt(r.start) };
  }
  const range = doc.getWordRangeAtPosition(pos, MEMBER_EXPR);
  if (!range) {
    return undefined;
  }
  const text = doc.getText(range);
  if (/^\d/.test(text) || KEYWORDS.has(text.match(/^[$\w]+/)?.[0] ?? '')) {
    return undefined;
  }
  return { text, start: range.start };
}

interface Target {
  expression: string;
  mode: InsertMode;
  /** 插入锚点行（0-based） */
  anchorLine: number;
  /** 日志语句的缩进 */
  indent: string;
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
  const py = isPythonFile(doc.fileName);

  const resolver = await buildResolver(doc);
  const indentUnit = editor.options.insertSpaces
    ? ' '.repeat(Number(editor.options.tabSize) || 4)
    : '\t';
  const indentOf = (line: number) => doc.lineAt(line).text.match(/^\s*/)?.[0] ?? '';
  // 降级插入：Python 中以冒号结尾的行（def/if/for 等）需要缩进一级
  const fallbackIndent = (line: number) =>
    indentOf(line) + (py && /:\s*(#.*)?$/.test(doc.lineAt(line).text) ? indentUnit : '');

  const targets: Target[] = [];
  const seen = new Set<string>();
  const skippedReasons = new Set<string>();

  for (const sel of editor.selections) {
    let expression: string | undefined;
    // 用于 AST 定位的位置（表达式首字符）
    let probe: vscode.Position;
    // 无 AST 时的降级插入行
    let fallbackLine: number;

    if (!sel.isEmpty) {
      const raw = doc.getText(sel);
      expression = await expressionFromSelection(raw);
      probe = doc.positionAt(doc.offsetAt(sel.start) + raw.length - raw.trimStart().length);
      fallbackLine = sel.end.line;
      if (sel.end.character === 0 && sel.end.line > sel.start.line) {
        fallbackLine--;
      }
    } else {
      const hit = expressionAtCursor(doc, sel.active, resolver);
      expression = hit?.text;
      probe = hit?.start ?? sel.active;
      fallbackLine = sel.active.line;
    }
    if (!expression) {
      continue;
    }

    const res = resolver?.resolve(doc.offsetAt(probe));
    let target: Target;
    if (res && res.ok) {
      const { mode, anchorLine, indentLine } = res.target;
      const indent = indentOf(indentLine) + (mode === 'inside-start' ? indentUnit : '');
      target = { expression, mode, anchorLine, indent };
    } else if (res && !res.ok && res.skip) {
      skippedReasons.add(res.reason);
      continue;
    } else {
      target = { expression, mode: 'after', anchorLine: fallbackLine, indent: fallbackIndent(fallbackLine) };
    }
    // 多个光标落在同一语句、同一表达式时只插一次
    const key = `${target.mode}:${target.anchorLine}:${expression}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  }

  if (targets.length === 0) {
    const detail = skippedReasons.size ? `（${[...skippedReasons].join('、')}）` : '';
    vscode.window.showWarningMessage(`Easy Console Log: 未找到可输出的变量或表达式${detail}`);
    return;
  }

  // 按最终落点排序：after 插在锚点行之后，before 插在锚点行之前；
  // 同一位置 after(L) 先于 before(L+1)。排序后第 i 条日志之前恰有 i 条新插入的行。
  const slot = (t: Target) => (t.mode === 'before' ? t.anchorLine - 0.5 : t.anchorLine + 0.5);
  const isBefore = (t: Target) => Number(t.mode === 'before');
  const ordered = targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => slot(a.t) - slot(b.t) || isBefore(a.t) - isBefore(b.t) || a.i - b.i)
    .map(({ t }) => t);

  await editor.edit((builder) => {
    ordered.forEach((t, idx) => {
      const base = t.mode === 'before' ? t.anchorLine : t.anchorLine + 1;
      const stmt = buildLogStatement(t.expression, fileName, base + idx + 1, t.indent, cfg);
      if (t.mode === 'before') {
        builder.insert(new vscode.Position(t.anchorLine, 0), `${stmt}\n`);
      } else {
        builder.insert(doc.lineAt(t.anchorLine).range.end, `\n${stmt}`);
      }
    });
  });

  if (skippedReasons.size) {
    vscode.window.showWarningMessage(
      `Easy Console Log: 已跳过部分位置（${[...skippedReasons].join('、')}）`
    );
  }
}

/** 对当前文件中由本扩展生成的日志执行批量操作 */
async function runOnGenerated(mode: BatchMode): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const lines = docLines(editor.document);
  const blocks = scanGenerated(lines, editor.document.fileName, getConfig());
  if (!blocks) {
    vscode.window.showWarningMessage(MARKER_WARNING);
    return;
  }
  await applyBatchToEditor(editor, lines, blocks, mode);
}

/** 注释掉文件内所有生成的日志 */
export function commentAllLogs(): Promise<void> {
  return runOnGenerated('comment');
}

/** 取消注释文件内所有被注释的生成日志 */
export function uncommentAllLogs(): Promise<void> {
  return runOnGenerated('uncomment');
}

/** 删除文件内所有生成的日志（含被注释的） */
export function deleteAllLogs(): Promise<void> {
  return runOnGenerated('delete');
}

/** 切换光标所在（或选区覆盖的）console 调用的注释状态，支持多行调用与多光标 */
export async function toggleCurrentLog(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const lines = docLines(doc);
  const blocks = scanConsole(lines, doc.fileName);
  const picked = new Set<LogBlock>();
  for (const sel of editor.selections) {
    for (let l = sel.start.line; l <= sel.end.line; l++) {
      const b = blockAtLine(blocks, l);
      if (b) {
        picked.add(b);
      }
    }
  }
  if (picked.size === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 当前行不是 console 调用');
    return;
  }
  const token = commentTokenFor(doc.fileName);
  const edits: LineEdit[] = [];
  let skipped = 0;
  for (const b of picked) {
    const r = batchEdits(lines, [b], b.commented ? 'uncomment' : 'comment', token);
    edits.push(...r.edits);
    skipped += r.skipped;
  }
  if (edits.length) {
    await editor.edit((builder) => applyLineEdits(builder, edits));
  }
  if (skipped) {
    vscode.window.showWarningMessage(
      `Easy Console Log: ${skipped} 条日志与其他代码位于同一行，无法按行注释`
    );
  }
}

const WORKSPACE_GLOB = '**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts,vue,svelte}';
const EXCLUDE_GLOB =
  '**/{node_modules,dist,out,build,.git,vendor,coverage,.next,.nuxt,.output,.svelte-kit}/**';
/** 含超长行的文件视为压缩/打包产物，整文件跳过，避免整行删除毁掉文件 */
const MAX_LINE_LEN = 3000;

interface FileHits {
  uri: vscode.Uri;
  lines: string[];
  /** 所有 console.* 中需要处理的块 */
  all: LogBlock[];
  /** 本扩展生成的日志中需要处理的块 */
  generated: LogBlock[];
}

/** 读取文件内容；已打开的文档以编辑器中的内容为准（可能有未保存修改） */
async function readLines(uri: vscode.Uri): Promise<string[]> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return docLines(open);
  }
  return splitLines(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
}

/** 扫描工作区，返回有命中的文件；用户取消时返回 undefined */
function scanWorkspace(mode: BatchMode): Thenable<FileHits[] | undefined> {
  const cfg = getConfig();
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Easy Console Log: 正在扫描工作区…',
      cancellable: true,
    },
    async (progress, token) => {
      const files = await vscode.workspace.findFiles(WORKSPACE_GLOB, EXCLUDE_GLOB, undefined, token);
      const hits: FileHits[] = [];
      for (const uri of files) {
        if (token.isCancellationRequested) {
          return undefined;
        }
        progress.report({ increment: 100 / files.length });
        if (/\.min\.[cm]?js$/i.test(uri.path)) {
          continue;
        }
        let lines: string[];
        try {
          lines = await readLines(uri);
        } catch {
          continue;
        }
        if (lines.some((l) => l.length > MAX_LINE_LEN)) {
          continue;
        }
        const all = scanConsole(lines, uri.path).filter((b) => isApplicable(b, mode));
        // 前缀为空等无法识别的配置下，scanGenerated 返回 undefined，"仅生成的日志"选项不出现
        const generated = (scanGenerated(lines, uri.path, cfg) ?? []).filter((b) => isApplicable(b, mode));
        if (all.length || generated.length) {
          hits.push({ uri, lines, all, generated });
        }
      }
      return hits;
    }
  );
}

/** 对整个工作区执行批量操作，执行前让用户选择范围（仅生成的日志 / 所有 console.*） */
async function batchOnWorkspace(mode: BatchMode): Promise<void> {
  const hits = await scanWorkspace(mode);
  if (!hits) {
    return;
  }
  const text = MODE_TEXT[mode];
  const sum = (pick: (h: FileHits) => LogBlock[]) => {
    const files = hits.filter((h) => pick(h).length > 0);
    return { files: files.length, logs: files.reduce((n, h) => n + pick(h).length, 0) };
  };
  const gen = sum((h) => h.generated);
  const all = sum((h) => h.all);
  if (gen.logs === 0 && all.logs === 0) {
    vscode.window.showInformationMessage(`Easy Console Log: 工作区中没有可${text}的日志`);
    return;
  }

  const GEN = `仅本扩展生成的日志（${gen.logs}）`;
  const ALL = `所有 console.*（${all.logs}）`;
  const choice = await vscode.window.showWarningMessage(
    `Easy Console Log: 即将在工作区中批量${text}日志`,
    {
      modal: true,
      detail:
        `本扩展生成的日志：${gen.logs} 条 / ${gen.files} 个文件\n` +
        `所有 console.* 调用：${all.logs} 条 / ${all.files} 个文件`,
    },
    ...(gen.logs ? [GEN] : []),
    ...(all.logs ? [ALL] : [])
  );
  if (!choice) {
    return;
  }

  const pick = choice === GEN ? (h: FileHits) => h.generated : (h: FileHits) => h.all;
  const edit = new vscode.WorkspaceEdit();
  const touched = new Set<string>();
  let total = 0;
  let skipped = 0;
  for (const h of hits) {
    const blocks = pick(h);
    if (!blocks.length) {
      continue;
    }
    const r = batchEdits(h.lines, blocks, mode, '//');
    applyLineEdits(workspaceSink(edit, h.uri), r.edits);
    total += r.count;
    skipped += r.skipped;
    if (r.count) {
      touched.add(h.uri.toString());
    }
  }
  const extra = skipped ? `，跳过 ${skipped} 条（与其他代码位于同一行）` : '';
  if (total === 0) {
    vscode.window.showInformationMessage(`Easy Console Log: 没有可${text}的日志${extra}`);
    return;
  }
  await vscode.workspace.applyEdit(edit);
  const SAVE = '保存这些文件';
  const action = await vscode.window.showInformationMessage(
    `Easy Console Log: 已在 ${touched.size} 个文件中${text} ${total} 条日志${extra}，修改尚未保存`,
    SAVE
  );
  if (action === SAVE) {
    await Promise.all(
      vscode.workspace.textDocuments
        .filter((d) => d.isDirty && touched.has(d.uri.toString()))
        .map((d) => d.save())
    );
  }
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
