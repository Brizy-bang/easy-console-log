import * as path from 'path';
import * as vscode from 'vscode';
import { BatchMode, CONSOLE_LEVELS, LogBlock, scanConsole } from './consoleScan';
import { applyBatchToEditor, docLines, JS_LANGS } from './editUtil';
import { isScannable, readLines, scanWorkspace, WORKSPACE_GLOB } from './workspaceScan';

export const CURRENT_VIEW_ID = 'easyConsoleLog.explorer';
export const WORKSPACE_VIEW_ID = 'easyConsoleLog.workspace';

/** 两个视图共享的级别筛选 */
class LevelFilter {
  private levels = new Set<string>(CONSOLE_LEVELS);
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

/** 日志级别分组节点（当前文件视图） */
class LogGroupItem extends vscode.TreeItem {
  constructor(
    public readonly level: string,
    count: number
  ) {
    super(`console.${level} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'logGroup';
    this.iconPath = new vscode.ThemeIcon(
      level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'debug-console'
    );
  }
}

/** 文件节点（工作区视图） */
class FileItem extends vscode.TreeItem {
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

/** 单条日志节点 */
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

/** 当前文件视图：按级别分组列出活动编辑器中的 console 调用 */
export class ConsoleLogExplorerProvider implements vscode.TreeDataProvider<CurrentNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<CurrentNode | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** 每次 refresh 扫描一次，供 getChildren 复用 */
  private snapshot: { uri: vscode.Uri; blocks: LogBlock[] } | undefined;
  private view: vscode.TreeView<CurrentNode> | undefined;
  private subscription = levelFilter.onDidChange(() => this.emitter.fire());

  /** 绑定 TreeView，用于在刷新时更新描述栏统计 */
  attach(view: vscode.TreeView<CurrentNode>): void {
    this.view = view;
  }

  refresh(): void {
    const doc = vscode.window.activeTextEditor?.document;
    this.snapshot =
      doc && JS_LANGS.has(doc.languageId)
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
 * 工作区视图：按文件分组列出工作区内所有 console 调用。
 * 首次展开时才扫描；之后根据编辑与文件系统变化增量更新单个文件。
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

  /** 丢弃缓存，下次展开时重新扫描 */
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

  /** 编辑器中的文档内容变化 */
  onDocumentChanged(doc: vscode.TextDocument): void {
    if (JS_LANGS.has(doc.languageId)) {
      this.schedule(doc.uri, async () => docLines(doc));
    }
  }

  /** 按文件防抖地重新扫描 */
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

/** 打开级别筛选 QuickPick（同时作用于两个视图） */
export async function filterLevels(): Promise<void> {
  const items = CONSOLE_LEVELS.map((level) => ({
    label: `console.${level}`,
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

/** 跳转到指定日志行 */
export async function revealLine(uri: vscode.Uri, line: number): Promise<void> {
  const editor = await vscode.window.showTextDocument(uri);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, editor.document.lineAt(line).range.end),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

/** 对单条日志执行操作；树节点可能已过期，先按当前内容重新定位，失败时调用 onStale */
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

/** 切换单条日志的注释状态 */
export function toggleLogItem(item: LogItem, onStale: () => void): Promise<void> {
  return applyToItem(item, (b) => (b.commented ? 'uncomment' : 'comment'), onStale);
}

/** 删除单条日志 */
export function deleteLogItem(item: LogItem, onStale: () => void): Promise<void> {
  return applyToItem(item, () => 'delete', onStale);
}

/** 复制日志文本 */
export async function copyLogText(item: LogItem): Promise<void> {
  await vscode.env.clipboard.writeText(item.info.body);
}

/** 对当前文件所有 console.* 执行批量操作 */
export async function batchOnCurrentFile(mode: BatchMode): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const lines = docLines(editor.document);
  await applyBatchToEditor(editor, lines, scanConsole(lines, editor.document.fileName), mode);
}
