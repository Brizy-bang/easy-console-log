import * as path from 'path';
import * as vscode from 'vscode';
import { BatchMode, CONSOLE_SCAN_METHODS, LogBlock, scanConsole } from './consoleScan';
import { applyBatchToEditor, docLines, SCAN_LANGS } from './editUtil';
import { isScannable, readLines, scanWorkspace, WORKSPACE_GLOB } from './workspaceScan';

export const CURRENT_VIEW_ID = 'easyConsoleLog.explorer';
export const WORKSPACE_VIEW_ID = 'easyConsoleLog.workspace';

/** Python's print shows up as its own pseudo level in the views */
export const PRINT_LEVEL = 'print';

/** Level filter shared by both views */
class LevelFilter {
  private levels = new Set<string>([...CONSOLE_SCAN_METHODS, PRINT_LEVEL]);
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  has(level: string): boolean {
    return this.levels.has(level);
  }

  set(levels: Iterable<string>): void {
    this.levels = new Set(levels);
    this.emitter.fire();
  }
}

export const levelFilter = new LevelFilter();

/** Level group node (current-file view) */
class LogGroupItem extends vscode.TreeItem {
  constructor(
    public readonly level: string,
    count: number
  ) {
    super(
      `${level === PRINT_LEVEL ? 'print' : `console.${level}`} (${count})`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.contextValue = 'logGroup';
    this.iconPath = new vscode.ThemeIcon(
      level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'debug-console'
    );
  }
}

/** File node (workspace view) */
export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly blocks: LogBlock[]
  ) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.Collapsed);
    const rel = vscode.workspace.asRelativePath(uri);
    const dir = path.dirname(rel);
    this.description = dir === '.' ? `${blocks.length}` : `${blocks.length} · ${dir}`;
    this.tooltip = rel;
    this.resourceUri = uri;
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = 'logFile';
  }
}

