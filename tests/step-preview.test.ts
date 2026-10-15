import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createStepPreview } from '../server/step-preview.ts';
import { parseStepPreview, stepPreviewUrl } from '../src/lib/step-preview.ts';

test('real STEP preview is cached, deduplicated and rejects a stale revision', async () => {
  const root = await mkdtemp(resolve('.agent/step-preview-test-'));
  try {
    const model = join(root, 'model.step');
    await copyFile(resolve('bundled-projects/amagine3d-pomodoro/focus-bar-logical-assembly.step'), model);
    const digest = createHash('sha256').update(await readFile(model)).digest('hex');
    const [first, simultaneous] = await Promise.all([createStepPreview(root, 'model.step', digest), createStepPreview(root, 'model.step', digest)]);
    assert.deepEqual(first, simultaneous);
    const payload = JSON.parse(first.toString('utf8'));
    const scene = parseStepPreview(payload, digest);
    assert.ok(scene.children.length > 0);
    const files = await readdir(join(root, '.step-preview-cache'));
    assert.equal(files.filter((x) => x.endsWith('.json')).length, 1);
    const cached = join(root, '.step-preview-cache', files[0]!);
    const before = (await stat(cached)).mtimeMs;
    assert.deepEqual(await createStepPreview(root, 'model.step', digest), first);
    assert.equal((await stat(cached)).mtimeMs, before);
    assert.equal((await readdir(root)).some((x) => /\.gl(?:b|tf)$/u.test(x)), false);
    await writeFile(model, 'changed');
    await assert.rejects(createStepPreview(root, 'model.step', digest), /revision changed/u);
    await assert.rejects(createStepPreview(root, '../escape.step'), /not found/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('STEP preview URL preserves the artifact scope and revision', () => {
  assert.equal(stepPreviewUrl('/api/sessions/id/artifacts/file?path=parts%2Fbody.step', 'abc'), '/api/sessions/id/artifacts/step-preview?path=parts%2Fbody.step&sha256=abc');
});

test('browser refuses corrupt normals, indices and mismatched STEP provenance', () => {
  const value = { schema: 'a3d-step-preview/v1', units: 'mm', up: 'Z', inputs: { step: { sha256: 'a' } }, objects: [{
    id: 'body', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    appearance: { baseColor: '#112233', metallic: 0, roughness: 0.58 }, metadata: { role: 'manufactured' },
  }] };
  assert.throws(() => parseStepPreview(value, 'b'), /outdated/u);
  const badIndex = structuredClone(value); badIndex.objects[0]!.indices[1] = 99;
  assert.throws(() => parseStepPreview(badIndex), /geometry/u);
  const badNormal = structuredClone(value); badNormal.objects[0]!.normals[2] = 0;
  assert.throws(() => parseStepPreview(badNormal), /normals/u);
});
