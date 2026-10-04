import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ArtifactStore, safeArtifactPath } from '@migration-harness/engine';
import {
  openValidatedPublicFile, readBoundedPublicJson, resolvePublicTarget, validatePublicFile,
  type PublicFileIdentity, type PublicSurfaceRefusals,
} from '@migration-harness/core';

/**
 * Thin CLI boundary over the shared public-surface policy (PLAN-V2 §2.2). The policy holds the
 * union of the guarantees (separator normalization, private-marker screening, private-root
 * refusal in lexical and canonical spellings, public-domain recheck at open, dev/ino binding);
 * this file only supplies what is legitimately CLI-specific:
 *  - the configured store roots (private/keys/backup) the MCP channel has no store to carry;
 *  - the CLI refusal vocabulary, preserving the prose the v2 envelope catalogues. `privatePath`
 *    keeps the "private artifact domain" phrasing that `cli/errors.ts` maps to PRIVATE_PATH_REFUSED.
 */
function storePrivateRoots(store: ArtifactStore): string[] {
  return [
    store.privateRoot,
    store.keysRoot,
    ...(store.options.backup ? [resolve(store.options.backup.root)] : []),
  ];
}

const CLI_LABEL = 'assistant-path';

const cliRefusals: PublicSurfaceRefusals = {
  privatePath: () => new Error('Assistant-facing paths cannot resolve inside the private artifact domain.'),
  // The CLI envelope maps raw errno to the catalogued codes (errors.ts ERRNO_CODES), so the
  // boundary rethrows the original error instead of duplicating that vocabulary here.
  missing: (_label, cause) => cause as Error,
  unreadable: (_label, cause) => cause as Error,
  symlink: (_label, cause) => cause as Error,
  changed: () => new Error('Assistant-facing path changed during access.'),
  invalidFile: () => new Error('Input exceeds the size cap or is not a regular file.'),
  sizeExceeded: () => new Error('Input exceeds the size cap.'),
  notJson: (_label, cause) => cause as Error,
};

/** Check both lexical and resolved paths before reading any assistant-facing input. */
export async function publicPath(path: string, store: ArtifactStore): Promise<string> {
  return resolvePublicTarget(path, storePrivateRoots(store), cliRefusals, CLI_LABEL);
}

/** Identity of a validated public file: canonical spelling, dev/ino and captured configured roots. */
export type PublicFile = PublicFileIdentity;

/**
 * Validate an assistant-facing file and capture the object identity that the later open must see,
 * so the read is bound to this validated object instead of the unchecked lexical spelling.
 */
export async function publicFile(path: string, store: ArtifactStore): Promise<PublicFile> {
  return validatePublicFile(path, storePrivateRoots(store), cliRefusals, CLI_LABEL);
}

/**
 * Open a validated public file: the canonical spelling is rechecked against the private roots and
 * the descriptor must name the captured dev/ino, so an ancestor swapped for a symlink or a
 * replaced leaf between validation and open is refused before any byte is read.
 */
export async function openPublicFile(file: PublicFile): Promise<FileHandle> {
  return openValidatedPublicFile(file, cliRefusals, CLI_LABEL);
}

export async function readPublicJson(path: string, store: ArtifactStore, maxBytes = 4_000_000): Promise<unknown> {
  return readBoundedPublicJson(path, storePrivateRoots(store), cliRefusals, CLI_LABEL, maxBytes);
}

export async function withAssistantLock<T>(store: ArtifactStore, candidateRoot: string, work: () => Promise<T>): Promise<T> {
  const locks = [...new Set([resolve(store.root, '.harness-assistant.lock'), resolve(candidateRoot, '.harness-assistant.lock')])].sort();
  const held: string[] = [];
  try {
    for (const lock of locks) {
      await publicPath(lock, store);
      await safeArtifactPath(dirname(lock), '.harness-assistant.lock');
      await mkdir(dirname(lock), { recursive: true });
      const handle = await open(lock, 'wx'); await handle.close(); held.push(lock);
    }
    return await work();
  } finally { for (const lock of held.reverse()) await unlink(lock); }
}
