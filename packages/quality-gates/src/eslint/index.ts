import { ESLint } from 'eslint';
import * as parser from '@typescript-eslint/parser';

export interface LintReport { passed: boolean; diagnostics: Array<{ file: string; line: number; ruleId: string | null; severity: number; message: string }>; }

/** Fixed trusted rules: never load an application-provided executable ESLint config. */
export async function lintCandidate(files: Record<string, string>): Promise<LintReport> {
  const eslint = new ESLint({ overrideConfigFile: true, ignore: false, overrideConfig: [{ files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } }, rules: { 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error', 'no-debugger': 'warn' } }] });
  const diagnostics: LintReport['diagnostics'] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!/\.tsx?$/.test(file)) throw new Error('Lint adapter supports TypeScript candidate files only.');
    const results = await eslint.lintText(source, { filePath: file });
    for (const result of results) for (const message of result.messages) diagnostics.push({ file, line: message.line, ruleId: message.ruleId, severity: message.severity, message: message.message });
  }
  return { passed: !diagnostics.some(d => d.severity === 2), diagnostics };
}
