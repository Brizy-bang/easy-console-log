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
  CONSOLE_LEVELS,
  isApplicable,
  isSkipped,
  LineEdit,
  LogBlock,
  scanConsole,
  scanGenerated,
} from './consoleScan';
import {
  applyBatchToEditor,
  applyLineEdits,
  batchResultMessage,
  docLines,
  JS_LANGS,
  modeVerb,
  toTextEdits,
  workspaceSink,
} from './editUtil';
import { lineNumberEdits } from './lineNumbers';
import { isScannable, scanFiles, scanWorkspace } from './workspaceScan';

type AstModule = typeof import('./astResolver');
let astModule: Promise<AstModule> | undefined;

/** The TypeScript compiler is heavy; load it on first use to keep activation fast */
function loadAst(): Promise<AstModule> {
  return (astModule ??= import('./astResolver'));
}

/** Match member / chain access like a.b.c, a?.b, a['x'] (fallback when no AST is available) */
const MEMBER_EXPR = /[$\w]+(?:\??\.[$\w]+|\[(?:\d+|["'`][^\]"'`]*["'`])\])*/;

/** Keywords excluded by the fallback matcher (JS + Python) */
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

function showMarkerWarning(): void {
  vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Easy Console Log: cannot recognize generated logs. Make sure logMessagePrefix is not empty ' +
        'and messageTemplate starts with fixed text or ${prefix}'
    )
  );
}

/** Split an expression on top-level commas, ignoring commas inside parens/quotes */
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
  /** Whether the offset lies in an AST-analyzable region (i.e. inside a <script> block for Vue/Svelte) */
  covers(offset: number): boolean;
}

/** Build a resolver for the document, supporting multiple <script> blocks in Vue/Svelte */
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
        return { ok: false, reason: ast.REASON.outsideScript, skip: true };
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
    namesAt(offset) {
      const b = find(offset);
      return b ? b.resolver.namesAt(offset - b.start) : { func: '', cls: '' };
    },
  };
}

/** Derive the expression to log from the selected text */
async function expressionFromSelection(raw: string): Promise<string | undefined> {
  const expr = raw.trim().replace(/;+\s*$/, '');
  if (/^(?:const|let|var)\s/.test(expr)) {
    // a full declaration selection extracts binding names, incl. destructuring: const { a, b } = obj -> {a, b}
    const names = (await loadAst()).declarationNames(expr);
    if (!names) {
      return undefined;
    }
    return names.length === 1 ? names[0] : `{${names.join(', ')}}`;
  }
  const parts = splitTopLevelCommas(expr);
  if (parts.length > 1 && parts.every((p) => IDENT_RE.test(p))) {
    // multiple identifiers -> console.log({a, b})
    return `{${parts.join(', ')}}`;
  }
  return expr || undefined;
}

/** Expression under the cursor: prefer AST when available, otherwise fall back to regex */
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
  /** Anchor line for insertion (0-based) */
  anchorLine: number;
  /** Indent of the log statement */
  indent: string;
  /** Enclosing function / class names (for the ${func}/${cls} placeholders) */
  func: string;
  cls: string;
}

export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** Command args, passable via keybindings.json args, e.g. { "level": "warn" } */
export interface InsertArgs {
  level?: ConsoleLevel;
}

const isLevel = (v: unknown): v is ConsoleLevel => CONSOLE_LEVELS.includes(v as ConsoleLevel);

/** Insert a log statement for the selected / under-cursor expression;
 * a given level uses console.<level> (ignored in Python) */
export async function insertLog(args?: InsertArgs): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const py = isPythonFile(doc.fileName);
  const level = args?.level;
  const cfg = { ...getConfig(doc), ...(isLevel(level) && !py ? { logFunction: `console.${level}` } : {}) };
  const fileName = path.basename(doc.fileName);

  const resolver = await buildResolver(doc);
  const indentUnit = editor.options.insertSpaces
    ? ' '.repeat(Number(editor.options.tabSize) || 4)
    : '\t';
  const indentOf = (line: number) => doc.lineAt(line).text.match(/^\s*/)?.[0] ?? '';
  // fallback insertion: in Python, lines ending with ':' (def/if/for ...) need one more indent level
  const fallbackIndent = (line: number) =>
    indentOf(line) + (py && /:\s*(#.*)?$/.test(doc.lineAt(line).text) ? indentUnit : '');

  const targets: Target[] = [];
  const seen = new Set<string>();
  const skippedReasons = new Set<string>();

  for (const sel of editor.selections) {
    let expression: string | undefined;
    // position used for AST resolution (first char of the expression)
    let probe: vscode.Position;
    // fallback insertion line when no AST is available
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

    const probeOffset = doc.offsetAt(probe);
    const res = resolver?.resolve(probeOffset);
    const names = resolver?.namesAt(probeOffset) ?? { func: '', cls: '' };
    let target: Target;
    if (res && res.ok) {
      const { mode, anchorLine, indentLine } = res.target;
      const indent = indentOf(indentLine) + (mode === 'inside-start' ? indentUnit : '');
      target = { expression, mode, anchorLine, indent, ...names };
    } else if (res && !res.ok && res.skip) {
      skippedReasons.add(res.reason);
      continue;
    } else {
      target = {
        expression,
        mode: 'after',
        anchorLine: fallbackLine,
        indent: fallbackIndent(fallbackLine),
        ...names,
      };
    }
    // multiple cursors on the same statement and same expression insert only once
    const key = `${target.mode}:${target.anchorLine}:${expression}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  }

  const reasons = [...skippedReasons].map((r) => vscode.l10n.t(r)).join(vscode.l10n.t(', '));
  if (targets.length === 0) {
    vscode.window.showWarningMessage(
      reasons
        ? vscode.l10n.t('Easy Console Log: no variable or expression to log ({0})', reasons)
        : vscode.l10n.t('Easy Console Log: no variable or expression to log')
    );
    return;
  }

  // Sort by final landing spot: 'after' inserts below the anchor line, 'before' above it;
  // at the same spot after(L) precedes before(L+1). After sorting, the i-th log has exactly i new lines before it.
  const slot = (t: Target) => (t.mode === 'before' ? t.anchorLine - 0.5 : t.anchorLine + 0.5);
  const isBefore = (t: Target) => Number(t.mode === 'before');
  const ordered = targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => slot(a.t) - slot(b.t) || isBefore(a.t) - isBefore(b.t) || a.i - b.i)
    .map(({ t }) => t);

  await editor.edit((builder) => {
    ordered.forEach((t, idx) => {
      const base = t.mode === 'before' ? t.anchorLine : t.anchorLine + 1;
      const stmt = buildLogStatement(t.expression, fileName, base + idx + 1, t.indent, cfg, {
        func: t.func,
        cls: t.cls,
      });
      if (t.mode === 'before') {
        builder.insert(new vscode.Position(t.anchorLine, 0), `${stmt}\n`);
      } else {
        builder.insert(doc.lineAt(t.anchorLine).range.end, `\n${stmt}`);
      }
    });
  });

  if (reasons) {
    vscode.window.showWarningMessage(vscode.l10n.t('Easy Console Log: some positions were skipped ({0})', reasons));
  }
}

let lastLevel: ConsoleLevel = 'log';

/** Pick a console level first, then insert; the last choice is listed first */
export async function insertLogWithLevel(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    return;
  }
  if (isPythonFile(doc.fileName)) {
    return insertLog();
  }
  const levels = [lastLevel, ...CONSOLE_LEVELS.filter((l) => l !== lastLevel)];
  const picked = await vscode.window.showQuickPick(
    levels.map((level) => ({ label: `console.${level}`, level })),
    { title: vscode.l10n.t('Select the console level to insert') }
  );
  if (picked) {
    lastLevel = picked.level;
    await insertLog({ level: picked.level });
  }
}

