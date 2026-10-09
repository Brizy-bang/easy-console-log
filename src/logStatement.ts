import type { EclConfig } from './config';

export function isPythonFile(fileName: string): boolean {
  return /\.py$/i.test(fileName);
}

/** 转义字符串内容，使其可安全放入指定引号包裹的字面量中 */
export function escapeForQuote(text: string, quote: string): string {
  const escaped = text.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`);
  return quote === '`' ? escaped.replace(/\$\{/g, '\\${') : escaped;
}

/** Python 不支持反引号字符串，退回单引号 */
export function quoteFor(fileName: string, cfg: EclConfig): string {
  return isPythonFile(fileName) && cfg.quote === '`' ? "'" : cfg.quote;
}

/** 按文件名选择日志函数：Python 默认 print，其余用配置的 logFunction */
export function logFunctionForFile(fileName: string, cfg: EclConfig): string {
  if (isPythonFile(fileName) && cfg.logFunction === 'console.log') {
    return 'print';
  }
  return cfg.logFunction;
}

/** 渲染消息模板，支持 ${prefix} ${file} ${line} ${location} ${expr}，未知占位符原样保留 */
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (all, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : all
  );
}

/**
 * 生成日志消息开头的固定文本，用作识别"本扩展生成的日志"的标记。
 * 取模板中第一个非 ${prefix} 占位符之前的部分，例如默认模板得到 "🪵 ~ "。
 * 前缀为空（且模板开头用到前缀）或结果为空白时返回 undefined，
 * 此时无法可靠识别，避免误伤用户自己的日志。
 */
export function generatedMarker(cfg: EclConfig): string | undefined {
  const head = cfg.messageTemplate.split(/\$\{(?!prefix\})\w+\}/)[0];
  if (head.includes('${prefix}') && !cfg.prefix.trim()) {
    return undefined;
  }
  const marker = renderTemplate(head, { prefix: cfg.prefix });
  return marker.trim() ? marker : undefined;
}

/** 渲染日志消息（未转义），fileName 为不含目录的文件名 */
export function renderMessage(expression: string, fileName: string, lineNumber: number, cfg: EclConfig): string {
  const file = cfg.includeFilename ? fileName : '';
  const line = cfg.includeLineNumber ? String(lineNumber) : '';
  return renderTemplate(cfg.messageTemplate, {
    prefix: cfg.prefix,
    file,
    line,
    location: [file, line].filter(Boolean).join(':'),
    // 多行表达式在消息中折叠为单行，否则普通字符串字面量会断开
    expr: expression.replace(/\s+/g, ' ').trim(),
  });
}

/**
 * 构建一条日志语句，例如：
 *   console.log('🪵 ~ app.ts:42 ~ userName:', userName);
 */
export function buildLogStatement(
  expression: string,
  fileName: string,
  lineNumber: number,
  indent: string,
  cfg: EclConfig
): string {
  const message = renderMessage(expression, fileName, lineNumber, cfg);
  const quote = quoteFor(fileName, cfg);
  const semi = cfg.semicolon && !isPythonFile(fileName) ? ';' : '';
  const fn = logFunctionForFile(fileName, cfg);
  return `${indent}${fn}(${quote}${escapeForQuote(message, quote)}${quote}, ${expression})${semi}`;
}
