import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { unzipSync } from 'fflate';

import { moveSessionsToTrash } from '../server/session-trash.ts';
import {
  appendSessionAssistantTurn,
  appendSessionUserMessage,
  listSessionCatalog,
  readSessionMessages,
  readSessionThreadId,
  sessionCadSystem,
  setSessionThreadId,
  sessionWorkspaceRoot,
  userSessionArtifacts,
} from '../server/sessions.ts';
import { writeUnifiedBuildFixture } from './unified-build-fixture.ts';
import { fileSectionArtifacts, printableArtifact } from '../src/lib/artifact-selection.ts';
import { artifactDesigns } from '../src/lib/artifact-groups.ts';
import {
  completeChatTurn,
  emptyChatTurn,
  restoreChatTurn,
  startChatStep,
  turnAccounting,
} from '../src/lib/chat-turn.ts';
import type { ChatMessage } from '../src/types.ts';
import { createArtifactArchive } from '../server/artifact-archive.ts';
import { parameterModelsForWorkspace } from '../server/model-parameters.ts';

const SESSION_ID = '3b0d4f25-1707-4cc8-92cf-6f5c28edfc93';

test('legacy STEP uses an explicit read-only adapter while a GLB-only result stays an attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-old-step-'));
  try {
    const workspace = sessionWorkspaceRoot(root, SESSION_ID)!;
    await mkdir(workspace, { recursive: true });
    await writeUnifiedBuildFixture({ root: workspace, name: 'old', backend: 'brep-part', schema: 'evidence-a3d-build/v1' });
    await writeFile(join(workspace, 'only.glb'), 'unchanged historical attachment');
    const collection = await userSessionArtifacts(root, SESSION_ID);
    const step = collection!.artifacts.find((artifact) => artifact.path === 'old.step');
    assert.equal(step?.legacy, true);
    assert.equal(step?.readOnly, true);
    assert.equal(step?.status, 'diagnostic');
    const old = collection!.artifacts.find((artifact) => artifact.path === 'only.glb');
    assert.equal(old?.kind, 'other');
    assert.equal(old?.format, undefined);
    assert.ok(fileSectionArtifacts(collection!.artifacts).includes(old!));
    assert.deepEqual(await parameterModelsForWorkspace(workspace, []), []);
    await rm(join(workspace, 'old.py'));
    await rm(join(workspace, 'old.stl'));
    const recovered = await userSessionArtifacts(root, SESSION_ID);
    assert.equal(recovered!.artifacts.find((artifact) => artifact.path === 'old.step')?.legacy, true);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('discovers revision-scoped design outputs and classifies the design as editable source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-design-artifacts-'));
  try {
    const workspace = sessionWorkspaceRoot(root, SESSION_ID)!;
    const output = join(workspace, 'design-builds', 'revision');
    await mkdir(output, { recursive: true });
    await writeFile(join(workspace, 'model.a3d.json'), '{}');
    await writeUnifiedBuildFixture({ backend: 'brep-part', name: 'body', root: output });
    const collection = await userSessionArtifacts(root, SESSION_ID);
    assert.equal(collection?.artifacts.find(({ path }) => path === 'model.a3d.json')?.kind, 'source');
    assert.ok(collection?.artifacts.some(({ path, featured }) => path === 'design-builds/revision/body-display.step' && featured));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('shows CAD master, display and plate files from the current validated report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-plate-files-'));
  try {
    const workspace = sessionWorkspaceRoot(root, SESSION_ID)!;
    await mkdir(workspace, { recursive: true });
    await writeUnifiedBuildFixture({ backend: 'brep-assembly', name: 'pair', root: workspace,
      parts: ['left', 'right'], plateParts: [['left'], ['right']] });
    const collection = await userSessionArtifacts(root, SESSION_ID);
    const visible = fileSectionArtifacts(collection!.artifacts);
    assert.deepEqual(visible.map(({ path }) => path), [
      'pair-display.step', 'pair-assemble.step', 'pair-plate-01.3mf', 'pair-plate-01.stl', 'pair-plate-02.3mf', 'pair-plate-02.stl',
    ]);
    assert.deepEqual(visible.map(({ plateId }) => plateId), [undefined, undefined, '01', '01', '02', '02']);
    assert.ok(visible.every(({ buildId, modelId }) => buildId && modelId === 'pair'));
    assert.ok(collection!.artifacts.some(({ path, primary }) => path === 'pair-left.stl' && !primary));
    const designs = artifactDesigns(collection!.artifacts);
    assert.equal(designs.length, 1);
    assert.deepEqual(designs[0]?.latest.parts.map((part) => part.id), ['left', 'right']);
    assert.ok(designs[0]?.latest.parts.every((part) => part.artifacts.length === 2));
    assert.equal(designs[0]?.latest.plates.length, 2);
    const download = await createArtifactArchive(workspace, visible.map(({ path }) => path));
    assert.ok(download);
    assert.deepEqual(Object.keys(unzipSync(download)).sort(), visible.map(({ path }) => path).sort());
    await writeUnifiedBuildFixture({ backend: 'brep-assembly', colored: true, name: 'pair', root: workspace, parts: ['left', 'right'] });
    const rebuilt = await userSessionArtifacts(root, SESSION_ID);
    assert.deepEqual(fileSectionArtifacts(rebuilt!.artifacts).map(({ path }) => path), ['pair-display.step', 'pair-assemble.step', 'pair.3mf', 'pair.stl']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('failed and stale plate outputs stay out of session print selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-stale-plates-'));
  try {
    const workspace = sessionWorkspaceRoot(root, SESSION_ID)!;
    await mkdir(workspace, { recursive: true });
    const fixture = await writeUnifiedBuildFixture({ backend: 'brep-assembly', name: 'pair', root: workspace,
      parts: ['left', 'right'], plateParts: [['left'], ['right']] });
    const source = join(workspace, 'build.py');
    await writeFile(source, '# source');
    const bind = async (path: string) => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    const inputs = { source: await bind(source) };
    const reportPath = join(workspace, 'compile-result.json');
    const statePath = join(workspace, '.a3d-agent', 'state.json');
    await mkdir(join(workspace, '.a3d-agent'), { recursive: true });
    const writeRun = async (status: 'failed' | 'awaiting-visual-review', pass: boolean) => {
      await writeFile(reportPath, JSON.stringify({ schema: 'evidence-cad-compile-result/v2', runId: 'plate-run', status, pass,
        inputBindings: inputs, artifacts: fixture.report.artifacts }));
      const reference = await bind(reportPath);
      const run = { report: reference, inputs };
      await writeFile(statePath, JSON.stringify({ schema: 'a3d-agent/v1', latest: run, runs: [run] }));
    };
    await writeRun('failed', false);
    let collection = await userSessionArtifacts(root, SESSION_ID);
    let plates = collection!.artifacts.filter((item) => item.path.includes('plate-'));
    assert.equal(plates.length, 4);
    assert.ok(plates.every((item) => item.purpose === 'internal-evidence' && !printableArtifact(item)));

    await writeRun('awaiting-visual-review', true);
    await writeFile(source, '# changed');
    collection = await userSessionArtifacts(root, SESSION_ID);
    plates = collection!.artifacts.filter((item) => item.path.includes('plate-'));
    assert.equal(plates.length, 4);
    assert.ok(plates.every((item) => item.inputsCurrent === false && item.purpose === 'internal-evidence' && !printableArtifact(item)));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('persists product messages and the Codex thread id without legacy agent history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-codex-session-'));
  const sessionRoot = join(root, 'sessions');
  try {
    await appendSessionUserMessage(sessionRoot, SESSION_ID, '生成一个桌面支架');
    await setSessionThreadId(sessionRoot, SESSION_ID, 'codex-thread-1');
    await appendSessionAssistantTurn(sessionRoot, SESSION_ID, {
      finishedAt: Date.now(),
      replyText: '模型已经生成。',
      startedAt: Date.now() - 2,
      steps: [
        {
          id: 'step-1',
          label: '正在执行工作区命令',
          occurredAt: Date.now() - 1,
          stage: 'command',
          status: 'completed',
        },
      ],
    });

    const catalog = await listSessionCatalog(sessionRoot);
    assert.equal(catalog.initialSessionId, SESSION_ID);
    assert.equal(catalog.sessions[0]?.title, '生成一个桌面支架');
    assert.equal(catalog.sessions[0]?.cadSystem, 'a3d-text');
    assert.equal(await sessionCadSystem(sessionRoot, SESSION_ID), 'a3d-text');
    assert.equal(await readSessionThreadId(sessionRoot, SESSION_ID), 'codex-thread-1');
    const messages = await readSessionMessages(join(sessionRoot, `${SESSION_ID}.json`));
    assert.deepEqual(messages.map(({ role }) => role), ['user', 'assistant']);
    await assert.rejects(
      sessionCadSystem(sessionRoot, SESSION_ID, 'a3d-blender' as 'a3d-text'),
      /different CAD system/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('legacy sessions without cadSystem keep the default and reject switching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-legacy-cad-system-'));
  const sessionRoot = join(root, 'sessions');
  try {
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      join(sessionRoot, `${SESSION_ID}.json`),
      `${JSON.stringify(
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          id: SESSION_ID,
          messages: [
            { id: 'msg-1', role: 'user', text: 'legacy without cadSystem' },
          ],
          updatedAt: '2026-01-01T00:00:00.000Z',
          version: 1,
        },
        null,
        2,
      )}\n`,
    );

    assert.equal(await sessionCadSystem(sessionRoot, SESSION_ID), 'a3d-text');
    await assert.rejects(
      sessionCadSystem(sessionRoot, SESSION_ID, 'a3d-blender' as 'a3d-text'),
      /different CAD system/u,
    );
    await assert.rejects(
      appendSessionUserMessage(
        sessionRoot,
        SESSION_ID,
        'try switch',
        'a3d-blender' as 'a3d-text',
      ),
      /already uses a different CAD system/u,
    );

    await appendSessionUserMessage(sessionRoot, SESSION_ID, 'still default');
    const messages = await readSessionMessages(
      join(sessionRoot, `${SESSION_ID}.json`),
    );
    assert.deepEqual(
      messages.map(({ role }) => role),
      ['user', 'user'],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('trashes session metadata, workspace, and isolated Codex state together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-codex-trash-'));
  const sessionRoot = join(root, 'state', 'sessions');
  const workspaceRoot = join(root, 'workspace');
  const workspace = sessionWorkspaceRoot(workspaceRoot, SESSION_ID)!;
  const codexState = join(dirname(sessionRoot), 'codex', SESSION_ID);
  try {
    await appendSessionUserMessage(sessionRoot, SESSION_ID, 'test');
    await mkdir(workspace, { recursive: true });
    await mkdir(codexState, { recursive: true });
    let moved: string[] = [];
    const count = await moveSessionsToTrash(
      sessionRoot,
      workspaceRoot,
      [SESSION_ID],
      async (paths) => {
        moved = paths;
      },
    );
    assert.equal(count, 1);
    assert.deepEqual(
      new Set(moved),
      new Set([join(sessionRoot, `${SESSION_ID}.json`), workspace, codexState]),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('discovers only artifacts from the selected session and features its display STEP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-codex-artifacts-'));
  try {
    const selected = sessionWorkspaceRoot(root, SESSION_ID)!;
    const other = sessionWorkspaceRoot(
      root,
      '78a8b125-4c0f-49ac-a246-06bff8a4cc7e',
    )!;
    await mkdir(selected, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'other.stl'), 'solid other');
    await writeUnifiedBuildFixture({ backend: 'brep-part', name: 'part', root: selected });

    const collection = await userSessionArtifacts(root, SESSION_ID);
    assert.equal(collection?.artifacts.some(({ name }) => name === 'other.stl'), false);
    assert.equal(
      collection?.artifacts.find(({ featured }) => featured)?.path,
      'part-display.step',
    );
    assert.deepEqual(
      collection?.artifacts
        .filter(({ primary }) => primary)
        .map(({ path }) => path)
        .sort(),
      ['part-display.step', 'part.step', 'part.stl'],
    );
    assert.equal(sessionWorkspaceRoot(root, '../escape'), undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('keeps per-attempt usage accounting and reads legacy turns without it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-turn-accounting-'));
  const sessionRoot = join(root, 'sessions');
  try {
    const accounting = turnAccounting({
      attemptId: 'attempt-1',
      model: 'openai/gpt-5.5',
      outcome: 'failed',
      taskType: 'cad',
      usage: {
        cacheWriteInputTokens: 3,
        cachedInputTokens: 40,
        inputTokens: 100,
        outputTokens: 25,
        reasoningOutputTokens: 9,
      },
    });
    const turn = completeChatTurn(
      startChatStep(emptyChatTurn(Date.now() - 2), {
        id: 'step-1',
        label: '正在生成 CAD 几何',
        occurredAt: Date.now() - 1,
        stage: 'command',
        status: 'running',
      }),
      {
        accounting,
        finishedAt: Date.now(),
        replyText: '本次执行失败，用量已记录。',
        status: 'failed',
      },
    );
    await appendSessionAssistantTurn(sessionRoot, SESSION_ID, turn);

    const [restored] = (await readSessionMessages(
      join(sessionRoot, `${SESSION_ID}.json`),
    )).filter(
      (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
        message.role === 'assistant',
    );
    assert.deepEqual(restored?.accounting, accounting);
    const { id: _id, role: _role, ...turnBody } = restored;
    assert.deepEqual(restoreChatTurn(restored), turnBody);

    // Turns written before accounting existed stay readable and stay without it.
    await appendSessionAssistantTurn(sessionRoot, SESSION_ID, {
      finishedAt: Date.now(),
      replyText: '旧回合',
      startedAt: Date.now() - 1,
      steps: [],
    });
    const messages = await readSessionMessages(
      join(sessionRoot, `${SESSION_ID}.json`),
    );
    const legacy = messages.at(-1);
    assert.equal(legacy?.role, 'assistant');
    assert.equal('accounting' in (legacy ?? {}), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
