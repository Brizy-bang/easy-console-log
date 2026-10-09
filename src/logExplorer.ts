import * as vscode from 'vscode';

/** 匹配当前文件中所有 console.* 调用行（含被注释的） */
const CONSOLE_LINE_RE = /^(\s*)(\/\/\s*)?(console\.(?:log|debug|info|warn|error)\s*\()/;

/** 侧边栏树节点数据 */
class LogItem extends vscode.TreeItem {
  constructor(
    public readonly doc: vscode.TextDocument,
    public readonly line: number,
    public readonly text: string,
    public readonly commented: boolean
  ) {
    const label = `${line + 1}: ${text.trim()}`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = text.trim();
    this.description = commented ? '已注释' : '';
    this.iconPath = commented
      ? new vscode.ThemeIcon('debug-breakpoint-log-unverified')
      : new vscode.ThemeIcon('debug-console');
    this.command = {
      command: 'easyConsoleLog.explorer.revealLine',
      title: '定位到日志行',
      arguments: [doc.uri, line],
    };
  }
}

/** 收集当前编辑器文档中所有 console.* 行 */
function collectConsoleLines(doc: vscode.TextDocument): LogItem[] {
  const items: LogItem[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const m = text.match(CONSOLE_LINE_RE);
    if (m) {
      items.push(new LogItem(doc, i, text, m[2] !== undefined));
    }
  }
  return items;
}

/** 侧边栏 Console 树数据提供者 */
export class ConsoleLogExplorerProvider
  implements vscode.TreeDataProvider<LogItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    LogItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentDoc?: vscode.TextDocument;

  refresh(doc?: vscode.TextDocument): void {
    this.currentDoc = doc;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LogItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<LogItem[]> {
    const doc = this.currentDoc ?? vscode.window.activeTextEditor?.document;
    if (!doc) {
      return Promise.resolve([]);
    }
    return Promise.resolve(collectConsoleLines(doc));
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

/** 获取当前树视图聚焦的文档，优先取活动编辑器 */
function getTargetDoc(): vscode.TextDocument | undefined {
  return vscode.window.activeTextEditor?.document;
}

/** 注释当前文件所有 console.* 行 */
export async function explorerCommentAll(): Promise<void> {
  const doc = getTargetDoc();
  const editor = vscode.window.activeTextEditor;
  if (!doc || !editor) {
    return;
  }
  const targets = collectConsoleLines(doc).filter((t) => !t.commented);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 没有可注释的日志');
    return;
  }
  await editor.edit((builder) => {
    for (const t of targets) {
      const line = doc.lineAt(t.line);
      builder.insert(line.range.start, '// ');
    }
  });
  vscode.window.showInformationMessage(
    `Easy Console Log: 已注释 ${targets.length} 条日志`
  );
}

/** 取消注释当前文件所有被注释的 console.* 行 */
export async function explorerUncommentAll(): Promise<void> {
  const doc = getTargetDoc();
  const editor = vscode.window.activeTextEditor;
  if (!doc || !editor) {
    return;
  }
  const targets = collectConsoleLines(doc).filter((t) => t.commented);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 没有可取消注释的日志');
    return;
  }
  await editor.edit((builder) => {
    for (const t of targets) {
      const text = doc.lineAt(t.line).text;
      const m = text.match(CONSOLE_LINE_RE);
      if (m && m[2]) {
        const commentEnd = text.indexOf('console', m[2].length + m[1].length);
        builder.delete(
          new vscode.Range(
            t.line,
            m[1].length,
            t.line,
            commentEnd
          )
        );
      }
    }
  });
  vscode.window.showInformationMessage(
    `Easy Console Log: 已恢复 ${targets.length} 条日志`
  );
}

/** 删除当前文件所有 console.* 行 */
export async function explorerDeleteAll(): Promise<void> {
  const doc = getTargetDoc();
  const editor = vscode.window.activeTextEditor;
  if (!doc || !editor) {
    return;
  }
  const targets = collectConsoleLines(doc);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Easy Console Log: 没有可删除的日志');
    return;
  }
  await editor.edit((builder) => {
    for (let i = targets.length - 1; i >= 0; i--) {
      const t = targets[i];
      const line = doc.lineAt(t.line);
      if (t.line === doc.lineCount - 1 && doc.lineCount > 1) {
        builder.delete(new vscode.Range(doc.lineAt(t.line - 1).range.end, line.range.end));
      } else {
        builder.delete(line.rangeIncludingLineBreak);
      }
    }
  });
  vscode.window.showInformationMessage(
    `Easy Console Log: 已删除 ${targets.length} 条日志`
  );
}
