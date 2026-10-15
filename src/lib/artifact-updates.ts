import type { AgentEvent, ArtifactSummary } from '../types';
import { artifactDesigns } from './artifact-groups';

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

/** Choose a bound preview; failed attempts retain the last usable version. */
export function latestArtifactPreview(artifacts: readonly ArtifactSummary[]): ArtifactSummary | undefined {
  const designs = artifactDesigns(artifacts);
  return designs.find((design) => design.latest.status !== 'diagnostic')?.latest.preview ?? designs[0]?.latest.preview;
}
