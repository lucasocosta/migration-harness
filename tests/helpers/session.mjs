import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical } from '../../packages/core/dist/index.js';
import { write } from './build-workspace.mjs';

/**
 * Shared session-journal helpers (PLAN-V2 §8.2 item 2 — dedup: `journal()`/`digest()` were copied
 * into every file that drives a session without a browser). One implementation, one hash recipe:
 * the journal this writes is the hash-linked attempt history `inspectMigrationSession` validates,
 * so a second copy could silently drift from the format the engine reads.
 */
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const read = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));

/**
 * Record attempts against a session journal: no browser, no run. `durations` decides how many
 * attempts are written, `repeated` makes the candidate hash and the failure fingerprint identical
 * (the STOP_NO_PROGRESS precondition) and `interrupted` leaves the last attempt without a finish
 * (the INTERRUPTED precondition). Everything else mirrors what the harness itself persists.
 */
export async function journal(f, durations, repeated = false, interrupted = false) {
  let previousHash = (await read(f.root, `${f.sessionPath}/session.json`)).hash;
  for (let index = 0; index < durations.length; index++) {
    const prefix = `${f.sessionPath}/attempts/${String(index).padStart(4, '0')}`;
    const start = { index, startedAt: new Date().toISOString(), previousHash,
      candidateHash: digest(repeated ? 'same' : index), remainingMs: f.config.limits.maxDurationMs - durations.slice(0, index).reduce((a, b) => a + b, 0) };
    await write(f.root, `${prefix}.started.json`, JSON.stringify(start));
    if (interrupted && index === durations.length - 1) break;
    const finish = { index, startHash: digest(start), finishedAt: new Date().toISOString(), durationMs: durations[index],
      outcome: 'INCONCLUSIVE', fingerprint: digest('same-error'), candidateHash: start.candidateHash, findings: [], errorCode: 'SYNTHETIC_FAILURE' };
    await write(f.root, `${prefix}.finished.json`, JSON.stringify(finish));
    previousHash = digest(finish);
  }
}
