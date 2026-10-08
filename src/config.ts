import * as vscode from 'vscode';

export interface EclConfig {
  /** 日志消息前缀标记，同时用于识别本扩展生成的日志行 */
  prefix: string;
  /** 日志消息引号风格 */
  quote: string;
  /** 是否在末尾加分号 */
  semicolon: boolean;
  /** 使用的日志函数，如 console.log */
  logFunction: string;
  /** 消息中是否包含文件名 */
  includeFilename: boolean;
  /** 消息中是否包含行号 */
  includeLineNumber: boolean;
}

export function getConfig(): EclConfig {
  const cfg = vscode.workspace.getConfiguration('easyConsoleLog');
  return {
    prefix: cfg.get<string>('logMessagePrefix') ?? '🪵',
    quote: cfg.get<string>('quote') ?? "'",
    semicolon: cfg.get<boolean>('addSemicolon') ?? true,
    logFunction: cfg.get<string>('logFunction') ?? 'console.log',
    includeFilename: cfg.get<boolean>('includeFilename') ?? true,
    includeLineNumber: cfg.get<boolean>('includeLineNumber') ?? true,
  };
}
