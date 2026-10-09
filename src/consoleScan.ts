/**
 * 纯文本扫描与编辑计算（不依赖 vscode，便于单测）。
 * 以"调用块"为单位识别 console.* / print 等调用，支持跨多行的调用与多行注释块。
 */
import type { EclConfig } from './config';
import { generatedMarker, isPythonFile, logFunctionForFile, quoteFor, escapeForQuote } from './logStatement';

export type BatchMode = 'comment' | 'uncomment' | 'delete';

/** 单个调用块（可能跨多行） */
export interface LogBlock {
  /** 起始行（0-based） */
  line: number;
  /** 结束行（0-based） */
  endLine: number;
  /** 调用（含分号）在 endLine 上的结束列（不含） */
  endChar: number;
  /** 调用全文（去掉注释符并把换行折叠为空格），用于展示和识别 */
  body: string;
  /** 是否已被注释 */
  commented: boolean;
  /** log / debug / info / warn / error，或自定义日志函数名 */
  level: string;
  /** 起始行缩进长度 */
  indentLen: number;
  /** 起始行注释符（含其后空白）的长度，未注释为 0 */
  commentLen: number;
  /** 结束行在调用之后还有其他代码（按行注释/删除会误伤，需要特殊处理） */
  trailing: boolean;
}

/** 与 vscode 无关的行级编辑 */
export type LineEdit =
  | { kind: 'insert'; line: number; char: number; text: string }
  | { kind: 'delete'; line: number; char: number; endLine: number; endChar: number }
  | { kind: 'replace'; line: number; char: number; endLine: number; endChar: number; text: string };

interface ScanOptions {
  /** 调用名正则片段（内部只能使用非捕获组） */
  names: string[];
  /** 行注释符 */
  commentToken: string;
  /** 是否为 JS 系语法（反引号字符串、块注释、分号） */
  jsLike: boolean;
}

/** 单个调用块最多跨越的行数，超过视为无法闭合 */
const MAX_SPAN = 500;

/** 支持的 console 级别（均可接收"消息 + 值"形式的参数） */
export const CONSOLE_LEVELS = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const;

export const CONSOLE_NAMES = [`console\\.(?:${CONSOLE_LEVELS.join('|')})`];

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function commentTokenFor(fileName: string): string {
  return isPythonFile(fileName) ? '#' : '//';
}

/** 将文本拆分为行（与 VSCode 的行号一致） */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function leadingWs(text: string): number {
  return text.length - text.trimStart().length;
}

/** 从 (startLine, startCol)（左括号之后）开始做括号配对，返回右括号位置 */
function findCallEnd(
  lines: readonly string[],
  startLine: number,
  startCol: number,
  commented: boolean,
  contRe: RegExp,
  opts: ScanOptions
): { endLine: number; endChar: number } | undefined {
  let depth = 1;
  let quote: string | undefined;
  let blockComment = false;
  const last = Math.min(lines.length, startLine + MAX_SPAN);
  for (let j = startLine; j < last; j++) {
    const text = lines[j];
    let k = startCol;
    if (j > startLine) {
      // 被注释的调用块，后续行也必须是注释行
      const c = commented ? contRe.exec(text) : null;
      if (commented && !c) {
        return undefined;
      }
      k = c ? c[0].length : 0;
    }
    for (; k < text.length; k++) {
      const ch = text[k];
      if (blockComment) {
        if (ch === '*' && text[k + 1] === '/') {
          blockComment = false;
          k++;
        }
      } else if (quote) {
        if (ch === '\\') {
          k++;
        } else if (ch === quote) {
          quote = undefined;
        }
      } else if (ch === '"' || ch === "'" || (opts.jsLike && ch === '`')) {
        quote = ch;
      } else if (text.startsWith(opts.commentToken, k)) {
        break;
      } else if (opts.jsLike && ch === '/' && text[k + 1] === '*') {
        blockComment = true;
        k++;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        if (--depth === 0) {
          return { endLine: j, endChar: k + 1 };
        }
      }
    }
    // 普通字符串不会跨行，只有模板字符串会
    if (quote !== '`') {
      quote = undefined;
    }
  }
  return undefined;
}

function scanBlocks(lines: readonly string[], opts: ScanOptions): LogBlock[] {
  const tok = escapeRegExp(opts.commentToken);
  const headRe = new RegExp(`^(\\s*)(${tok}\\s*)?(${opts.names.join('|')})\\s*\\(`);
  const contRe = new RegExp(`^(\\s*)${tok} ?`);
  const blocks: LogBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const m = headRe.exec(text);
    if (!m) {
      continue;
    }
    const indentLen = m[1].length;
    const commentLen = m[2]?.length ?? 0;
    const commented = m[2] !== undefined;
    const end = findCallEnd(lines, i, m[0].length, commented, contRe, opts);

    let endLine = i;
    let endChar = text.length;
    let trailing = false;
    if (end) {
      endLine = end.endLine;
      endChar = end.endChar;
      const endText = lines[endLine];
      let p = endChar;
      while (endText[p] === ' ' || endText[p] === '\t') {
        p++;
      }
      if (opts.jsLike && endText[p] === ';') {
        endChar = p + 1;
      }
      const rest = endText.slice(endChar).trim();
      trailing = !commented && rest !== '' && !rest.startsWith(opts.commentToken);
    }

    const parts: string[] = [];
    for (let k = i; k <= endLine; k++) {
      let t = lines[k];
      if (k === endLine) {
        t = t.slice(0, endChar);
      }
      if (k === i) {
        t = t.slice(indentLen + commentLen);
      } else if (commented) {
        t = t.replace(contRe, '');
      }
      parts.push(t.trim());
    }

    blocks.push({
      line: i,
      endLine,
      endChar,
      body: parts.filter(Boolean).join(' '),
      commented,
      level: m[3].replace(/^console\./, ''),
      indentLen,
      commentLen,
      trailing,
    });
    i = endLine;
  }
  return blocks;
}

