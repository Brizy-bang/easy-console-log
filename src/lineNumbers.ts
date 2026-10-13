/**
 * Refresh the file name and line number inside generated log messages (pure, vscode-free).
 * After code edits the `file:line` part goes stale; this re-renders it with the current
 * template while keeping the original ${expr} text.
 */
import type { EclConfig } from './config';
import { escapeRegExp, LineEdit, LogBlock, scanGenerated } from './consoleScan';
import { escapeForQuote, generatedMarker, renderMessage } from './logStatement';

const QUOTES = ["'", '"', '`'];
/** Sentinels standing in for variable text during rendering; never escaped and absent from real code */
const SENTINELS: Record<string, string> = { expr: '\u0000', func: '\u0001', cls: '\u0002' };

/** Template placeholders whose original text must be preserved (cannot be recomputed without AST) */
const KEPT_KEYS = new Set(Object.keys(SENTINELS));

/** Build a RegExp matching existing message content (its escaped source form);
 * keys = capture-group placeholder order */
function messageRegExp(cfg: EclConfig, quote: string): { re: RegExp; keys: string[] } {
  const seen = new Set<string>();
  const keys: string[] = [];
  const source = cfg.messageTemplate
    .split(/(\$\{\w+\})/)
    .map((part) => {
      const key = /^\$\{(\w+)\}$/.exec(part)?.[1];
      switch (key) {
        case undefined:
          return escapeRegExp(escapeForQuote(part, quote));
        case 'prefix':
          return escapeRegExp(escapeForQuote(cfg.prefix, quote));
        case 'line':
          return '\\d*';
        case 'file':
        case 'location':
          // the file may have been renamed and the config changed, so don't constrain the content
          return '.*?';
        default:
          if (KEPT_KEYS.has(key)) {
            if (seen.has(key)) {
              return '.*?';
            }
            seen.add(key);
            keys.push(key);
            return '(.*?)';
          }
          return escapeRegExp(part);
      }
    })
    .join('');
  return { re: new RegExp(`^${source}$`), keys };
}

/** Find the message string starting with the marker inside a block; return its content range */
function findMessageLiteral(
  lines: readonly string[],
  block: LogBlock,
  marker: string
): { line: number; start: number; end: number; quote: string } | undefined {
  for (let k = block.line; k <= block.endLine; k++) {
    const text = lines[k];
    const from = k === block.line ? block.indentLen + block.commentLen : 0;
    let best: { start: number; quote: string } | undefined;
    for (const quote of QUOTES) {
      const idx = text.indexOf(quote + escapeForQuote(marker, quote), from);
      if (idx >= 0 && (!best || idx < best.start)) {
        best = { start: idx + 1, quote };
      }
    }
    if (!best) {
      continue;
    }
    for (let i = best.start; i < text.length; i++) {
      if (text[i] === '\\') {
        i++;
      } else if (text[i] === best.quote) {
        return { line: k, start: best.start, end: i, quote: best.quote };
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * Compute the edits needed to refresh line numbers. fileName is the base name.
 * Returns undefined when generated logs cannot be recognized under the current config.
 */
export function lineNumberEdits(
  lines: readonly string[],
  fileName: string,
  cfg: EclConfig
): { edits: LineEdit[]; count: number } | undefined {
  const marker = generatedMarker(cfg);
  const blocks = scanGenerated(lines, fileName, cfg);
  if (!marker || !blocks) {
    return undefined;
  }
  const regexps = new Map(QUOTES.map((q) => [q, messageRegExp(cfg, q)]));
  const edits: LineEdit[] = [];
  for (const b of blocks) {
    const lit = findMessageLiteral(lines, b, marker);
    if (!lit) {
      continue;
    }
    const content = lines[lit.line].slice(lit.start, lit.end);
    const mr = regexps.get(lit.quote);
    const m = mr?.re.exec(content);
    if (!m || !mr) {
      continue;
    }
    // the original expression / function / class text is already escaped; put it back verbatim
    const kept: Record<string, string> = {};
    mr.keys.forEach((key, idx) => {
      kept[key] = m[idx + 1] ?? '';
    });
    const rendered = escapeForQuote(
      renderMessage(SENTINELS.expr, fileName, b.line + 1, cfg, {
        func: SENTINELS.func,
        cls: SENTINELS.cls,
      }),
      lit.quote
    );
    let next = rendered;
    for (const [key, sentinel] of Object.entries(SENTINELS)) {
      next = next.replace(sentinel, () => kept[key] ?? '');
    }
    if (next !== content) {
      edits.push({
        kind: 'replace',
        line: lit.line,
        char: lit.start,
        endLine: lit.line,
        endChar: lit.end,
        text: next,
      });
    }
  }
  return { edits, count: edits.length };
}
