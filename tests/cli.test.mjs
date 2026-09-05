import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { trace, contract } from './helpers.mjs';
import { ArtifactStore } from '../packages/engine/dist/index.js';
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
test('CLI validates flags and artifacts, preserves explicit review and returns divergence exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cli-'));
  const save = async (name, value) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  try {
    const source = await save('source.json', trace()), target = await save('target.json', trace('POST'));
    await assert.rejects(exec(process.execPath, [cli, 'compare', '--source', source, '--target', target]), error => error.code === 4 && error.stdout.includes('NETWORK_METHOD_MISMATCH'));
    await assert.rejects(exec(process.execPath, [cli, 'compare', '--unknown', 'value']), error => error.code === 1);
    const invalid = await save('invalid.json', {});
    await assert.rejects(exec(process.execPath, [cli, 'compare', '--source', invalid, '--target', source]), error => error.code === 1);
    const draft = contract(); draft.status = 'DRAFT'; draft.integrity = { algorithm: 'sha256', contentHash: '' };
    const input = await save('draft.json', draft), review = join(root, 'review.json'), approved = join(root, 'approved.json');
    await exec(process.execPath, [cli, 'review-contract', '--input', input, '--out', review]);
    await exec(process.execPath, [cli, 'approve-contract', '--input', review, '--out', approved, '--approved-by', 'fixture-reviewer']);
    const result = await exec(process.execPath, [cli, 'verify-contract', '--contract', approved]); assert.match(result.stdout, /VALID/);
    await assert.rejects(exec(process.execPath, [cli, 'approve-contract', '--input', review, '--out', approved, '--approved-by', 'fixture-reviewer']), /EEXIST/);
    const raw = trace(); delete raw.sanitization; raw.events[0].headers.authorization = 'secret';
    const rawPath = await save('raw.json', raw), safePath = join(root, 'sanitized.json');
    await exec(process.execPath, [cli, 'sanitize-trace', '--input', rawPath, '--out', safePath, '--artifact-root', root]);
    assert.doesNotMatch(await readFile(safePath, 'utf8'), /secret|person@example.test/);
  } finally {
    await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
