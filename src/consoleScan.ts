/**
 * Plain-text scanning and edit computation (no vscode dependency, so it is unit-testable).
 * Calls such as console.* / print are recognized as "call blocks", supporting calls that
 * span multiple lines and multi-line commented blocks.
 */
import type { EclConfig } from './config';
import { generatedMarker, isPythonFile, logFunctionForFile, quoteFor, escapeForQuote } from './logStatement';

export type BatchMode = 'comment' | 'uncomment' | 'delete';

/** A single call block (may span multiple lines) */
export interface LogBlock {
  /** Start line (0-based) */
  line: number;
  /** End line (0-based) */
  endLine: number;
  /** Column on endLine where the call (including the semicolon) ends, exclusive */
  endChar: number;
  /** Column on the start line where the callee name begins (e.g. the c of console) */
  callStart: number;
  /** Other code precedes the call on the same line (e.g. `if (x) console.log(y)`):
   * only the call itself may be deleted; whole-line commenting is unsafe */
  inline: boolean;
  /** Full call text (comment tokens stripped, newlines folded into spaces), for display and matching */
  body: string;
  /** Whether the call is commented out */
  commented: boolean;
  /** log / debug / info / warn / error, or a custom log function name */
  level: string;
  /** Indent length of the start line */
  indentLen: number;
  /** Length of the comment token (plus following whitespace) on the start line; 0 when uncommented */
  commentLen: number;
  /** Other code follows the call on its end line (line-level comment/delete needs special handling) */
  trailing: boolean;
  /** The call sits at statement boundaries on both sides, so removing it cannot break the surrounding code
   * (e.g. false for `if (x) console.log(y)`, `x => console.log(x)`, `a && console.log(b)`) */
  deletable: boolean;
}

/** Line-level edit, independent of vscode */
export type LineEdit =
  | { kind: 'insert'; line: number; char: number; text: string }
  | { kind: 'delete'; line: number; char: number; endLine: number; endChar: number }
  | { kind: 'replace'; line: number; char: number; endLine: number; endChar: number; text: string };

interface ScanOptions {
  /** Callee-name regex fragments (must only use non-capturing groups internally) */
  names: string[];
  /** Line comment token */
  commentToken: string;
  /** JS-family syntax (backtick strings, block comments, semicolons) */
  jsLike: boolean;
}

/** Maximum number of lines a single call block may span; beyond that it is considered unclosed */
const MAX_SPAN = 500;

/** Supported console levels (all accept "message + value" arguments), selectable on insert */
export const CONSOLE_LEVELS = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const;

/** Extra console methods recognized for scanning/cleanup but not offered as insert levels */
export const CONSOLE_EXTRA = [
  'table',
  'dir',
  'count',
  'countReset',
  'group',
  'groupCollapsed',
  'groupEnd',
  'time',
  'timeLog',
  'timeEnd',
  'assert',
] as const;

/** All scannable console methods */
export const CONSOLE_SCAN_METHODS = [...CONSOLE_LEVELS, ...CONSOLE_EXTRA];

export const CONSOLE_NAMES = [`console\\.(?:${CONSOLE_SCAN_METHODS.join('|')})`];

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function commentTokenFor(fileName: string): string {
  return isPythonFile(fileName) ? '#' : '//';
}

/** Split text into lines (consistent with VS Code line numbers) */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function leadingWs(text: string): number {
  return text.length - text.trimStart().length;
}

/** Keywords after which a '/' starts a regex rather than a division */
const REGEX_KEYWORDS = new Set(
  'return typeof case throw do else yield await new in of delete void'.split(' ')
);

/**
 * If the '/' at index k opens a regex literal, return the index just past it (flags included);
 * -1 otherwise. A '/' is a regex when the last significant char is an operator or a keyword —
 * not an identifier, number, ')' or ']'.
 */
function skipRegex(text: string, k: number): number {
  if (text[k + 1] === '/' || text[k + 1] === '*') {
    return -1;
  }
  let p = k - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) {
    p--;
  }
  if (p >= 0) {
    const c = text[p];
    const isOp = '=([{,;:!&|?+-*%^~<>'.includes(c);
    const isKw = /[\w$]/.test(c) && REGEX_KEYWORDS.has(text.slice(0, p + 1).match(/[\w$]+$/)?.[0] ?? '');
    if (!isOp && !isKw) {
      return -1;
    }
  }
  let inClass = false;
  for (let j = k + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
    } else if (c === '[') {
      inClass = true;
    } else if (c === ']') {
      inClass = false;
    } else if (c === '/' && !inClass) {
      while (j + 1 < text.length && /[a-z]/i.test(text[j + 1])) {
        j++;
      }
      return j;
    }
  }
  return -1;
}