/** 扫描所有 console.* 调用（Python 文件扫描 print） */
export function scanConsole(lines: readonly string[], fileName: string): LogBlock[] {
  const py = isPythonFile(fileName);
  return scanBlocks(lines, {
    names: py ? ['print'] : CONSOLE_NAMES,
    commentToken: commentTokenFor(fileName),
    jsLike: !py,
  });
}

/** 判断调用块是否为本扩展生成（首个实参是以 marker 开头的字符串） */
export function isGenerated(block: LogBlock, marker: string): boolean {
  const rest = block.body.slice(block.body.indexOf('(') + 1).trimStart();
  return /^['"`]/.test(rest) && rest.slice(1).startsWith(marker);
}

/**
 * 扫描本扩展生成的日志。
 * 返回 undefined 表示当前配置下无法可靠识别（如前缀为空），调用方应拒绝批量操作以免误伤。
 */
export function scanGenerated(
  lines: readonly string[],
  fileName: string,
  cfg: EclConfig
): LogBlock[] | undefined {
  const marker = generatedMarker(cfg);
  if (!marker) {
    return undefined;
  }
  const py = isPythonFile(fileName);
  const fn = escapeRegExp(logFunctionForFile(fileName, cfg));
  const names = py ? ['print', fn] : [...CONSOLE_NAMES, fn];
  const escaped = escapeForQuote(marker, quoteFor(fileName, cfg));
  return scanBlocks(lines, { names, commentToken: commentTokenFor(fileName), jsLike: !py }).filter(
    (b) => isGenerated(b, escaped)
  );
}

/** 某个块在给定模式下是否需要处理 */
export function isApplicable(block: LogBlock, mode: BatchMode): boolean {
  return mode === 'comment' ? !block.commented : mode === 'uncomment' ? block.commented : true;
}

/** 计算单个块的注释/取消注释编辑；与其他代码同行而无法安全处理时返回 undefined */
function toggleEdits(
  lines: readonly string[],
  b: LogBlock,
  mode: 'comment' | 'uncomment',
  token: string
): LineEdit[] | undefined {
  const edits: LineEdit[] = [];
  if (mode === 'comment') {
    if (b.trailing) {
      return undefined;
    }
    for (let k = b.line; k <= b.endLine; k++) {
      const char = k === b.line ? b.indentLen : Math.min(b.indentLen, leadingWs(lines[k]));
      edits.push({ kind: 'insert', line: k, char, text: `${token} ` });
    }
    return edits;
  }
  edits.push({
    kind: 'delete',
    line: b.line,
    char: b.indentLen,
    endLine: b.line,
    endChar: b.indentLen + b.commentLen,
  });
  const contRe = new RegExp(`^(\\s*)${escapeRegExp(token)} ?`);
  for (let k = b.line + 1; k <= b.endLine; k++) {
    const c = contRe.exec(lines[k]);
    if (c) {
      edits.push({ kind: 'delete', line: k, char: c[1].length, endLine: k, endChar: c[0].length });
    }
  }
  return edits;
}

/** 删除整行区间 [from, to]，处理最后一行无换行符的情况 */
function deleteLines(lines: readonly string[], from: number, to: number): LineEdit {
  const last = lines.length - 1;
  if (to < last) {
    return { kind: 'delete', line: from, char: 0, endLine: to + 1, endChar: 0 };
  }
  if (from > 0) {
    // 连同前一行的换行一起删掉，避免残留空行
    return { kind: 'delete', line: from - 1, char: lines[from - 1].length, endLine: to, endChar: lines[to].length };
  }
  return { kind: 'delete', line: from, char: 0, endLine: to, endChar: lines[to].length };
}

/**
 * 计算一批块的编辑。
 * - comment：与其他代码同行的块会被跳过（计入 skipped）
 * - delete：同行有其他代码时只删调用本身，否则整行删除，相邻整行区间会合并避免范围重叠
 */
export function batchEdits(
  lines: readonly string[],
  blocks: readonly LogBlock[],
  mode: BatchMode,
  token: string
): { edits: LineEdit[]; count: number; skipped: number } {
  const targets = blocks.filter((b) => isApplicable(b, mode));
  const edits: LineEdit[] = [];
  let skipped = 0;

  if (mode !== 'delete') {
    for (const b of targets) {
      const e = toggleEdits(lines, b, mode, token);
      if (e) {
        edits.push(...e);
      } else {
        skipped++;
      }
    }
    return { edits, count: targets.length - skipped, skipped };
  }

  const ranges: [number, number][] = [];
  for (const b of [...targets].sort((a, c) => a.line - c.line)) {
    if (b.trailing) {
      const text = lines[b.endLine];
      let e = b.endChar;
      while (text[e] === ' ' || text[e] === '\t') {
        e++;
      }
      edits.push({ kind: 'delete', line: b.line, char: b.indentLen, endLine: b.endLine, endChar: e });
      continue;
    }
    const prev = ranges[ranges.length - 1];
    if (prev && prev[1] + 1 === b.line) {
      prev[1] = b.endLine;
    } else {
      ranges.push([b.line, b.endLine]);
    }
  }
  for (const [from, to] of ranges) {
    edits.push(deleteLines(lines, from, to));
  }
  return { edits, count: targets.length, skipped };
}

/** 找到包含指定行的块 */
export function blockAtLine(blocks: readonly LogBlock[], line: number): LogBlock | undefined {
  return blocks.find((b) => b.line <= line && line <= b.endLine);
}
