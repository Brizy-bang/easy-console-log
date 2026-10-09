import * as vscode from 'vscode';
import {
  collectConsoleLines,
  ConsoleLogLine,
  applyToLine,
} from './consoleScan';

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
    public readonly info: ConsoleLogLine
  ) {
    super(`${info.line + 1}: ${info.text}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = info.text;
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

/** 侧边栏 Console 树数据提供者 */
export class ConsoleLogExplorerProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private enabledLevels = new Set<string>(ALL_LEVELS);
  private _stats = '';

  get levels(): Set<string> {
    return this.enabledLevels;
  }

  /** 供 extension.ts 更新 TreeView.description 的统计文本 */
  get stats(): string {
    return this._stats;
  }

  private updateStats(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      this._stats = '';
      return;
    }
    const groups = new Map<string, number>();
    for (const l of collectConsoleLines(doc)) {
      groups.set(l.level, (groups.get(l.level) ?? 0) + 1);
    }
    this._stats = groups.size
      ? [...groups.entries()].map(([k, v]) => `${k}: ${v}`).join('  ')
      : '无 console';
  }

  refresh(): void {
    this.updateStats();
    this._onDidChangeTreeData.fire();
  }

  setLevels(levels: Set<string>): void {
    this.enabledLevels = levels;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      return Promise.resolve([]);
    }
    const all = collectConsoleLines(doc);
    const lines = all.filter((l) => this.enabledLevels.has(l.level));

    if (!element) {
      const groups = new Map<string, number>();
      for (const l of all) {
        groups.set(l.level, (groups.get(l.level) ?? 0) + 1);
      }
      return Promise.resolve(
        [...groups.entries()]
          .filter(([level]) => this.enabledLevels.has(level))
          .map(([level, count]) => new LogGroupItem(level, count))
      );
    }
    if (element instanceof LogGroupItem) {
      return Promise.resolve(
        lines
          .filter((l) => l.level === element.level)
          .map((l) => new LogItem(doc, l))
      );
    }
    return Promise.resolve([]);
  }
}

/** 打开级别筛选 QuickPick */
export async function filterLevels(
  provider: ConsoleLogExplorerProvider
): Promise<void> {
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
    new vscode.Range(
      pos,
      new vscode.Position(line, doc.lineAt(line).text.length)
    ),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

/** 切换单条日志的注释状态 */
export async function toggleLogItem(item: LogItem): Promise<void> {
  const editor = await vscode.window.showTextDocument(item.doc);
  await editor.edit((builder) => {
    applyToLine(
      builder,
      item.doc,
      item.info,
      item.info.commented ? 'uncomment' : 'comment'
    );
  });
}

/** 删除单条日志 */
export async function deleteLogItem(item: LogItem): Promise<void> {
  const editor = await vscode.window.showTextDocument(item.doc);
  await editor.edit((builder) => {
    applyToLine(builder, item.doc, item.info, 'delete');
  });
}

/** 复制日志文本 */
export async function copyLogText(item: LogItem): Promise<void> {
  await vscode.env.clipboard.writeText(item.info.text);
}

function getTargetDoc(): vscode.TextDocument | undefined {
  return vscode.window.activeTextEditor?.document;
}

async function batchOnCurrentFile(mode: 'comment' | 'uncomment' | 'delete') {
  const doc = getTargetDoc();
  const editor = vscode.window.activeTextEditor;
  if (!doc || !editor) {
    return;
  }
  const all = collectConsoleLines(doc);
  const targets = all.filter((t) =>
    mode === 'comment' ? !t.commented : mode === 'uncomment' ? t.commented : true
  );
  if (targets.length === 0) {
    vscode.window.showInformationMessage(
      `Easy Console Log: 没有可${
        mode === 'comment' ? '注释' : mode === 'uncomment' ? '取消注释' : '删除'
      }的日志`
    );
    return;
  }
  await editor.edit((builder) => {
    for (const t of targets) {
      applyToLine(builder, doc, t, mode);
    }
  });
  vscode.window.showInformationMessage(
    `Easy Console Log: 已${
      mode === 'comment' ? '注释' : mode === 'uncomment' ? '恢复' : '删除'
    } ${targets.length} 条日志`
  );
}

export function explorerCommentAll(): Promise<void> {
  return batchOnCurrentFile('comment');
}

export function explorerUncommentAll(): Promise<void> {
  return batchOnCurrentFile('uncomment');
}

export function explorerDeleteAll(): Promise<void> {
  return batchOnCurrentFile('delete');
}
