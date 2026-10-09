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
  /** 消息模板，支持 ${prefix} ${file} ${line} ${expr} 占位符 */
  messageTemplate: string;
  /** 是否为 console.* 行添加诊断提示 */
  diagnosticsEnabled: boolean;
  /** 诊断提示的严重级别 */
  diagnosticsSeverity: 'error' | 'warning' | 'information' | 'hint';
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
    messageTemplate:
      cfg.get<string>('messageTemplate') ?? '${prefix} ~ ${location} ~ ${expr}:',
    diagnosticsEnabled: cfg.get<boolean>('diagnostics.enabled') ?? true,
    diagnosticsSeverity:
      cfg.get<'error' | 'warning' | 'information' | 'hint'>(
        'diagnostics.severity'
      ) ?? 'hint',
  };
}
