import { Linter } from 'eslint';
import * as sonarPlugin from 'eslint-plugin-sonarjs';
import * as tsParser from '@typescript-eslint/parser';
import { log, logError } from './outputChannel';

export interface SonarIssue {
  ruleId: string;
  message: string;
  severity: 1 | 2;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

const LANGUAGE_TO_FILENAME: Record<string, string> = {
  javascript: 'file.js',
  javascriptreact: 'file.jsx',
  typescript: 'file.ts',
  typescriptreact: 'file.tsx',
};

// Single Linter instance reused across all analyses
let _linter: Linter | null = null;

function getLinter(): Linter {
  if (!_linter) {
    _linter = new Linter({ configType: 'flat' } as any);
    log('ESLint Linter initialised (flat-config mode)');
  }
  return _linter;
}

// Build the flat-config array once per language type
const _configs: Record<string, any[]> = {};

function getConfigs(isTypeScript: boolean): any[] {
  const key = isTypeScript ? 'ts' : 'js';
  if (_configs[key]) return _configs[key];

  const plugin = (sonarPlugin as any).default ?? sonarPlugin;
  const recommended = plugin.configs?.recommended ?? {
    plugins: { sonarjs: plugin },
    rules: Object.fromEntries(
      Object.keys(plugin.rules ?? {}).map((r: string) => [`sonarjs/${r}`, 'warn'])
    ),
  };

  const parser = (tsParser as any).default ?? tsParser;
  const langOptions = {
    languageOptions: {
      parser: isTypeScript ? parser : undefined,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
  };

  _configs[key] = [recommended, langOptions];
  log(`Built ${key.toUpperCase()} flat-config`);
  return _configs[key];
}

export function analyzeCode(code: string, languageId: string): SonarIssue[] {
  const filename = LANGUAGE_TO_FILENAME[languageId];
  if (!filename) return [];

  const isTypeScript = languageId === 'typescript' || languageId === 'typescriptreact';

  try {
    const linter = getLinter();
    const configs = getConfigs(isTypeScript);
    const messages = linter.verify(code, configs as any, { filename });

    const issues = messages
      .filter((m) => m.ruleId?.startsWith('sonarjs/'))
      .map((m) => ({
        ruleId: m.ruleId!,
        message: m.message,
        severity: m.severity,
        line: m.line,
        column: m.column,
        endLine: m.endLine,
        endColumn: m.endColumn,
      }));

    log(`Analysed ${filename}: ${issues.length} issue(s) found`);
    return issues;
  } catch (err) {
    logError(`Analysis failed for ${filename}`, err);
    return [];
  }
}
