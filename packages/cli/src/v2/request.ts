import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical } from '@migration-harness/core';
import { readPublicJson } from '../assistant-files.js';
import type { ArtifactStore } from '@migration-harness/engine';

/**
 * Structured idempotency (PLAN-V2 §3.1, F2): a request key identifies one normalized operation, and
 * an occupied artifact path is answered with a structured refusal plus explicit nextActions — result
 * reuse stays heuristic-free, so a replay never starts a session, never consumes an attempt and never
 * turns a recorded PASS into a current one (§9.1). `requestKey`/`replayOf` in the envelope are the
 * evidence for that decision; recovering or continuing is always an explicit next action.
 */
export interface RequestIdentity {
  operation: string;
  configurationHash: string;
  workspaceRoot: string;
  artifactPath: string;
}

/** Deterministic identity of one normalized request: same inputs ⇒ same key, across invocations. */
export function requestKeyFor(input: RequestIdentity): string {
  return createHash('sha256').update(canonical({ version: '1', ...input })).digest('hex');
}

export interface ArtifactOccupancy {
  /** Set when the path already holds a record of THIS request (same operation, config and path). */
  replayOf?: string;
  /** The recorded run never produced its preparation: it was interrupted, not completed. */
  interrupted: boolean;
  /** The path is occupied by something this analysis can identify as an operation record. */
  recorded: boolean;
}

/** Classify an occupied artifact path: replay of this request, interruption, or a foreign occupant. */
export async function inspectOccupiedArtifact(
  store: ArtifactStore, directory: string, identity: RequestIdentity,
): Promise<ArtifactOccupancy> {
  const started = await readPublicJson(join(directory, 'started.json'), store, 1_000_000).catch(() => undefined);
  if (!started || typeof started !== 'object' || (started as { kind?: unknown }).kind !== 'MIGRATION_OPERATION_STARTED') {
    return { interrupted: false, recorded: false };
  }
  const recordedHash = (started as { configurationHash?: unknown }).configurationHash;
  const sameRequest = recordedHash === identity.configurationHash;
  const preparation = await readPublicJson(join(directory, 'preparation.json'), store, 1_000_000).catch(() => undefined);
  return {
    ...(sameRequest ? { replayOf: requestKeyFor(identity) } : {}),
    interrupted: preparation === undefined,
    recorded: true,
  };
}
