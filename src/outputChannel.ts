import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

export function getChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('SonarFix AI');
  }
  return _channel;
}

export function log(msg: string): void {
  getChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err ?? '');
  getChannel().appendLine(`[${new Date().toLocaleTimeString()}] ERROR: ${msg}${detail ? ' — ' + detail : ''}`);
  getChannel().show(true); // reveal panel but don't steal focus
}
