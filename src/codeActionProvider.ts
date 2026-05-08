import * as vscode from 'vscode';
import { SONAR_SOURCE } from './diagnosticProvider';
import { fixIssue, isProviderReady } from './llmClient';
import type { SonarIssue } from './analyzer';

export class SonarFixCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'sonarfix.fixWithAI',
        (docUri: vscode.Uri, issue: SonarIssue) => this.applyFix(docUri, issue),
      ),
    );
  }

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter((d) => d.source === SONAR_SOURCE)
      .map((diag) => {
        const issue = this.issueFromDiagnostic(diag);
        const action = new vscode.CodeAction(
          `$(sparkle) Fix with AI: ${issue.ruleId.replace('sonarjs/', '')}`,
          vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diag];
        action.isPreferred = true;
        action.command = {
          command: 'sonarfix.fixWithAI',
          title: 'Fix with AI',
          arguments: [document.uri, issue],
        };
        return action;
      });
  }

  private ruleIdFromCode(code: vscode.Diagnostic['code']): string {
    if (typeof code === 'string') { return code; }
    if (typeof code === 'number') { return String(code); }
    if (code != null)             { return String((code as { value: string | number }).value); }
    return '';
  }

  private issueFromDiagnostic(diag: vscode.Diagnostic): SonarIssue {
    return {
      ruleId:    this.ruleIdFromCode(diag.code),
      message:   diag.message,
      severity:  diag.severity === vscode.DiagnosticSeverity.Error ? 2 : 1,
      line:      diag.range.start.line + 1,
      column:    diag.range.start.character + 1,
      endLine:   diag.range.end.line + 1,
      endColumn: diag.range.end.character + 1,
    };
  }

  private async applyFix(docUri: vscode.Uri, issue: SonarIssue): Promise<void> {
    const ready = await isProviderReady(this.context);
    if (!ready) {
      const btn = await vscode.window.showWarningMessage(
        'SonarFix: Sign in to GitHub Copilot first.',
        'Sign In',
      );
      if (btn === 'Sign In') {
        await vscode.commands.executeCommand('sonarfix.copilotSignIn');
      }
      return;
    }

    const document = await vscode.workspace.openTextDocument(docUri);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SonarFix: Fixing ${issue.ruleId.replace('sonarjs/', '')}…`,
        cancellable: false,
      },
      async () => {
        try {
          const result = await fixIssue(document, issue, this.context);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            docUri,
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            result.fixedContent,
          );
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(`SonarFix: ${result.explanation}`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`SonarFix: ${err.message}`);
        }
      },
    );
  }
}
