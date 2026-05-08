/**
 * GitHub Copilot Device Code OAuth + session token management.
 * Uses Node.js built-in `https` module — guaranteed available in VS Code extension host.
 *
 * Flow:
 *   1. getDeviceCode()        → { device_code, user_code, verification_uri, interval }
 *   2. pollForAccessToken()   → long-lived GitHub OAuth access_token
 *   3. fetchSessionToken()    → short-lived Copilot session_token (~30 min)
 *   4. getValidSessionToken() → returns cached token, auto-refreshes when near expiry
 */

import * as https from 'node:https';
import * as vscode from 'vscode';
import { log, logError } from './outputChannel';

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_ID         = 'iv1.b507a08c87ecfe98';
const DEVICE_CODE_HOST  = 'github.com';
const DEVICE_CODE_PATH  = '/login/device/code';
const ACCESS_TOKEN_HOST = 'github.com';
const ACCESS_TOKEN_PATH = '/login/oauth/access_token';
const SESSION_TOKEN_HOST = 'api.github.com';
const SESSION_TOKEN_PATH = '/copilot_internal/v2/token';

const BASE_HEADERS: Record<string, string> = {
  'Accept':               'application/json',
  'Editor-Version':       'vscode/1.93.1',
  'Editor-Plugin-Version':'copilot-chat/0.20.3',
  'User-Agent':           'GitHubCopilot/1.155.0',
};

const KEY_ACCESS_TOKEN  = 'sonarfix.copilotAccessToken';
const KEY_SESSION_TOKEN = 'sonarfix.copilotSessionToken';

// ── Low-level HTTPS helper ────────────────────────────────────────────────────

interface HttpResponse { status: number; body: string; }