/** Match parens starting at (startLine, startCol), right after the opening paren; return the closing paren position */
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
      // in a commented call block, continuation lines must be comment lines too
      const c = commented ? contRe.exec(text) : null;
      if (commented && !c) {
        return undefined;
      }
      k = c ? c[0].length : 0;
    }
    for (; k < text.length; k++) {
      const ch = text[k];
      // skip a regex literal entirely (parens inside it must not affect depth)
      if (opts.jsLike && ch === '/' && !blockComment && !quote) {
        const re = skipRegex(text, k);
        if (re >= 0) {
          k = re;
          continue;
        }
      }
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
    // plain strings cannot span lines; only template literals can
    if (quote !== '`') {
      quote = undefined;
    }
  }
  return undefined;
}

/**
 * Whether the text before a call allows it to count as an inline call.
 * Tracks quote state char by char: a call after a line comment, inside an unclosed
 * string, or right after an identifier / member-access character does not count.
 */
function inlineAllowed(text: string, idx: number, opts: ScanOptions): boolean {
  const prev = text[idx - 1];
  if (prev !== undefined && /[\w$.]/.test(prev)) {
    return false;
  }
  let quote: string | undefined;
  for (let j = 0; j < idx; j++) {
    const ch = text[j];
    if (quote) {
      if (ch === '\\') {
        j++;
      } else if (ch === quote) {
        quote = undefined;
      }
    } else if (ch === '"' || ch === "'" || (opts.jsLike && ch === '`')) {
      quote = ch;
    } else if (text.startsWith(opts.commentToken, j)) {
      return false;
    } else if (opts.jsLike && ch === '/' && text[j + 1] === '*') {
      return false;
    } else if (opts.jsLike && ch === '/') {
      const re = skipRegex(text, j);
      if (re >= 0) {
        j = re;
      }
    }
  }
  return quote === undefined;
}

/**
 * Scan call blocks line by line. A line may contain several calls (from the second
 * one on they are inline calls); after a multi-line block ends, the rest of its end
 * line keeps being scanned.
 */
function scanBlocks(lines: readonly string[], opts: ScanOptions): LogBlock[] {
  const tok = escapeRegExp(opts.commentToken);
  const headRe = new RegExp(`^(\\s*)(${tok}\\s*)?(${opts.names.join('|')})\\s*\\(`);
  const inlineRe = new RegExp(`(${opts.names.join('|')})\\s*\\(`, 'g');
  const contRe = new RegExp(`^(\\s*)${tok} ?`);
  const blocks: LogBlock[] = [];
  /** After a multi-line block ends, the column its end line must be rescanned from */
  const resume = new Map<number, number>();

  let i = 0;
  while (i < lines.length) {
    const text = lines[i];
    const from = resume.get(i) ?? 0;
    resume.delete(i);

    let callStart = -1;
    let argsStart = -1;
    let levelText = '';
    let indentLen = 0;
    let commentLen = 0;
    let commented = false;

    const m = from === 0 ? headRe.exec(text) : null;
    if (m) {
      indentLen = m[1].length;
      commentLen = m[2]?.length ?? 0;
      commented = m[2] !== undefined;
      callStart = indentLen + commentLen;
      argsStart = m[0].length;
      levelText = m[3];
    } else {
      inlineRe.lastIndex = from;
      let hit: RegExpExecArray | null;
      while ((hit = inlineRe.exec(text))) {
        if (inlineAllowed(text, hit.index, opts)) {
          callStart = hit.index;
          argsStart = hit.index + hit[0].length;
          levelText = hit[1];
          break;
        }
      }
    }

    if (callStart < 0) {
      i++;
      continue;
    }

    const end = findCallEnd(lines, i, argsStart, commented, contRe, opts);

    const inline = callStart !== indentLen + commentLen || from > 0;
    let endLine = i;
    let endChar = text.length;
    let trailing = false;
    // an unclosed inline call cannot be cut out safely; an unclosed line-start call is deleted as a whole line
    let afterOk = !inline;
    if (end) {
      endLine = end.endLine;
      endChar = end.endChar;
      const endText = lines[endLine];
      let p = endChar;
      while (endText[p] === ' ' || endText[p] === '\t') {
        p++;
      }
      const semi = opts.jsLike && endText[p] === ';';
      if (semi) {
        endChar = p + 1;
      }
      const rest = endText.slice(endChar).trim();
      trailing = !commented && rest !== '' && !rest.startsWith(opts.commentToken);
      afterOk = commented || semi || !trailing || (opts.jsLike && rest.startsWith('}'));
    }
    const before = text.slice(0, callStart).trimEnd();
    const beforeOk = !inline || before === '' || (opts.jsLike ? /[;{}]$/ : /;$/).test(before);

    const parts: string[] = [];
    for (let k = i; k <= endLine; k++) {
      let t = lines[k];
      if (k === endLine) {
        t = t.slice(0, endChar);
      }
      if (k === i) {
        t = t.slice(callStart);
      } else if (commented) {
        t = t.replace(contRe, '');
      }
      parts.push(t.trim());
    }

    blocks.push({
      line: i,
      endLine,
      endChar,
      callStart,
      inline,
      body: parts.filter(Boolean).join(' '),
      commented,
      level: levelText.replace(/^console\./, ''),
      indentLen,
      commentLen,
      trailing,
      deletable: beforeOk && afterOk,
    });
    // the end line may contain more calls — record the rescan column; same-line calls resume scanning the remainder
    resume.set(endLine, endChar);
    i = endLine;
  }
  return blocks;
}

