import * as vscode from 'vscode';
import { batchEdits, BatchMode, blockAtLine, commentTokenFor, LogBlock, scanConsole } from './consoleScan';
import { DIAGNOSTIC_SOURCE } from './diagnostics';
import { applyLineEdits, docLines, JS_LANGS, workspaceSink } from './editUtil';

/** Quick Fix for console.* calls: comment / uncomment / delete this call, plus file-level batch ops */
export class ConsoleCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
  };

  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] | undefined {
    const diagnostics = context.diagnostics.filter((d) => d.source === DIAGNOSTIC_SOURCE);
    // without a diagnostic, only offer actions on explicit request (Ctrl+.),
    // otherwise every console line would pop a light bulb
    if (!diagnostics.length && context.triggerKind !== vscode.CodeActionTriggerKind.Invoke) {
      return undefined;
    }
    const lines = docLines(doc);
    const blocks = scanConsole(lines, doc.fileName);
    const block = blockAtLine(blocks, range.start.line);
    if (!block) {
      return undefined;
    }
    const related = diagnostics.filter((d) => d.range.start.line === block.line);
    const kind = related.length ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.RefactorRewrite;
    const token = commentTokenFor(doc.fileName);

    const make = (title: string, targets: readonly LogBlock[], mode: BatchMode, preferred = false) => {
      const r = batchEdits(lines, targets, mode, token);
      if (!r.count) {
        return undefined;
      }
      const action = new vscode.CodeAction(title, kind);
      action.edit = new vscode.WorkspaceEdit();
      applyLineEdits(workspaceSink(action.edit, doc.uri), r.edits);
      action.diagnostics = related;
      action.isPreferred = preferred;
      return action;
    };

    const actions = [
      block.commented
        ? make(vscode.l10n.t('Uncomment this console call'), [block], 'uncomment', true)
        : make(vscode.l10n.t('Comment out this console call'), [block], 'comment', true),
      make(vscode.l10n.t('Delete this console call'), [block], 'delete'),
    ];
    if (blocks.length > 1) {
      actions.push(
        make(vscode.l10n.t('Comment out all console calls in this file'), blocks, 'comment'),
        make(vscode.l10n.t('Delete all console calls in this file'), blocks, 'delete')
      );
    }
    return actions.filter((a): a is vscode.CodeAction => a !== undefined);
  }
}

export function registerCodeActions(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [...JS_LANGS].map((language) => ({ language })),
      new ConsoleCodeActionProvider(),
      ConsoleCodeActionProvider.metadata
    )
  );
}