/** Single log node */
export class LogItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly info: LogBlock
  ) {
    super(`${info.line + 1}: ${info.body}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = info.body;
    this.description = info.commented ? vscode.l10n.t('commented') : '';
    this.iconPath = info.commented
      ? new vscode.ThemeIcon('debug-breakpoint-log-unverified')
      : new vscode.ThemeIcon('debug-console');
    this.contextValue = info.commented ? 'logItem.commented' : 'logItem';
    this.command = {
      command: 'easyConsoleLog.explorer.revealLine',
      title: vscode.l10n.t('Go to Log'),
      arguments: [uri, info.line],
    };
  }
}

type CurrentNode = LogGroupItem | LogItem;

/** Current-file view: console calls in the active editor, grouped by level */
export class ConsoleLogExplorerProvider implements vscode.TreeDataProvider<CurrentNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<CurrentNode | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Scanned once per refresh and reused by getChildren */
  private snapshot: { uri: vscode.Uri; blocks: LogBlock[] } | undefined;
  private view: vscode.TreeView<CurrentNode> | undefined;
  private subscription = levelFilter.onDidChange(() => this.emitter.fire());

  /** Bind the TreeView to update the description stats on refresh */
  attach(view: vscode.TreeView<CurrentNode>): void {
    this.view = view;
  }

  refresh(): void {
    const doc = vscode.window.activeTextEditor?.document;
    this.snapshot =
      doc && SCAN_LANGS.has(doc.languageId)
        ? { uri: doc.uri, blocks: scanConsole(docLines(doc), doc.fileName) }
        : undefined;
    if (this.view) {
      const groups = this.countByLevel();
      this.view.description = !this.snapshot
        ? ''
        : groups.size
          ? [...groups.entries()].map(([k, v]) => `${k}: ${v}`).join('  ')
          : vscode.l10n.t('no console calls');
    }
    this.emitter.fire();
  }

  private countByLevel(): Map<string, number> {
    const groups = new Map<string, number>();
    for (const b of this.snapshot?.blocks ?? []) {
      groups.set(b.level, (groups.get(b.level) ?? 0) + 1);
    }
    return groups;
  }

  getTreeItem(element: CurrentNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CurrentNode): CurrentNode[] {
    const snap = this.snapshot;
    if (!snap) {
      return [];
    }
    if (!element) {
      return [...this.countByLevel().entries()]
        .filter(([level]) => levelFilter.has(level))
        .map(([level, count]) => new LogGroupItem(level, count));
    }
    if (element instanceof LogGroupItem) {
      return snap.blocks.filter((b) => b.level === element.level).map((b) => new LogItem(snap.uri, b));
    }
    return [];
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

type WorkspaceNode = FileItem | LogItem;

/**
 * Workspace view: all console calls in the workspace, grouped by file.
 * Scanned on first expand; individual files are then updated incrementally on edits and file-system changes.
 */
export class WorkspaceLogProvider implements vscode.TreeDataProvider<WorkspaceNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<WorkspaceNode | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private files: Map<string, { uri: vscode.Uri; blocks: LogBlock[] }> | undefined;
  private loading: Promise<void> | undefined;
  private view: vscode.TreeView<WorkspaceNode> | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[] = [levelFilter.onDidChange(() => this.changed())];

  attach(view: vscode.TreeView<WorkspaceNode>): void {
    this.view = view;
  }

  /** Drop the cache; the next expand rescans */
  refresh(): void {
    this.files = undefined;
    this.loading = undefined;
    this.emitter.fire();
  }

  private load(): Promise<void> {
    this.loading ??= Promise.resolve(
      vscode.window.withProgress({ location: { viewId: WORKSPACE_VIEW_ID } }, async () => {
        const scanned = await scanWorkspace((uri, lines) => {
          const blocks = scanConsole(lines, uri.path);
          return blocks.length ? { uri, blocks } : undefined;
        });
        this.files = new Map((scanned ?? []).map((f) => [f.uri.toString(), f]));
        this.ensureWatcher();
        this.updateDescription();
      })
    );
    return this.loading;
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(WORKSPACE_GLOB);
    const fromDisk = (uri: vscode.Uri) => this.schedule(uri, () => readLines(uri));
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(fromDisk),
      this.watcher.onDidChange(fromDisk),
      this.watcher.onDidDelete((uri) => this.setFile(uri, undefined))
    );
  }

  /** Document content changed in the editor */
  onDocumentChanged(doc: vscode.TextDocument): void {
    if (SCAN_LANGS.has(doc.languageId)) {
      this.schedule(doc.uri, async () => docLines(doc));
    }
  }

  /** Rescan a file with debounce */
  private schedule(uri: vscode.Uri, read: () => Promise<string[] | undefined>): void {
    if (!this.files || !isScannable(uri)) {
      return;
    }
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(async () => {
        this.timers.delete(key);
        this.setFile(uri, await read());
      }, 500)
    );
  }

  private setFile(uri: vscode.Uri, lines: string[] | undefined): void {
    if (!this.files) {
      return;
    }
    const blocks = lines ? scanConsole(lines, uri.path) : [];
    if (blocks.length) {
      this.files.set(uri.toString(), { uri, blocks });
    } else if (!this.files.delete(uri.toString())) {
      return;
    }
    this.changed();
  }

  private changed(): void {
    this.updateDescription();
    this.emitter.fire();
  }

  private visibleFiles(): { uri: vscode.Uri; blocks: LogBlock[] }[] {
    return [...(this.files?.values() ?? [])]
      .map((f) => ({ uri: f.uri, blocks: f.blocks.filter((b) => levelFilter.has(b.level)) }))
      .filter((f) => f.blocks.length > 0)
      .sort((a, b) => a.uri.path.localeCompare(b.uri.path));
  }

  private updateDescription(): void {
    if (!this.view || !this.files) {
      return;
    }
    const files = this.visibleFiles();
    const total = files.reduce((n, f) => n + f.blocks.length, 0);
    this.view.description = vscode.l10n.t('{0} in {1} file(s)', total, files.length);
  }

  getTreeItem(element: WorkspaceNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorkspaceNode): Promise<WorkspaceNode[]> {
    if (!element) {
      await this.load();
      return this.visibleFiles().map((f) => new FileItem(f.uri, f.blocks));
    }
    if (element instanceof FileItem) {
      return element.blocks.map((b) => new LogItem(element.uri, b));
    }
    return [];
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}

/** Open the level filter QuickPick (applies to both views) */
export async function filterLevels(): Promise<void> {
  const items = [...CONSOLE_SCAN_METHODS, PRINT_LEVEL].map((level) => ({
    label: level === PRINT_LEVEL ? 'print' : `console.${level}`,
    level,
    picked: levelFilter.has(level),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: vscode.l10n.t('Select console levels to show'),
  });
  if (picked) {
    levelFilter.set(picked.map((p) => p.level));
  }
}

/** Jump to the given log line */
export async function revealLine(uri: vscode.Uri, line: number): Promise<void> {
  const editor = await vscode.window.showTextDocument(uri);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, editor.document.lineAt(line).range.end),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

/** Apply an op to a single log; the tree node may be stale, so re-locate by current
 * content and call onStale on failure */
async function applyToItem(item: LogItem, mode: (b: LogBlock) => BatchMode, onStale: () => void): Promise<void> {
  const editor = await vscode.window.showTextDocument(item.uri, { preserveFocus: true });
  const lines = docLines(editor.document);
  const current = scanConsole(lines, editor.document.fileName).find(
    (b) => b.line === item.info.line && b.body === item.info.body
  );
  if (!current) {
    onStale();
    vscode.window.showInformationMessage(vscode.l10n.t('Easy Console Log: the log has changed, list refreshed'));
    return;
  }
  await applyBatchToEditor(editor, lines, [current], mode(current), false);
}

/** Toggle the comment state of a single log */
export function toggleLogItem(item: LogItem, onStale: () => void): Promise<void> {
  return applyToItem(item, (b) => (b.commented ? 'uncomment' : 'comment'), onStale);
}

/** Delete a single log */
export function deleteLogItem(item: LogItem, onStale: () => void): Promise<void> {
  return applyToItem(item, () => 'delete', onStale);
}

/** Copy the log text */
export async function copyLogText(item: LogItem): Promise<void> {
  await vscode.env.clipboard.writeText(item.info.body);
}

/** Run a batch operation on all console.* calls in the file of a workspace-view node */
export async function batchOnFileItem(item: FileItem, mode: BatchMode): Promise<void> {
  const editor = await vscode.window.showTextDocument(item.uri, { preserveFocus: true });
  const lines = docLines(editor.document);
  await applyBatchToEditor(editor, lines, scanConsole(lines, editor.document.fileName), mode);
}

/** Run a batch operation on all console.* calls in the current file */
export async function batchOnCurrentFile(mode: BatchMode): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const lines = docLines(editor.document);
  await applyBatchToEditor(editor, lines, scanConsole(lines, editor.document.fileName), mode);
}
