import test from 'node:test';
import assert from 'node:assert/strict';
import { lintCandidate } from '../packages/quality-gates/dist/index.js';

test('trusted ESLint configuration accepts TSX and reports dynamic execution and debugger', async () => {
  assert.equal((await lintCandidate({ 'candidate.tsx': 'export const view = <button>Save</button>;' })).passed, true);
  const result = await lintCandidate({ 'candidate.tsx': 'export function run(value: string) { debugger; eval(value); }' });
  assert.equal(result.passed, false); assert.ok(result.diagnostics.some(d => d.ruleId === 'no-eval')); assert.ok(result.diagnostics.some(d => d.ruleId === 'no-debugger' && d.severity === 1));
});