/** Refresh file names and line numbers in generated logs of the current file */
export async function updateLineNumbers(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const r = lineNumberEdits(docLines(doc), path.basename(doc.fileName), getConfig(doc));
  if (!r) {
    showMarkerWarning();
    return;
  }
  if (r.count === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('Easy Console Log: line numbers are already up to date'));
    return;
  }
  await editor.edit((builder) => applyLineEdits(builder, r.edits));
  vscode.window.showInformationMessage(vscode.l10n.t('Easy Console Log: updated {0} log(s)', r.count));
}

/** Auto-refresh line numbers on save (requires easyConsoleLog.updateLineNumbersOnSave) */
export function registerLineNumbersOnSave(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      const doc = e.document;
      const cfg = getConfig(doc);
      if (!cfg.updateLineNumbersOnSave || !(JS_LANGS.has(doc.languageId) || doc.languageId === 'python')) {
        return;
      }
      const r = lineNumberEdits(docLines(doc), path.basename(doc.fileName), cfg);
      if (r?.count) {
        e.waitUntil(Promise.resolve(toTextEdits(r.edits)));
      }
    })
  );
}

/** Run a batch operation on the logs generated by this extension in the current file */
async function runOnGenerated(mode: BatchMode): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const lines = docLines(editor.document);
  const blocks = scanGenerated(lines, editor.document.fileName, getConfig(editor.document));
  if (!blocks) {
    showMarkerWarning();
    return;
  }
  await applyBatchToEditor(editor, lines, blocks, mode);
}

