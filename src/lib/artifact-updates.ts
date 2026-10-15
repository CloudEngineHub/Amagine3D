import type { AgentEvent } from '../types';

export interface ArtifactUpdateCursor { attemptId?: string; sequence: number }

/** A late/duplicate update is ignored even when the session ID is unchanged. */
export function acceptArtifactUpdate(
  event: Extract<AgentEvent, { type: 'artifacts' }>,
  cursor: ArtifactUpdateCursor,
): ArtifactUpdateCursor | undefined {
  if (cursor.attemptId && event.attemptId !== cursor.attemptId) return undefined;
  if (event.sequence !== undefined && (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor.sequence)) return undefined;
  return { attemptId: event.attemptId ?? cursor.attemptId, sequence: event.sequence ?? cursor.sequence + 1 };
}
