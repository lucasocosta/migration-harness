/**
 * Canonical bounded reader for the assistant-facing MCP input (the configuration; the retired
 * preparation input is refused by the tool layer, never read here).
 *
 * Thin MCP boundary over the shared public-surface policy
 * (`@migration-harness/core` public-surface, PLAN-V2 §2.2): the policy holds the union of the
 * guarantees (separator normalization, private-marker screening, private-root refusal in
 * lexical and canonical spellings, public-domain recheck at open, dev/ino binding). The MCP
 * channel has no `ArtifactStore`, so it carries no configured roots — the private state root
 * resolved through MIGRATION_HARNESS_STATE_DIR or `privateBaseDir()`'s platform default is
 * always part of the policy. The refusal vocabulary is the stable tool one
 * (`ASSISTANT_CHANNEL_PRIVATE_PATH:<label>`, `INPUT_FILE_*:<label>`), where the label is the
 * tool-argument name; that vocabulary is the second legitimate parameter.
 */
import type { FileHandle } from 'node:fs/promises';
import {
  openValidatedPublicFile, readBoundedPublicJson, resolvePublicTarget, stablePublicRefusals,
  validatePublicFile, type PublicFileIdentity,
} from '@migration-harness/core';

/** No configured roots: the state root and the private markers are the whole MCP private set. */
const CONFIGURED_ROOTS: readonly string[] = [];

/** Check both spellings of the path before any assistant-facing read. */
export async function publicPath(path: string, label: string): Promise<string> {
  return resolvePublicTarget(path, CONFIGURED_ROOTS, stablePublicRefusals, label);
}

/**
 * Validate an assistant-facing file and capture the object identity that the later open must
 * see, so the read is bound to this validated object instead of the unchecked lexical spelling.
 */
export async function publicFile(path: string, label: string): Promise<PublicFileIdentity> {
  return validatePublicFile(path, CONFIGURED_ROOTS, stablePublicRefusals, label);
}

/**
 * Open a validated public file: the canonical spelling is rechecked inside public space and the
 * descriptor must name the captured dev/ino, before any byte is read.
 */
export async function openPublicFile(file: PublicFileIdentity, label: string): Promise<FileHandle> {
  return openValidatedPublicFile(file, stablePublicRefusals, label);
}

/** Bounded single-read JSON input: no symlink leaf, no size bypass, no file content in errors. */
export async function readPublicJson(path: string, label: string, maxBytes = 4_000_000): Promise<unknown> {
  return readBoundedPublicJson(path, CONFIGURED_ROOTS, stablePublicRefusals, label, maxBytes);
}
