import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { acceptArtifactUpdate } from '../src/lib/artifact-updates.ts';

test('rejects duplicate, delayed and different-attempt artifact deliveries', () => {
  const event = { type: 'artifacts' as const, artifacts: [], sessionId: 'session-a', attemptId: 'turn-a', sequence: 2 };
  const cursor = acceptArtifactUpdate(event, { sequence: 0 })!;
  assert.equal(cursor.sequence, 2);
  assert.equal(acceptArtifactUpdate(event, cursor), undefined);
  assert.equal(acceptArtifactUpdate({ ...event, sequence: 1 }, cursor), undefined);
  assert.equal(acceptArtifactUpdate({ ...event, sequence: 3, attemptId: 'turn-b' }, cursor), undefined);
  assert.equal(acceptArtifactUpdate({ ...event, sequence: 3 }, cursor)?.sequence, 3);
});
