import * as https from 'node:https';
import * as vscode from 'vscode';
import { getValidSessionToken } from './copilotAuth';
import type { SonarIssue } from './analyzer';

export interface FixResult {
  fixedContent: string;
  explanation: string;
}

const CHAT_HOSTNAME = 'api.githubcopilot.com';
const CHAT_PATH     = '/chat/completions';

const COPILOT_HEADERS: Record<string, string> = {
  'Editor-Version':        'vscode/1.93.1',
  'Editor-Plugin-Version': 'copilot-chat/0.20.3',
  'User-Agent':            'GitHubCopilot/1.155.0',
  'Content-Type':          'application/json',
};

const SYSTEM_PROMPT =
  'You are a senior software engineer specializing in code quality and refactoring. ' +
  'When given a SonarJS issue and the full file content, return a corrected version of the file. ' +
  'Fix only what is necessary to resolve the reported issue without changing unrelated code. ' +
  'Always respond with valid JSON only — no markdown, no code fences, no explanation outside the JSON.';

function buildPrompt(document: vscode.TextDocument, issue: SonarIssue): string {
  const language = document.languageId.replace('react', '');
  const filename  = document.fileName.split('/').pop() ?? document.fileName;
  const endLoc    = issue.endLine ? `–${issue.endLine}` : '';
  return (
    `## SonarJS Issue\n` +
    `- Rule: ${issue.ruleId}\n` +
    `- Message: ${issue.message}\n` +
    `- Location: Line ${issue.line}, Column ${issue.column}${endLoc}\n\n` +
    `## File: ${filename}\n\`\`\`${language}\n${document.getText()}\n\`\`\`\n\n` +
    `Fix the issue. Return ONLY this JSON (no markdown, no wrapping):\n` +
    `{"fixedContent":"<complete fixed file content>","explanation":"<one sentence>"}`
  );
}

function postJson(sessionToken: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CHAT_HOSTNAME,
        port: 443,
        path: CHAT_PATH,
        method: 'POST',
        headers: {
          ...COPILOT_HEADERS,
          Authorization: `Bearer ${sessionToken}`,
          'Content-Length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Copilot API error ${res.statusCode}: ${text.slice(0, 300)}`));
          } else {
            resolve(text);
          }
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(120_000, () => req.destroy(new Error('Copilot request timed out (120 s)')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseFixResult(text: string): FixResult {
  // Direct parse
  try {
    const p = JSON.parse(text.trim());
    if (typeof p.fixedContent === 'string') return p as FixResult;
  } catch { /* fall through */ }

  // Strip markdown code fence if model wrapped it
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) {
    try {
      const p = JSON.parse(fence[1].trim());
      if (typeof p.fixedContent === 'string') return p as FixResult;
    } catch { /* fall through */ }
  }

  // Last resort: grab first {...}
  const brace = /\{[\s\S]*\}/.exec(text);
  if (brace) {
    try {
      const p = JSON.parse(brace[0]);
      if (typeof p.fixedContent === 'string') return p as FixResult;
    } catch { /* fall through */ }
  }

  throw new Error('Could not parse Copilot response as JSON. Try again.');
}

export async function fixIssueWithCopilot(
  document: vscode.TextDocument,
  issue: SonarIssue,
  context: vscode.ExtensionContext,
): Promise<FixResult> {
  const sessionToken = await getValidSessionToken(context);
  const cfg   = vscode.workspace.getConfiguration('sonarfix');
  const model = cfg.get<string>('copilotModel', 'gpt-4o');

  const requestBody = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: buildPrompt(document, issue) },
    ],
    max_tokens:  4096,
    temperature: 0.1,
    stream:      false,
  });

  const rawResponse = await postJson(sessionToken, requestBody);
  const json = JSON.parse(rawResponse) as { choices: Array<{ message: { content: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('Copilot returned an empty response.');
  return parseFixResult(content);
}