/** Scan all console.* calls (Python files scan print) */
export function scanConsole(lines: readonly string[], fileName: string): LogBlock[] {
  const py = isPythonFile(fileName);
  return scanBlocks(lines, {
    names: py ? ['print'] : CONSOLE_NAMES,
    commentToken: commentTokenFor(fileName),
    jsLike: !py,
  });
}

/** Whether a block was generated by this extension (first argument is a string starting with the marker;
 * Python string prefixes like f'...' / r'...' are accepted) */
export function isGenerated(block: LogBlock, marker: string): boolean {
  const rest = block.body.slice(block.body.indexOf('(') + 1).trimStart();
  const m = /^[fFrRbB]{0,2}(['"`])/.exec(rest);
  return !!m && rest.slice(m[0].length).startsWith(marker);
}

/**
 * Scan logs generated by this extension.
 * Returns undefined when they cannot be recognized reliably under the current config
 * (e.g. empty prefix); callers should refuse batch operations to avoid collateral damage.
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

/** Whether a block needs processing under the given mode */
export function isApplicable(block: LogBlock, mode: BatchMode): boolean {
  return mode === 'comment' ? !block.commented : mode === 'uncomment' ? block.commented : true;
}

/** Whether an applicable block must be skipped because the edit would break the surrounding code */
export function isSkipped(block: LogBlock, mode: BatchMode): boolean {
  return mode === 'comment' ? block.trailing || block.inline : mode === 'delete' ? !block.deletable : false;
}

/** Compute comment/uncomment edits for one block */
function toggleEdits(lines: readonly string[], b: LogBlock, mode: 'comment' | 'uncomment', token: string): LineEdit[] {
  const edits: LineEdit[] = [];
  if (mode === 'comment') {
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

/** Delete the whole-line range [from, to], handling a last line without a trailing newline */
function deleteLines(lines: readonly string[], from: number, to: number): LineEdit {
  const last = lines.length - 1;
  if (to < last) {
    return { kind: 'delete', line: from, char: 0, endLine: to + 1, endChar: 0 };
  }
  if (from > 0) {
    // also consume the previous line's newline so no empty line is left behind
    return { kind: 'delete', line: from - 1, char: lines[from - 1].length, endLine: to, endChar: lines[to].length };
  }
  return { kind: 'delete', line: from, char: 0, endLine: to, endChar: lines[to].length };
}

/**
 * Compute edits for a set of blocks.
 * - comment: blocks sharing a line with other code are skipped (counted in skipped)
 * - delete: when other code shares the line only the call is removed (skipped unless it sits at statement
 *   boundaries); otherwise whole lines are deleted and adjacent line ranges are merged to avoid overlapping edits
 */
export function batchEdits(
  lines: readonly string[],
  blocks: readonly LogBlock[],
  mode: BatchMode,
  token: string
): { edits: LineEdit[]; count: number; skipped: number } {
  const applicable = blocks.filter((b) => isApplicable(b, mode));
  const targets = applicable.filter((b) => !isSkipped(b, mode));
  const skipped = applicable.length - targets.length;
  const edits: LineEdit[] = [];

  if (mode !== 'delete') {
    for (const b of targets) {
      edits.push(...toggleEdits(lines, b, mode, token));
    }
    return { edits, count: targets.length, skipped };
  }

  const ranges: [number, number][] = [];
  for (const b of [...targets].sort((a, c) => a.line - c.line)) {
    if (b.inline || b.trailing) {
      // inline or followed by other code: delete only the call (plus adjacent whitespace), keep the rest
      const text = lines[b.endLine];
      let e = b.endChar;
      while (text[e] === ' ' || text[e] === '\t') {
        e++;
      }
      const s = b.inline ? b.callStart : b.indentLen;
      edits.push({ kind: 'delete', line: b.line, char: s, endLine: b.endLine, endChar: e });
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

/** Find the block containing the given line */
export function blockAtLine(blocks: readonly LogBlock[], line: number): LogBlock | undefined {
  return blocks.find((b) => b.line <= line && line <= b.endLine);
}
