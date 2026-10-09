import * as vscode from 'vscode';
import { splitLines } from './consoleScan';
import { docLines } from './editUtil';

const EXTENSIONS = ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'];
const EXCLUDED_DIRS = ['node_modules', 'dist', 'out', 'build', '.git', 'vendor', 'coverage', '.next', '.nuxt',
  '.output', '.svelte-kit'];

export const WORKSPACE_GLOB = `**/*.{${EXTENSIONS.join(',')}}`;
const EXCLUDE_GLOB = `**/{${EXCLUDED_DIRS.join(',')}}/**`;
const EXT_RE = new RegExp(`\\.(${EXTENSIONS.join('|')})$`, 'i');
const EXCLUDED_RE = new RegExp(`/(${EXCLUDED_DIRS.map((d) => d.replace('.', '\\.')).join('|')})/`);
/** 含超长行的文件视为压缩/打包产物，整文件跳过，避免整行删除毁掉文件 */
const MAX_LINE_LEN = 3000;

/** 判断文件是否属于工作区扫描范围（用于增量更新时过滤） */
export function isScannable(uri: vscode.Uri): boolean {
  return (
    EXT_RE.test(uri.path) &&
    !/\.min\.[cm]?js$/i.test(uri.path) &&
    !EXCLUDED_RE.test(uri.path) &&
    vscode.workspace.getWorkspaceFolder(uri) !== undefined
  );
}

/** 读取文件内容；已打开的文档以编辑器中的内容为准（可能有未保存修改）。打包产物返回 undefined */
export async function readLines(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  let lines: string[];
  try {
    lines = open ? docLines(open) : splitLines(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    return undefined;
  }
  return lines.some((l) => l.length > MAX_LINE_LEN) ? undefined : lines;
}

/**
 * 扫描工作区内的 JS 系文件。pick 返回 undefined 的文件会被丢弃。
 * progress 用于显示进度；用户取消时返回 undefined。
 */
export async function scanWorkspace<T>(
  pick: (uri: vscode.Uri, lines: string[]) => T | undefined,
  token?: vscode.CancellationToken,
  progress?: vscode.Progress<{ increment?: number }>
): Promise<T[] | undefined> {
  const files = await vscode.workspace.findFiles(WORKSPACE_GLOB, EXCLUDE_GLOB, undefined, token);
  const results: T[] = [];
  for (const uri of files) {
    if (token?.isCancellationRequested) {
      return undefined;
    }
    progress?.report({ increment: 100 / files.length });
    if (/\.min\.[cm]?js$/i.test(uri.path)) {
      continue;
    }
    const lines = await readLines(uri);
    const r = lines && pick(uri, lines);
    if (r !== undefined) {
      results.push(r);
    }
  }
  return results;
}
