import * as vscode from 'vscode';
import { analyzeCode, SonarIssue } from './analyzer';

export const SONAR_SOURCE = 'sonarjs';

const SUPPORTED = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
]);

export class DiagnosticProvider {
  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  async analyzeDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') return;
    if (!SUPPORTED.has(document.languageId)) return;

    const issues = analyzeCode(document.getText(), document.languageId);
    this.collection.set(document.uri, issues.map((i) => this.toDiagnostic(document, i)));
  }

  private toDiagnostic(document: vscode.TextDocument, issue: SonarIssue): vscode.Diagnostic {
    const startLine = Math.max(0, issue.line - 1);
    const startChar = Math.max(0, issue.column - 1);
    const endLine = issue.endLine != null ? Math.max(0, issue.endLine - 1) : startLine;
    const endChar =
      issue.endColumn != null ? Math.max(0, issue.endColumn - 1) : startChar + 1;

    const range = new vscode.Range(startLine, startChar, endLine, endChar);
    const severity =
      issue.severity === 2
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;

    const diag = new vscode.Diagnostic(range, issue.message, severity);
    diag.source = SONAR_SOURCE;
    diag.code = issue.ruleId;
    return diag;
  }
}