function httpsRequest(
  hostname: string,
  path: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const allHeaders: Record<string, string> = { ...headers };
    if (body) allHeaders['Content-Length'] = String(Buffer.byteLength(body));

    const req = https.request(
      { hostname, port: 443, path, method, headers: allHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      },
    );

    req.setTimeout(30_000, () => req.destroy(new Error('Request timed out (30 s)')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiGet<T>(hostname: string, path: string, authToken: string): Promise<T> {
  const { status, body } = await httpsRequest(hostname, path, 'GET', {
    ...BASE_HEADERS,
    Authorization: `Bearer ${authToken}`,
  });
  const json = JSON.parse(body);
  if (status !== 200) throw new Error(`HTTP ${status}: ${body.slice(0, 300)}`);
  return json as T;
}

async function apiPost<T>(
  hostname: string,
  path: string,
  formBody: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const encoded = new URLSearchParams(formBody).toString();
  const { status, body } = await httpsRequest(hostname, path, 'POST', {
    ...BASE_HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded',
    ...extraHeaders,
  }, encoded);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function parseTokenExpiry(token: string): number {
  for (const part of token.split(';')) {
    if (part.trim().startsWith('exp=')) {
      return Number.parseInt(part.split('=')[1], 10) || 0;
    }
  }
  return 0;
}

function isTokenExpired(token: string): boolean {
  const exp = parseTokenExpiry(token);
  return exp === 0 || Math.floor(Date.now() / 1000) >= exp - 60;
}

// ── Step 1: Device Code ───────────────────────────────────────────────────────

interface DeviceCodeData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function getDeviceCode(): Promise<DeviceCodeData> {
  const data = await apiPost<DeviceCodeData>(DEVICE_CODE_HOST, DEVICE_CODE_PATH, {
    client_id: CLIENT_ID,
    scope: 'read:user user:email',
  });
  if (!data.device_code) {
    throw new Error(`GitHub did not return a device code. Response: ${JSON.stringify(data)}`);
  }
  log(`Device code obtained. User code: ${data.user_code}`);
  return data;
}

// ── Step 2: Poll for Access Token ─────────────────────────────────────────────

interface PollResult {
  access_token?: string;
  error?: string;
}

async function tryPollToken(deviceCode: string): Promise<PollResult> {
  try {
    return await apiPost<PollResult>(ACCESS_TOKEN_HOST, ACCESS_TOKEN_PATH, {
      client_id:    CLIENT_ID,
      device_code:  deviceCode,
      grant_type:   'urn:ietf:params:oauth:grant-type:device_code',
    });
  } catch (err) {
    logError('Poll attempt failed', err);
    return { error: 'network_error' };
  }
}

async function pollForAccessToken(
  deviceCode: string,
  intervalSeconds: number,
  ct: vscode.CancellationToken,
): Promise<string> {
  let waitMs = Math.max(intervalSeconds, 5) * 1000;

  while (!ct.isCancellationRequested) {
    await new Promise((r) => setTimeout(r, waitMs));

    const result = await tryPollToken(deviceCode);
    log(`Poll result: ${JSON.stringify(result)}`);

    if (result.access_token) return result.access_token;

    switch (result.error) {
      case 'slow_down':         waitMs += 5000; break;
      case 'expired_token':     throw new Error('Device code expired — please run Sign In again.');
      case 'access_denied':     throw new Error('Access denied by GitHub.');
      case 'authorization_pending':
      case 'network_error':     break; // keep polling
      default:
        if (result.error) throw new Error(`GitHub error: ${result.error}`);
    }
  }
  throw new Error('Sign-in cancelled.');
}

// ── Step 3: Session Token ─────────────────────────────────────────────────────

export async function fetchSessionToken(accessToken: string): Promise<string> {
  const data = await apiGet<{ token?: string }>(SESSION_TOKEN_HOST, SESSION_TOKEN_PATH, accessToken);
  if (!data.token) {
    throw new Error(`Copilot session token missing in response: ${JSON.stringify(data)}`);
  }
  log('Copilot session token obtained.');
  return data.token;
}

// ── Step 4: Get Valid Session (auto-refresh) ──────────────────────────────────

export async function getValidSessionToken(context: vscode.ExtensionContext): Promise<string> {
  const stored = await context.secrets.get(KEY_SESSION_TOKEN);

  if (stored && !isTokenExpired(stored)) {
    return stored;
  }

  const accessToken = await context.secrets.get(KEY_ACCESS_TOKEN);
  if (!accessToken) {
    throw new Error('Not signed in to GitHub Copilot. Run "SonarFix: Sign in with GitHub Copilot".');
  }

  log('Session token expired — refreshing…');
  const newSession = await fetchSessionToken(accessToken);
  await context.secrets.store(KEY_SESSION_TOKEN, newSession);
  return newSession;
}

// ── Public helpers ────────────────────────────────────────────────────────────

export async function isCopilotAuthenticated(context: vscode.ExtensionContext): Promise<boolean> {
  return !!(await context.secrets.get(KEY_ACCESS_TOKEN));
}

export async function signOutCopilot(context: vscode.ExtensionContext): Promise<void> {
  await Promise.all([
    context.secrets.delete(KEY_ACCESS_TOKEN),
    context.secrets.delete(KEY_SESSION_TOKEN),
  ]);
  log('Signed out of GitHub Copilot.');
}

// ── Full sign-in flow with VS Code UI ─────────────────────────────────────────

export async function startCopilotAuth(context: vscode.ExtensionContext): Promise<void> {
  log('Starting GitHub Copilot sign-in…');

  let deviceData: DeviceCodeData;
  try {
    deviceData = await getDeviceCode();
  } catch (err: any) {
    logError('getDeviceCode failed', err);
    vscode.window.showErrorMessage(`SonarFix: Failed to contact GitHub — ${err.message}`);
    return;
  }

  const { device_code, user_code, verification_uri, interval } = deviceData;

  // Copy code to clipboard and open browser
  await vscode.env.clipboard.writeText(user_code);
  await vscode.env.openExternal(vscode.Uri.parse(verification_uri));

  let accessToken: string | undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `SonarFix — Enter code  ${user_code}  at ${verification_uri}  (copied to clipboard)`,
      cancellable: true,
    },
    async (_progress, ct) => {
      try {
        accessToken = await pollForAccessToken(device_code, interval ?? 5, ct);
      } catch (err: any) {
        logError('Polling failed', err);
        vscode.window.showErrorMessage(`SonarFix: ${err.message}`);
      }
    },
  );

  if (!accessToken) return;

  try {
    const sessionToken = await fetchSessionToken(accessToken);
    await context.secrets.store(KEY_ACCESS_TOKEN, accessToken);
    await context.secrets.store(KEY_SESSION_TOKEN, sessionToken);
    vscode.window.showInformationMessage('SonarFix: Signed in to GitHub Copilot ✓');
    log('Sign-in complete.');
  } catch (err: any) {
    logError('fetchSessionToken failed', err);
    vscode.window.showErrorMessage(`SonarFix: Could not get Copilot session — ${err.message}`);
  }
}
