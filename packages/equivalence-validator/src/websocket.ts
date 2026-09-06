import { canonical, valueShape, type EquivalenceDivergence, type SanitizedObservedTrace, type WebSocketFrameEvent } from '@migration-harness/core';
import { omitFields } from './network/index.js';

export interface WebSocketComparisonPolicy {
  volatileWebSocketFields?: readonly string[];
}

interface FrameObservation {
  direction: 'sent' | 'received';
  payloadShape: unknown;
}

/**
 * Frames on one WebSocket connection are an ordered protocol exchange: pair frames by
 * connection URL and index within the connection, then compare direction and structural
 * payload shape position-by-position. Reordering WITHIN a connection is therefore a
 * divergence — the same reasoning the review resolution applies to main-frame navigation
 * (REVIEWS.md SF-4): independent requests may reorder, a protocol conversation may not.
 */
export function buildWebSocketFrames(trace: SanitizedObservedTrace, policy: WebSocketComparisonPolicy = {}): Map<string, FrameObservation[]> {
  const connections = new Map<string, FrameObservation[]>();
  for (const event of trace.events) {
    if (event.type !== 'WEBSOCKET_FRAME') continue;
    const frame: FrameObservation = { direction: event.direction, payloadShape: valueShape(omitFields(event.payload, policy.volatileWebSocketFields)) };
    const existing = connections.get(event.url);
    if (existing) existing.push(frame);
    else connections.set(event.url, [frame]);
  }
  return connections;
}

export function compareWebSockets(source: SanitizedObservedTrace, target: SanitizedObservedTrace, policy: WebSocketComparisonPolicy = {}): EquivalenceDivergence[] {
  const left = buildWebSocketFrames(source, policy);
  const right = buildWebSocketFrames(target, policy);
  const divergences: EquivalenceDivergence[] = [];
  const add = (code: string, url: string, index: number, message: string, extra: { source?: unknown; target?: unknown } = {}): void => {
    divergences.push({ divergenceId: `${code}:${divergences.length}`, scenarioId: source.scenarioId, dimension: 'NETWORK', code, severity: 'BLOCKING', message: `${message} (connection ${url} frame ${index})`, ...extra });
  };
  const summary = (frame?: FrameObservation): { direction: string; payloadShape: unknown } | undefined => frame && { direction: frame.direction, payloadShape: frame.payloadShape };
  for (const url of new Set([...left.keys(), ...right.keys()])) {
    const frames = left.get(url) ?? [];
    const other = right.get(url) ?? [];
    for (let index = 0; index < Math.max(frames.length, other.length); index++) {
      const a = frames[index], b = other[index];
      if (!b) { add('WEBSOCKET_FRAME_MISSING', url, index, 'A recorded WebSocket frame is missing in the target.', { source: summary(a) }); continue; }
      if (!a) { add('WEBSOCKET_FRAME_UNEXPECTED', url, index, 'The target emitted an extra WebSocket frame.', { target: summary(b) }); continue; }
      if (a.direction !== b.direction) { add('WEBSOCKET_DIRECTION_MISMATCH', url, index, 'Frame direction differs at the same position within the connection.', { source: a.direction, target: b.direction }); continue; }
      if (canonical(a.payloadShape) !== canonical(b.payloadShape)) add('WEBSOCKET_PAYLOAD_SHAPE_MISMATCH', url, index, `Frame payload shape differs on ${a.direction} frames.`, { source: a.payloadShape, target: b.payloadShape });
    }
  }
  return divergences;
}

export function webSocketFrames(trace: SanitizedObservedTrace): WebSocketFrameEvent[] {
  return trace.events.filter((event): event is WebSocketFrameEvent => event.type === 'WEBSOCKET_FRAME');
}
