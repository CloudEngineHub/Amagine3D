import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveArtifactPath, scanArtifacts } from '../server/artifacts.ts';
import { isContainedRelativePath } from '../server/path-safety.ts';

test('relative containment rejects parent and Windows cross-volume paths', () => {
  assert.equal(isContainedRelativePath('nested/model.step'), true);
  assert.equal(isContainedRelativePath('nested\\model.step'), true);
  assert.equal(isContainedRelativePath('../outside.step'), false);
  assert.equal(isContainedRelativePath('..\\outside.step'), false);
  assert.equal(isContainedRelativePath('D:\\outside\\model.step'), false);
});

test('discovers supported artifacts and keeps newest files first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-artifacts-'));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'legacy.obj'), 'unsupported model');
    await writeFile(join(root, 'part.py'), 'print("source")');
    await writeFile(join(root, 'canonical_model.mjs'), 'export const size = 10;');
    await writeFile(join(root, 'companion_scene.json'), '{}');
    await writeFile(join(root, 'part.stl'), 'solid part\nendsolid part\n');
    await writeFile(join(root, 'part-display.step'), 'step');
    await writeFile(join(root, 'part-assemble.step'), 'step');
    await writeFile(join(root, '.ignored.json'), '{}');

    const artifacts = await scanArtifacts(root);
    assert.equal(artifacts.length, 6);
    assert.equal(artifacts.find(({ name }) => name === 'part.stl')?.format, 'stl');
    assert.equal(
      artifacts.find(({ name }) => name === 'part-display.step')?.format,
      'step',
    );
    assert.equal(
      artifacts.find(({ name }) => name === 'part-assemble.step')?.format,
      'step',
    );
    assert.equal(artifacts.find(({ name }) => name === 'part.py')?.kind, 'source');
    assert.equal(
      artifacts.find(({ name }) => name === 'canonical_model.mjs')?.kind,
      'source',
    );
    assert.equal(
      artifacts.find(({ name }) => name === 'companion_scene.json')?.kind,
      'source',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('artifact resolution rejects traversal outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-artifact-path-'));
  try {
    await writeFile(join(root, 'inside.stl'), 'solid part\nendsolid part\n');
    assert.equal(
      await resolveArtifactPath(root, '../outside.stl'),
      undefined,
    );
    assert.equal(
      await resolveArtifactPath(root, 'inside.stl'),
      join(await realpath(root), 'inside.stl'),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('historical GLB stays downloadable as an attachment and is never a preview model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-historical-attachment-'));
  try {
    await writeFile(join(root, 'historical.glb'), 'original bytes');
    const [artifact] = await scanArtifacts(root);
    assert.equal(artifact?.kind, 'other');
    assert.equal(artifact?.format, undefined);
    assert.equal(artifact?.legacy, true);
    assert.equal(artifact?.readOnly, true);
    assert.ok(await resolveArtifactPath(root, 'historical.glb'));
  } finally { await rm(root, { force: true, recursive: true }); }
});
