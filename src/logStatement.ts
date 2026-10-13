import type { EclConfig } from './config';

export function isPythonFile(fileName: string): boolean {
  return /\.py$/i.test(fileName);
}

/** Escape text so it is safe inside a string literal wrapped with the given quote */
export function escapeForQuote(text: string, quote: string): string {
  const escaped = text.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`);
  return quote === '`' ? escaped.replace(/\$\{/g, '\\${') : escaped;
}

/** Python has no template literals; fall back to single quotes */
export function quoteFor(fileName: string, cfg: EclConfig): string {
  return isPythonFile(fileName) && cfg.quote === '`' ? "'" : cfg.quote;
}

/** Pick the log function by file name: Python defaults to print, others use the configured logFunction */
export function logFunctionForFile(fileName: string, cfg: EclConfig): string {
  if (isPythonFile(fileName) && cfg.logFunction === 'console.log') {
    return 'print';
  }
  return cfg.logFunction;
}

/** Render the message template; supports ${prefix} ${file} ${line} ${location} ${func} ${cls} ${expr};
 * unknown placeholders are kept as-is */
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (all, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : all
  );
}

/**
 * Fixed text at the start of a generated log message, used as the marker that
 * identifies logs produced by this extension. It is the part of the template
 * before the first placeholder other than ${prefix}, e.g. "🪵 ~ " by default.
 * Returns undefined when the prefix is empty (and the template head uses it) or
 * the result is blank — in that case generated logs cannot be recognized
 * reliably and batch operations are refused to protect hand-written logs.
 */
export function generatedMarker(cfg: EclConfig): string | undefined {
  const head = cfg.messageTemplate.split(/\$\{(?!prefix\})\w+\}/)[0];
  if (head.includes('${prefix}') && !cfg.prefix.trim()) {
    return undefined;
  }
  const marker = renderTemplate(head, { prefix: cfg.prefix });
  return marker.trim() ? marker : undefined;
}

/** Extra context available while rendering (enclosing function / class name) */
export interface LogContext {
  func?: string;
  cls?: string;
}

/** Render the log message (unescaped); fileName is the base name without directory */
export function renderMessage(
  expression: string,
  fileName: string,
  lineNumber: number,
  cfg: EclConfig,
  ctx: LogContext = {}
): string {
  const file = cfg.includeFilename ? fileName : '';
  const line = cfg.includeLineNumber ? String(lineNumber) : '';
  return renderTemplate(cfg.messageTemplate, {
    prefix: cfg.prefix,
    file,
    line,
    location: [file, line].filter(Boolean).join(':'),
    func: ctx.func ?? '',
    cls: ctx.cls ?? '',
    // multi-line expressions are collapsed to one line, otherwise a plain string literal would break
    expr: expression.replace(/\s+/g, ' ').trim(),
  });
}

/**
 * Build a log statement, e.g.:
 *   console.log('🪵 ~ app.ts:42 ~ userName:', userName);
 */
export function buildLogStatement(
  expression: string,
  fileName: string,
  lineNumber: number,
  indent: string,
  cfg: EclConfig,
  ctx: LogContext = {}
): string {
  const message = renderMessage(expression, fileName, lineNumber, cfg, ctx);
  const quote = quoteFor(fileName, cfg);
  const semi = cfg.semicolon && !isPythonFile(fileName) ? ';' : '';
  const fn = logFunctionForFile(fileName, cfg);
  return `${indent}${fn}(${quote}${escapeForQuote(message, quote)}${quote}, ${expression})${semi}`;
}
