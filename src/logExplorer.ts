import * as vscode from 'vscode';
import { BatchMode, LogBlock, scanConsole } from './consoleScan';
import { applyBatchToEditor, docLines, JS_LANGS } from './editUtil';

const ALL_LEVELS = ['log', 'debug', 'info', 'warn', 'error'] as const;

type TreeNode = LogGroupItem | LogItem;

/** 日志级别分组节点 */
class LogGroupItem extends vscode.TreeItem {
  constructor(
    public readonly level: string,
    public readonly count: number
  ) {
    super(`console.${level} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'logGroup';
    this.iconPath = new vscode.ThemeIcon(
      level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'debug-console'
    );
  }
}

/** 单条日志节点 */
export class LogItem extends vscode.TreeItem {
  constructor(
    public readonly doc: vscode.TextDocument,
    public readonly info: LogBlock
  ) {
    super(`${info.line + 1}: ${info.body}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = info.body;
    this.description = info.commented ? '已注释' : '';
    this.iconPath = info.commented
      ? new vscode.ThemeIcon('debug-breakpoint-log-unverified')
      : new vscode.ThemeIcon('debug-console');
    this.contextValue = info.commented ? 'logItem.commented' : 'logItem';
    this.command = {
      command: 'easyConsoleLog.explorer.revealLine',
      title: '定位到日志行',
      arguments: [doc.uri, info.line],
    };
  }
}

/** 当前活动文档中可展示的 console 调用（不支持的语言返回 undefined） */
function scanActive(): { doc: vscode.TextDocument; blocks: LogBlock[] } | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !JS_LANGS.has(doc.languageId)) {
    return undefined;
  }
  return { doc, blocks: scanConsole(docLines(doc), doc.fileName) };
}

/** 侧边栏 Console 树数据提供者 */
export class ConsoleLogExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private enabledLevels = new Set<string>(ALL_LEVELS);
  /** 每次 refresh 扫描一次，供 getChildren 复用 */
  private snapshot: ReturnType<typeof scanActive>;
  private view: vscode.TreeView<TreeNode> | undefined;

  get levels(): Set<string> {
    return this.enabledLevels;
  }

  /** 绑定 TreeView，用于在刷新时更新描述栏统计 */
  attach(view: vscode.TreeView<TreeNode>): void {
    this.view = view;
  }

  refresh(): void {
    this.snapshot = scanActive();
    if (this.view) {
      const groups = this.countByLevel();
      this.view.description = !this.snapshot
        ? ''
        : groups.size
          ? [...groups.entries()].map(([k, v]) => `${k}: ${v}`).join('  ')
          : '无 console';
    }
    this._onDidChangeTreeData.fire();
  }

  setLevels(levels: Set<string>): void {
    this.enabledLevels = levels;
    this._onDidChangeTreeData.fire();
  }

  private countByLevel(): Map<string, number> {
    const groups = new Map<string, number>();
    for (const b of this.snapshot?.blocks ?? []) {
      groups.set(b.level, (groups.get(b.level) ?? 0) + 1);
    }
    return groups;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    const snap = this.snapshot;
    if (!snap) {
      return [];
    }
    if (!element) {
      return [...this.countByLevel().entries()]
        .filter(([level]) => this.enabledLevels.has(level))
        .map(([level, count]) => new LogGroupItem(level, count));
    }
    if (element instanceof LogGroupItem) {
      return snap.blocks
        .filter((b) => b.level === element.level)
        .map((b) => new LogItem(snap.doc, b));
    }
    return [];
  }
}

/** 打开级别筛选 QuickPick */
export async function filterLevels(provider: ConsoleLogExplorerProvider): Promise<void> {
  const items = ALL_LEVELS.map((level) => ({
    label: `console.${level}`,
    level,
    picked: provider.levels.has(level),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: '选择要显示的 console 级别',
    placeHolder: '勾选需要展示的级别',
  });
  if (picked) {
    provider.setLevels(new Set(picked.map((p) => p.level)));
  }
}

/** 跳转到指定日志行 */
export async function revealLine(uri: vscode.Uri, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, new vscode.Position(line, doc.lineAt(line).text.length)),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

/** 对单条日志执行操作；树节点可能已过期，先按当前内容重新定位 */
async function applyToItem(
  provider: ConsoleLogExplorerProvider,
  item: LogItem,
  mode: (b: LogBlock) => BatchMode
): Promise<void> {
  const editor = await vscode.window.showTextDocument(item.doc);
  const lines = docLines(item.doc);
  const current = scanConsole(lines, item.doc.fileName).find(
    (b) => b.line === item.info.line && b.body === item.info.body
  );
  if (!current) {
    provider.refresh();
    vscode.window.showInformationMessage('Easy Console Log: 日志内容已变化，列表已刷新');
    return;
  }
  await applyBatchToEditor(editor, lines, [current], mode(current), false);
}

/** 切换单条日志的注释状态 */
export function toggleLogItem(provider: ConsoleLogExplorerProvider, item: LogItem): Promise<void> {
  return applyToItem(provider, item, (b) => (b.commented ? 'uncomment' : 'comment'));
}

/** 删除单条日志 */
export function deleteLogItem(provider: ConsoleLogExplorerProvider, item: LogItem): Promise<void> {
  return applyToItem(provider, item, () => 'delete');
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
