import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { scanArtifacts } from '../server/artifacts.ts';
import { readCadRunArtifacts } from '../server/cad-run-evidence.ts';
import { parameterModelsForWorkspace, rebuildModelWithParameters } from '../server/model-parameters.ts';
import { parameterBuildRequestSchema } from '../server/trpc/schemas.ts';
import type { ArtifactSummary } from '../src/types.ts';
import { editableParameterPreviewPath } from '../src/components/cad-workbench/parameterPreview.ts';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CLI = join(PROJECT_ROOT, 'bin', 'a3d.mjs');
const TEMP_ROOT = join(PROJECT_ROOT, 'workspace', '.parameter-analysis', 'tmp');
const PYTHON = process.platform === 'win32'
  ? join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe')
  : join(PROJECT_ROOT, '.venv', 'bin', 'python');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function artifacts(root: string) {
  return [...await scanArtifacts(root), ...await readCadRunArtifacts(root)];
}

test('DSL parameter rebuild preserves a failed revision and can compile a corrected retry', { timeout: 300_000 }, async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEMP_ROOT, 'parameter-rebuild-'));
  try {
    await copyFile(join(PROJECT_ROOT, 'skills/a3d-text/examples/simple_brep_intent.py'), join(root, 'simple_brep_intent.py'));
    await copyFile(join(PROJECT_ROOT, 'skills/a3d-text/examples/bambu-a1-mini-0.4-standard.example.json'), join(root, 'simple_brep_printer-profile.json'));
    await execFileAsync(PYTHON, [join(root, 'simple_brep_intent.py')], {
      cwd: root,
      env: { ...process.env, AMAGINE3D_RUNTIME_DIR: join(PROJECT_ROOT, 'skills/a3d-public'), PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 30_000,
    });
    const design = {
      schema: 'a3d-design/v1', units: { length: 'mm', angle: 'deg' },
      params: { width: { type: 'length', value: 40, range: [39, 41] } },
      frames: { top: { origin: [0, 0, 10], u: [1, 0, 0], normal: [0, 0, 1] } },
      parts: { 'simple-brep': { features: [
        { id: 'blank', op: 'box', size: ['=width', 28, 10], align: ['center', 'center', 'min'] },
        { id: 'round', op: 'fillet', body: '@simple-brep.blank', radius: 2, requirement: 'body',
          edges: { of: '@simple-brep.blank', where: { curve: 'line', parallel: [0, 0, 1] }, expect: { count: 4 } } },
        { id: 'pocket', op: 'hole', body: '@simple-brep.round', radius: 6, requirement: 'pocket', frame: '@frames.top',
          direction: '-normal', depth: { mode: 'blind', length: 6 } },
      ], result: '@simple-brep.pocket' } },
    };
    await writeFile(join(root, 'model.a3d.json'), `${JSON.stringify(design)}\n`);
    const initialRevision = digest(await readFile(join(root, 'model.a3d.json')));
    const initial = JSON.parse((await execFileAsync(process.execPath, [CLI, 'agent', 'build', JSON.stringify({
      phase: 'compile', design: 'model.a3d.json', revision: initialRevision, intent: 'simple_brep_intent.json',
    })], { cwd: root, timeout: 180_000 })).stdout);
    assert.equal(initial.pass, true, JSON.stringify(initial));

    const first = await parameterModelsForWorkspace(root, await artifacts(root));
    const model = first.find((item) => item.revision === initialRevision && item.editable);
    assert.ok(model, 'the current DSL design should expose its declared parameters');
    assert.equal(model.parameters.find((item) => item.id === 'width')?.value, 40);
    const beforePath = model.primaryPreviewPath;
    const beforeStep = model.artifactPaths.find((path) => path.endsWith('.step'));
    assert.ok(beforeStep);
    const beforeStepHash = digest(await readFile(join(root, beforeStep)));

    await assert.rejects(rebuildModelWithParameters({ workspaceRoot: root, request: {
      designPath: model.designPath, revision: model.revision, values: { width: 40.5 },
    } }), (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 422));
    const failedRevision = digest(await readFile(join(root, 'model.a3d.json')));
    assert.notEqual(failedRevision, initialRevision, 'a failed compile keeps the saved DSL edit');
    const refreshed = await parameterModelsForWorkspace(root, await artifacts(root));
    const draft = refreshed.find((item) => item.editable && item.revision === failedRevision);
    assert.ok(draft, 'the current design remains editable after a compile failure');
    assert.equal(editableParameterPreviewPath(refreshed, draft.designPath), draft.displayPreviewPath,
      'the UI selects the current design context after a failed build');
    assert.equal(draft.parameters.find((item) => item.id === 'width')?.value, 40.5);
    assert.equal(draft.buildStatus, 'failed', 'the failed build state remains visible after refresh');

    await rebuildModelWithParameters({ workspaceRoot: root, request: {
      designPath: draft.designPath, revision: draft.revision, values: { width: 40.01 },
    } });
    const finalArtifacts = await artifacts(root);
    const finalRevision = digest(await readFile(join(root, 'model.a3d.json')));
    const finalModels = await parameterModelsForWorkspace(root, finalArtifacts);
    const final = finalModels.find((item) => item.editable && item.revision === finalRevision);
    assert.ok(final, 'the corrected retry produces a current editable build');
    assert.notEqual(final.primaryPreviewPath, beforePath, 'a new design revision receives a new preview path');
    assert.equal(final.previewStale, false);
    assert.equal(final.parameters.find((item) => item.id === 'width')?.value, 40.01);
    const finalStep = final.artifactPaths.find((path) => path.endsWith('.step'));
    assert.ok(finalStep);
    assert.notEqual(digest(await readFile(join(root, finalStep))), beforeStepHash, 'the rebuilt STEP geometry changes');

    await rebuildModelWithParameters({ workspaceRoot: root, request: {
      designPath: final.designPath, revision: final.revision, values: { width: 40 },
    } });
    const revertedRevision = digest(await readFile(join(root, 'model.a3d.json')));
    const reverted = await parameterModelsForWorkspace(root, await artifacts(root));
    assert.ok(reverted.some((item) => item.editable && item.revision === revertedRevision), 'editing back to an earlier value still selects the latest matching build');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DSL parameter reads hide expressions and reject stale revisions, paths, old protocol, and stale intent without writing', async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEMP_ROOT, 'parameter-guards-'));
  try {
    await mkdir(join(root, '.a3d-agent'), { recursive: true });
    const designPath = 'model.a3d.json';
    const design = {
      schema: 'a3d-design/v1', units: { length: 'mm', angle: 'deg' },
      params: {
        free: { type: 'scalar', value: 1.25 },
        derived: { type: 'length', value: '=free * 2' },
      },
      parts: { body: { features: [{ id: 'blank', op: 'box', size: ['=free', 10, 10] }], result: '@body.blank' } },
    };
    const bytes = `${JSON.stringify(design)}\n`;
    const revision = digest(bytes);
    await writeFile(join(root, designPath), bytes);
    await writeFile(join(root, 'intent.json'), '{}\n');
    await writeFile(join(root, '.a3d-agent/design.json'), JSON.stringify({ path: designPath }));
    await writeFile(join(root, '.a3d-agent/state.json'), JSON.stringify({
      schema: 'a3d-agent/v1', activeInput: { kind: 'design', path: designPath },
      activeIntent: { path: 'intent.json', sha256: '0'.repeat(64) },
    }));
    const evidence: ArtifactSummary = {
      kind: 'model', name: 'model.step', path: 'model.step', url: '/model.step', size: 1,
      modifiedAt: new Date().toISOString(), designPath, revision, inputsCurrent: true,
      buildId: 'existing-run', primary: true,
    };
    const [model] = await parameterModelsForWorkspace(root, [evidence]);
    assert.ok(model);
    assert.deepEqual(model.parameters.map(({ id }) => id), ['free']);
    assert.equal(model.parameters[0]?.minimum, undefined);
    assert.equal(model.parameters[0]?.maximum, undefined);

    assert.equal(parameterBuildRequestSchema.safeParse({
      designPath, revision, values: { free: 2 }, sourcePath: 'legacy.py', sourceHash: revision,
    }).success, false, 'the removed Python request shape is not accepted');
    const unchanged = await readFile(join(root, designPath));
    await assert.rejects(rebuildModelWithParameters({ workspaceRoot: root, request: {
      designPath, revision: 'f'.repeat(64), values: { free: 2 },
    } }), /changed|reload/iu);
    await assert.rejects(rebuildModelWithParameters({ workspaceRoot: root, request: {
      designPath: '../outside.a3d.json', revision, values: { free: 2 },
    } }), /changed|reload/iu);
    await assert.rejects(rebuildModelWithParameters({ workspaceRoot: root, request: {
      designPath, revision, values: { free: 2 },
    } }), /intent changed/iu);
    assert.deepEqual(await readFile(join(root, designPath)), unchanged, 'rejected requests leave the design untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
