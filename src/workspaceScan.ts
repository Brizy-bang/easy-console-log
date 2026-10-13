import * as vscode from 'vscode';
import { getConfig } from './config';
import { escapeRegExp, splitLines } from './consoleScan';
import { docLines } from './editUtil';

const EXTENSIONS = ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'py'];

export const WORKSPACE_GLOB = `**/*.{${EXTENSIONS.join(',')}}`;
const EXT_RE = new RegExp(`\\.(${EXTENSIONS.join('|')})$`, 'i');
/** Files with very long lines are treated as minified/bundled output and skipped entirely,
 * so that whole-line deletion cannot wreck them */
const MAX_LINE_LEN = 3000;
/** File read concurrency */
const CONCURRENCY = 16;

/** Effective excluded directory names for a resource scope (the setting's default contains the built-in list) */
function excludeDirs(scope: vscode.ConfigurationScope | undefined): string[] {
  return getConfig(scope).workspaceExcludeDirs;
}

/** Directory-exclude RegExp cache, keyed by the directory list (rebuilt only when the setting changes) */
const dirReCache = new Map<string, RegExp | undefined>();

function excludeDirRe(dirs: string[]): RegExp | undefined {
  const key = dirs.join('\0');
  if (!dirReCache.has(key)) {
    dirReCache.set(key, dirs.length ? new RegExp(`/(${dirs.map(escapeRegExp).join('|')})/`) : undefined);
  }
  return dirReCache.get(key);
}

/**
 * Assemble the findFiles exclude glob for one workspace folder: configured directory excludes plus
 * files.exclude and search.exclude entries whose value is true.
 * Every entry is a flat top-level alternative, because glob groups `{...}` must not be nested.
 * Note: once a custom exclude is passed to findFiles, files.exclude no longer applies
 * automatically and must be merged manually.
 */
function excludeGlob(folder: vscode.WorkspaceFolder): string {
  const globs = new Set<string>(excludeDirs(folder.uri).map((d) => `**/${d}/**`));
  for (const section of ['files', 'search'] as const) {
    const entries = vscode.workspace.getConfiguration(section, folder.uri).get<Record<string, unknown>>('exclude');
    for (const [pattern, value] of Object.entries(entries ?? {})) {
      // patterns that themselves contain a group cannot be nested inside ours
      if (value === true && !/[{}]/.test(pattern)) {
        globs.add(pattern);
      }
    }
  }
  return globs.size ? `{${[...globs].join(',')}}` : '**/.ecl-never-match';
}

/** Whether a file belongs to the workspace scan scope (used to filter incremental updates) */
export function isScannable(uri: vscode.Uri): boolean {
  if (!EXT_RE.test(uri.path) || /\.min\.[cm]?js$/i.test(uri.path) || !vscode.workspace.getWorkspaceFolder(uri)) {
    return false;
  }
  return !excludeDirRe(excludeDirs(uri))?.test(uri.path);
}

/** Read file lines; open documents win (they may have unsaved changes). Bundled files return undefined */
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

/** Find JS-family files in every workspace folder, honoring that folder's exclude settings */
async function findWorkspaceFiles(token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
  const perFolder = await Promise.all(
    (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const include = new vscode.RelativePattern(folder, WORKSPACE_GLOB);
      return vscode.workspace.findFiles(include, excludeGlob(folder), undefined, token);
    })
  );
  return perFolder.flat();
}

/**
 * Scan JS-family files in the workspace. Files whose pick returns undefined are dropped.
 * progress reports progress; returns undefined when the user cancels.
 */
export async function scanWorkspace<T>(
  pick: (uri: vscode.Uri, lines: string[]) => T | undefined,
  token?: vscode.CancellationToken,
  progress?: vscode.Progress<{ increment?: number }>
): Promise<T[] | undefined> {
  return scanFiles(await findWorkspaceFiles(token), pick, token, progress);
}

/**
 * Read the given files with limited concurrency and collect pick results (undefined results are dropped).
 * Returns undefined when the user cancels.
 */
export async function scanFiles<T>(
  files: readonly vscode.Uri[],
  pick: (uri: vscode.Uri, lines: string[]) => T | undefined,
  token?: vscode.CancellationToken,
  progress?: vscode.Progress<{ increment?: number }>
): Promise<T[] | undefined> {
  const results: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      if (token?.isCancellationRequested) {
        return;
      }
      const uri = files[next++];
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
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return token?.isCancellationRequested ? undefined : results;
}
