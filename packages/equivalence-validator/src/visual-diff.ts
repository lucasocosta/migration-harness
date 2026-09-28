import { createHash } from 'node:crypto';
import type { EquivalenceDivergence, SanitizedObservedTrace } from '@migration-harness/core';

/**
 * Optional visual comparison (v1): structural hash + dimensions only. Screenshot
 * bytes stay in private storage; the sanitized trace carries imageSha256/width/height.
 * Pixel-diff (pixelmatch/SSIM) is a later upgrade behind the versioned policy shape.
 */

export interface VisualCheckpoint {
  triggerEventId: string;
  imageSha256: string;
  width: number;
  height: number;
}

export interface VisualCompareOptions {
  severity?: 'WARNING' | 'BLOCKING';
  /** Reserved for a future pixel-diff upgrade; unused by the hash comparator. */
  pixelThreshold?: number;
}

export function visualCheckpoints(trace: SanitizedObservedTrace): VisualCheckpoint[] {
  return trace.events.flatMap(event => (event.type === 'VISUAL_CHECKPOINT'
    ? [{ triggerEventId: event.triggerEventId, imageSha256: event.imageSha256, width: event.width, height: event.height }]
    : []));
}

export function hashImage(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compare visual checkpoints by trigger. A mismatch is an observational difference
 * only — never a formal claim about accessibility or pixel-perfect design systems.
 */
export function compareVisualCheckpoints(
  source: SanitizedObservedTrace,
  target: SanitizedObservedTrace,
  options: VisualCompareOptions = {},
): EquivalenceDivergence[] {
  const severity = options.severity === 'BLOCKING' ? 'BLOCKING' as const : 'WARNING' as const;
  const left = new Map(visualCheckpoints(source).map(item => [item.triggerEventId, item]));
  const right = new Map(visualCheckpoints(target).map(item => [item.triggerEventId, item]));
  const divergences: EquivalenceDivergence[] = [];
  for (const trigger of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(trigger), b = right.get(trigger);
    if (!a || !b) {
      divergences.push({
        divergenceId: `VISUAL_MISSING:${trigger}`,
        scenarioId: source.scenarioId,
        dimension: 'VISUAL',
        code: 'VISUAL_MISMATCH',
        severity,
        message: `VISUAL_MISMATCH at ${trigger} missing-on-${a ? 'target' : 'source'}`,
        source: { triggerEventId: trigger, present: !!a },
        target: { triggerEventId: trigger, present: !!b },
      });
      continue;
    }
    if (a.imageSha256 !== b.imageSha256 || a.width !== b.width || a.height !== b.height) {
      divergences.push({
        divergenceId: `VISUAL_MISMATCH:${trigger}`,
        scenarioId: source.scenarioId,
        dimension: 'VISUAL',
        code: 'VISUAL_MISMATCH',
        severity,
        message: `VISUAL_MISMATCH at ${trigger}`,
        // Structural only: hashes and dimensions, never image bytes.
        source: { triggerEventId: trigger, imageSha256: a.imageSha256, width: a.width, height: a.height },
        target: { triggerEventId: trigger, imageSha256: b.imageSha256, width: b.width, height: b.height },
      });
    }
  }
  return divergences;
}
