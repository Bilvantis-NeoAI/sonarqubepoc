import * as vscode from 'vscode';
import { fixIssueWithCopilot, type FixResult } from './copilotClient';
import { isCopilotAuthenticated } from './copilotAuth';
import type { SonarIssue } from './analyzer';

export type { FixResult } from './copilotClient';

export function fixIssue(
  document: vscode.TextDocument,
  issue: SonarIssue,
  context: vscode.ExtensionContext,
): Promise<FixResult> {
  return fixIssueWithCopilot(document, issue, context);
}

export function isProviderReady(context: vscode.ExtensionContext): Promise<boolean> {
  return isCopilotAuthenticated(context);
}
