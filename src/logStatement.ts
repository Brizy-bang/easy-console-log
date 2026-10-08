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
  const parts: string[] = [cfg.prefix];
  const location: string[] = [];
  if (cfg.includeFilename) {
    location.push(fileName);
  }
  if (cfg.includeLineNumber) {
    location.push(String(lineNumber));
  }
  if (location.length > 0) {
    parts.push(location.join(':'));
  }
  parts.push(`${escapeForQuote(expression, cfg.quote)}:`);
  const message = parts.join(' ~ ');
  const semi = cfg.semicolon ? ';' : '';
  return `${indent}${cfg.logFunction}(${cfg.quote}${message}${cfg.quote}, ${expression})${semi}`;
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
