import { EclConfig } from './config';

/** 转义正则特殊字符 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 转义日志消息字符串中会与引号冲突的字符 */
function escapeForQuote(text: string, quote: string): string {
  if (quote === '`') {
    return text.replace(/`/g, '\\`').replace(/\$/g, '\\$');
  }
  return text.replace(/\\/g, '\\\\').replace(new RegExp(escapeRegExp(quote), 'g'), `\\${quote}`);
}

/** 按文件名选择日志函数：Python 默认 print，其余用配置的 logFunction */
export function logFunctionForFile(fileName: string, cfg: EclConfig): string {
  if (/\.py$/i.test(fileName) && cfg.logFunction === 'console.log') {
    return 'print';
  }
  return cfg.logFunction;
}

/** 渲染消息模板，支持 ${prefix} ${file} ${line} ${location} ${expr} */
function renderTemplate(
  template: string,
  expression: string,
  fileName: string,
  lineNumber: number,
  cfg: EclConfig
): string {
  const file = cfg.includeFilename ? fileName : '';
  const line = cfg.includeLineNumber ? String(lineNumber) : '';
  const location = [file, line].filter(Boolean).join(':');
  return template
    .replace(/\$\{prefix\}/g, cfg.prefix)
    .replace(/\$\{file\}/g, file)
    .replace(/\$\{line\}/g, line)
    .replace(/\$\{location\}/g, location)
    .replace(/\$\{expr\}/g, escapeForQuote(expression, cfg.quote));
}

/**
 * 构建一条日志语句，例如：
 *   console.log('🪵 ~ app.ts:42 ~ userName:', userName);
 * expr 为对象字面量（如 {a, b}）时，末尾不再追加第二个实参。
 */
export function buildLogStatement(
  expression: string,
  fileName: string,
  lineNumber: number,
  indent: string,
  cfg: EclConfig
): string {
  const message = renderTemplate(
    cfg.messageTemplate,
    expression,
    fileName,
    lineNumber,
    cfg
  );
  const isPy = /\.py$/i.test(fileName);
  const semi = cfg.semicolon && !isPy ? ';' : '';
  const fn = logFunctionForFile(fileName, cfg);
  return `${indent}${fn}(${cfg.quote}${message}${cfg.quote}, ${expression})${semi}`;
}

/**
 * 返回用于匹配"本扩展生成的日志行"的正则。
 * 匹配正常行与被注释行，如：
 *   console.log('🪵 ~ ...', x);
 *   // console.log('🪵 ~ ...', x);
 */
export function logLineRegExp(prefix: string): RegExp {
  const p = escapeRegExp(prefix);
  return new RegExp(
    `^(\\s*)(//\\s*)?(console\\.(?:log|debug|info|warn|error)\\(\\s*['"\`]${p})`
  );
}