/** Comment out all generated logs in the file */
export function commentAllLogs(): Promise<void> {
  return runOnGenerated('comment');
}

/** Uncomment all commented generated logs in the file */
export function uncommentAllLogs(): Promise<void> {
  return runOnGenerated('uncomment');
}

/** Delete all generated logs in the file (including commented ones) */
export function deleteAllLogs(): Promise<void> {
  return runOnGenerated('delete');
}

/** Toggle the comment of console calls under the cursor / covered by the selection;
 * supports multi-line calls and multi-cursor */
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
    vscode.window.showInformationMessage(vscode.l10n.t('Easy Console Log: the current line is not a console call'));
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
      vscode.l10n.t('Easy Console Log: {0} log(s) share a line with other code and cannot be commented out', skipped)
    );
  }
}

interface FileHits {
  uri: vscode.Uri;
  lines: string[];
  /** Blocks to process among all console.* calls */
  all: LogBlock[];
  /** Blocks to process among logs generated by this extension */
  generated: LogBlock[];
}

/** Where a multi-file batch operation runs */
type BatchScope = 'workspace' | 'changed';

/** Scan the workspace (or the given files) and return files with hits; undefined when the user cancels */
function scanHits(mode: BatchMode, scope: BatchScope, uris?: readonly vscode.Uri[]): Thenable<FileHits[] | undefined> {
  const pick = (uri: vscode.Uri, lines: string[]): FileHits | undefined => {
    const all = scanConsole(lines, uri.path).filter((b) => isApplicable(b, mode));
    // when generated logs can't be recognized (e.g. empty prefix) scanGenerated returns undefined
    // and the "generated logs only" option is not offered
    const generated = (scanGenerated(lines, uri.path, getConfig(uri)) ?? []).filter((b) => isApplicable(b, mode));
    return all.length || generated.length ? { uri, lines, all, generated } : undefined;
  };
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title:
        scope === 'workspace'
          ? vscode.l10n.t('Easy Console Log: scanning the workspace…')
          : vscode.l10n.t('Easy Console Log: scanning Git changed files…'),
      cancellable: true,
    },
    (progress, token) =>
      uris ? scanFiles(uris, pick, token, progress) : scanWorkspace(pick, token, progress)
  );
}

function noLogsMessage(scope: BatchScope, verb: string): string {
  return scope === 'workspace'
    ? vscode.l10n.t('Easy Console Log: no logs to {0} in the workspace', verb)
    : vscode.l10n.t('Easy Console Log: no logs to {0} in Git changed files', verb);
}

function chooseMessage(scope: BatchScope, verb: string): string {
  return scope === 'workspace'
    ? vscode.l10n.t('Easy Console Log: choose which logs to {0} in the workspace', verb)
    : vscode.l10n.t('Easy Console Log: choose which logs to {0} in Git changed files', verb);
}

