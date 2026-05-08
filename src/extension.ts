import * as vscode from 'vscode';
import { DiagnosticProvider } from './diagnosticProvider';
import { SonarFixCodeActionProvider } from './codeActionProvider';
import { IssuesTreeProvider, IssueNode, issueFromNode } from './issuesTreeProvider';
import { startCopilotAuth, signOutCopilot, isCopilotAuthenticated } from './copilotAuth';
import { getChannel, log } from './outputChannel';
import { fixIssue, isProviderReady } from './llmClient';

const SUPPORTED_LANGUAGES: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'javascriptreact' },
  { language: 'typescript' },
  { language: 'typescriptreact' },
];

export function activate(context: vscode.ExtensionContext): void {
  log('SonarFix AI activating…');

  const diagnosticCollection = vscode.languages.createDiagnosticCollection('sonarjs');
  const diagnosticProvider   = new DiagnosticProvider(diagnosticCollection);
  const treeProvider         = new IssuesTreeProvider(diagnosticCollection);
  const _codeActionProvider  = new SonarFixCodeActionProvider(context);

  // Sidebar tree view
  const treeView = vscode.window.createTreeView('sonarfix.issuesView', {
    treeDataProvider: treeProvider,
    showCollapseAll:  true,
  });

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'sonarfix.analyzeFile';
  statusBar.tooltip = 'SonarFix AI — click to re-analyse current file';

  function updateStatusBar(): void {
    const n = treeProvider.totalIssues();
    statusBar.text = n > 0 ? `$(shield) SonarFix $(warning) ${n}` : `$(shield) SonarFix $(check)`;
    statusBar.show();
  }
  updateStatusBar();
  vscode.languages.onDidChangeDiagnostics(() => updateStatusBar());

  async function analyseDoc(doc: vscode.TextDocument): Promise<void> {
    await diagnosticProvider.analyzeDocument(doc);
    treeProvider.refresh();
    updateStatusBar();
  }

  context.subscriptions.push(
    diagnosticCollection,
    treeView,
    statusBar,
    getChannel(),

    vscode.languages.registerCodeActionsProvider(SUPPORTED_LANGUAGES, _codeActionProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),

    // Analyse active file
    vscode.commands.registerCommand('sonarfix.analyzeFile', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) { return; }
      statusBar.text = '$(sync~spin) SonarFix';
      await analyseDoc(doc);
    }),

    // Analyse all open files (sidebar refresh button)
    vscode.commands.registerCommand('sonarfix.analyzeAll', async () => {
      statusBar.text = '$(sync~spin) SonarFix';
      for (const doc of vscode.workspace.textDocuments) {
        await analyseDoc(doc);
      }
    }),

    // Copilot sign-in
    vscode.commands.registerCommand('sonarfix.copilotSignIn',
      () => startCopilotAuth(context)),

    // Copilot sign-out
    vscode.commands.registerCommand('sonarfix.copilotSignOut', async () => {
      await signOutCopilot(context);
      vscode.window.showInformationMessage('SonarFix: Signed out of GitHub Copilot.');
    }),

    // Copilot status
    vscode.commands.registerCommand('sonarfix.copilotStatus', async () => {
      const authed = await isCopilotAuthenticated(context);
      vscode.window.showInformationMessage(
        authed ? 'SonarFix: GitHub Copilot — signed in ✓'
                : 'SonarFix: Not signed in — run "SonarFix: Sign in with GitHub Copilot".',
      );
    }),

    // Fix from sidebar tree item (IssueNode passed by VS Code)
    vscode.commands.registerCommand('sonarfix.fixIssueFromTree', async (node: IssueNode) => {
      if (!(node instanceof IssueNode)) { return; }

      const ready = await isProviderReady(context);
      if (!ready) {
        const btn = await vscode.window.showWarningMessage(
          'SonarFix: Sign in to GitHub Copilot first.',
          'Sign In',
        );
        if (btn === 'Sign In') { await vscode.commands.executeCommand('sonarfix.copilotSignIn'); }
        return;
      }

      const document = await vscode.workspace.openTextDocument(node.uri);
      const issue    = issueFromNode(node);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification,
          title: `SonarFix: Fixing ${issue.ruleId.replace('sonarjs/', '')}…`,
          cancellable: false },
        async () => {
          try {
            const result = await fixIssue(document, issue, context);
            const edit   = new vscode.WorkspaceEdit();
            edit.replace(
              node.uri,
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
    }),

    // Show output log
    vscode.commands.registerCommand('sonarfix.showOutput', () => getChannel().show()),

    // File lifecycle
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const cfg = vscode.workspace.getConfiguration('sonarfix');
      if (!cfg.get<boolean>('enableOnSave', true)) { return; }
      statusBar.text = '$(sync~spin) SonarFix';
      await analyseDoc(doc);
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => analyseDoc(doc)),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnosticCollection.delete(doc.uri);
      treeProvider.refresh();
    }),
  );

  // Analyse all already-open documents on startup
  for (const doc of vscode.workspace.textDocuments) {
    analyseDoc(doc);
  }

  log('SonarFix AI activated.');
}

export function deactivate(): void { /* disposables cleaned up automatically */ }
