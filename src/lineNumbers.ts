/**
 * 刷新生成日志消息中的文件名与行号（纯函数，不依赖 vscode）。
 * 代码增删后日志里的 `file:line` 会过时，这里按当前模板重新渲染，保留原有的 ${expr} 文本。
 */
import type { EclConfig } from './config';
import { escapeRegExp, LineEdit, LogBlock, scanGenerated } from './consoleScan';
import { escapeForQuote, generatedMarker, renderMessage } from './logStatement';

const QUOTES = ["'", '"', '`'];
/** 渲染时代替表达式的占位符，不会被转义也不会出现在正常代码里 */
const EXPR_SENTINEL = '\u0000';

/** 由模板构建匹配既有消息内容（源码中的转义形式）的正则，第 1 个捕获组为 ${expr} */
function messageRegExp(cfg: EclConfig, quote: string): RegExp {
  let exprSeen = false;
  const source = cfg.messageTemplate
    .split(/(\$\{\w+\})/)
    .map((part) => {
      const key = /^\$\{(\w+)\}$/.exec(part)?.[1];
      switch (key) {
        case undefined:
          return escapeRegExp(escapeForQuote(part, quote));
        case 'prefix':
          return escapeRegExp(escapeForQuote(cfg.prefix, quote));
        case 'expr':
          if (exprSeen) {
            return '.*?';
          }
          exprSeen = true;
          return '(.*?)';
        case 'line':
          return '\\d*';
        case 'file':
        case 'location':
          // 文件可能被重命名、配置可能被修改，因此不限定具体内容
          return '.*?';
        default:
          return escapeRegExp(part);
      }
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** 在块中找到以 marker 开头的消息字符串，返回其内容范围 */
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
 * 计算刷新行号所需的编辑。fileName 为不含目录的文件名。
 * 返回 undefined 表示当前配置下无法识别生成的日志。
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
    const m = regexps.get(lit.quote)?.exec(content);
    if (!m) {
      continue;
    }
    const rendered = escapeForQuote(renderMessage(EXPR_SENTINEL, fileName, b.line + 1, cfg), lit.quote);
    // 原表达式文本已是转义后的形式，直接放回
    const next = rendered.replace(EXPR_SENTINEL, () => m[1] ?? '');
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