/** Run a batch operation on a hits list, after letting the user pick the scope (generated only / all console.*) */
async function applyBatchHits(mode: BatchMode, hits: FileHits[], scope: BatchScope): Promise<void> {
  const verb = modeVerb(mode);
  // count only blocks that will actually be processed; unsafe ones are reported as skipped afterwards
  const sum = (pick: (h: FileHits) => LogBlock[]) => {
    let files = 0;
    let logs = 0;
    let skipped = 0;
    for (const h of hits) {
      const blocks = pick(h);
      const n = blocks.filter((b) => !isSkipped(b, mode)).length;
      files += n ? 1 : 0;
      logs += n;
      skipped += blocks.length - n;
    }
    return { files, logs, skipped };
  };
  const gen = sum((h) => h.generated);
  const all = sum((h) => h.all);
  if (gen.logs === 0 && all.logs === 0) {
    vscode.window.showInformationMessage(
      all.skipped ? batchResultMessage(mode, 0, all.skipped) : noLogsMessage(scope, verb)
    );
    return;
  }

  const GEN = vscode.l10n.t('Generated logs only ({0})', gen.logs);
  const ALL = vscode.l10n.t('All console.* ({0})', all.logs);
  const choice = await vscode.window.showWarningMessage(
    chooseMessage(scope, verb),
    {
      modal: true,
      detail: vscode.l10n.t(
        'Generated logs: {0} in {1} file(s)\nAll console.* calls: {2} in {3} file(s)',
        gen.logs,
        gen.files,
        all.logs,
        all.files
      ),
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
  if (total === 0) {
    vscode.window.showInformationMessage(batchResultMessage(mode, 0, skipped));
    return;
  }
  await vscode.workspace.applyEdit(edit);
  const SAVE = vscode.l10n.t('Save These Files');
  const result = batchResultMessage(mode, total, skipped);
  const action = await vscode.window.showInformationMessage(
    vscode.l10n.t('{0} in {1} file(s). Changes are not saved yet', result, touched.size),
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

/** Run a batch operation across the whole workspace */
async function batchOnWorkspace(mode: BatchMode): Promise<void> {
  const hits = await scanHits(mode, 'workspace');
  if (hits) {
    await applyBatchHits(mode, hits, 'workspace');
  }
}

/** Minimal structural typing of the vscode.git extension API (fields may be missing in older versions) */
interface GitApi {
  repositories: {
    state: {
      workingTreeChanges?: { uri: vscode.Uri }[];
      indexChanges?: { uri: vscode.Uri }[];
      mergeChanges?: { uri: vscode.Uri }[];
      untrackedChanges?: { uri: vscode.Uri }[];
    };
  }[];
}

interface GitExtension {
  enabled?: boolean;
  getAPI(version: 1): GitApi;
}

/** Get the vscode.git API, activating the extension if needed; undefined when Git is missing or disabled */
async function gitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    // getAPI throws when git.enabled is false
    return exports && exports.enabled !== false ? exports.getAPI(1) : undefined;
  } catch {
    return undefined;
  }
}

/** Collect scannable files with Git changes (working tree / index / merge / untracked) */
function changedUris(api: GitApi): vscode.Uri[] {
  const uris = new Map<string, vscode.Uri>();
  for (const { state } of api.repositories) {
    const changes = [
      ...(state.workingTreeChanges ?? []),
      ...(state.indexChanges ?? []),
      ...(state.mergeChanges ?? []),
      ...(state.untrackedChanges ?? []),
    ];
    for (const c of changes) {
      if (isScannable(c.uri)) {
        uris.set(c.uri.toString(), c.uri);
      }
    }
  }
  return [...uris.values()];
}

/** Run a batch operation only on Git-changed files (pre-commit debug-log cleanup) */
async function batchOnChanged(mode: BatchMode): Promise<void> {
  const api = await gitApi();
  if (!api) {
    vscode.window.showWarningMessage(vscode.l10n.t('Easy Console Log: Git extension is not available'));
    return;
  }
  if (!api.repositories.length) {
    vscode.window.showWarningMessage(vscode.l10n.t('Easy Console Log: no Git repository is open'));
    return;
  }
  const hits = await scanHits(mode, 'changed', changedUris(api));
  if (hits) {
    await applyBatchHits(mode, hits, 'changed');
  }
}

export function changedCommentAll(): Promise<void> {
  return batchOnChanged('comment');
}

export function changedUncommentAll(): Promise<void> {
  return batchOnChanged('uncomment');
}

export function changedDeleteAll(): Promise<void> {
  return batchOnChanged('delete');
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
