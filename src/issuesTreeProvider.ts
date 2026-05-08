import * as vscode from 'vscode';
import * as path from 'path';
import type { SonarIssue } from './analyzer';

// ── Tree node types ──────────────────────────────────────────────────────────

export class FileNode extends vscode.TreeItem {
  constructor(
    readonly uri: vscode.Uri,
    readonly issueNodes: IssueNode[],
  ) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri = uri;
    this.description = `${issueNodes.length} issue${issueNodes.length !== 1 ? 's' : ''}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = uri.fsPath;
    this.contextValue = 'sonarFile';
  }
}

export class IssueNode extends vscode.TreeItem {
  constructor(
    readonly diagnostic: vscode.Diagnostic,
    readonly uri: vscode.Uri,
  ) {
    const ruleId = typeof diagnostic.code === 'string' ? diagnostic.code : String(diagnostic.code ?? '');
    const ruleName = ruleId.replace('sonarjs/', '');
    const line = diagnostic.range.start.line + 1;

    super(ruleName, vscode.TreeItemCollapsibleState.None);

    this.description = `line ${line}`;
    this.tooltip = new vscode.MarkdownString(
      `**${ruleId}** (line ${line})\n\n${diagnostic.message}`,
    );
    this.iconPath = new vscode.ThemeIcon(
      diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
    );
    // Clicking the row opens the file at the issue location
    this.command = {
      command: 'vscode.open',
      title: 'Go to issue',
      arguments: [uri, { selection: diagnostic.range } satisfies vscode.TextDocumentShowOptions],
    };
    this.contextValue = 'sonarIssue';
  }
}

class NoIssuesNode extends vscode.TreeItem {
  constructor() {
    super('No issues found', vscode.TreeItemCollapsibleState.None);
    this.description = 'save a JS/TS file to scan';
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

type AnyNode = FileNode | IssueNode | NoIssuesNode;

// ── Provider ─────────────────────────────────────────────────────────────────

export class IssuesTreeProvider implements vscode.TreeDataProvider<AnyNode> {
  private readonly _change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._change.event;

  constructor(private readonly collection: vscode.DiagnosticCollection) {
    // Refresh automatically whenever VS Code's diagnostics change for our source
    vscode.languages.onDidChangeDiagnostics(() => this._change.fire());
  }

  refresh(): void {
    this._change.fire();
  }

  getTreeItem(element: AnyNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AnyNode): AnyNode[] {
    // Second level: issue children of a file node
    if (element instanceof FileNode) return element.issueNodes;

    // Top level: one FileNode per file that has sonarjs diagnostics
    const fileNodes: FileNode[] = [];

    this.collection.forEach((uri, diagnostics) => {
      const sonar = [...diagnostics]
        .filter((d) => d.source === 'sonarjs')
        .sort((a, b) => a.range.start.line - b.range.start.line);

      if (sonar.length > 0) {
        fileNodes.push(new FileNode(uri, sonar.map((d) => new IssueNode(d, uri))));
      }
    });

    if (fileNodes.length === 0) return [new NoIssuesNode()];

    // Sort files by name
    return fileNodes.sort((a, b) =>
      path.basename(a.uri.fsPath).localeCompare(path.basename(b.uri.fsPath)),
    );
  }

  /** Total issue count across all tracked files — used for status bar. */
  totalIssues(): number {
    let count = 0;
    this.collection.forEach((_, diags) => {
      count += [...diags].filter((d) => d.source === 'sonarjs').length;
    });
    return count;
  }
}

// ── Helper: reconstruct SonarIssue from a tree IssueNode ─────────────────────

function ruleIdFromCode(code: vscode.Diagnostic['code']): string {
  if (typeof code === 'string') { return code; }
  if (typeof code === 'number') { return String(code); }
  if (code != null)             { return String((code as { value: string | number }).value); }
  return '';
}

export function issueFromNode(node: IssueNode): SonarIssue {
  return {
    ruleId: ruleIdFromCode(node.diagnostic.code),
    message: node.diagnostic.message,
    severity: node.diagnostic.severity === vscode.DiagnosticSeverity.Error ? 2 : 1,
    line: node.diagnostic.range.start.line + 1,
    column: node.diagnostic.range.start.character + 1,
    endLine: node.diagnostic.range.end.line + 1,
    endColumn: node.diagnostic.range.end.character + 1,
  };
}
