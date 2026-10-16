import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CodexRuntime,
  ModelOutputLimitError,
  normalizeTurnUsage,
  type CodexRuntimeLike,
  type RuntimeEvent,
  type TurnUsage,
} from '@amagine3d/a3d-runtime';
import express from 'express';

import { registerChatRoute } from '../server/routes/chat.ts';
import { createApp } from '../server/app.ts';
import {
  readSessionMessages,
  readSessionThreadId,
} from '../server/sessions.ts';
import type { AgentEvent, ChatMessage } from '../src/types.ts';

const SESSION_ID = '3b0d4f25-1707-4cc8-92cf-6f5c28edfc93';

test('streams one native Codex turn without server-side repair prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-codex-route-'));
  const stateRoot = join(root, 'state');
  const workspaceRoot = join(root, 'workspace');
  await Promise.all([mkdir(stateRoot), mkdir(workspaceRoot)]);
  await mkdir(join(workspaceRoot, 'sessions', SESSION_ID), { recursive: true });
  let runCalls = 0;
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'codex-hosted',
    skillDiagnostics: [],
    skills: [],
    stateRoot,
    webSearchEnabled: true,
    workspaceRoot,
    runTurn: async (request) => {
      runCalls += 1;
      assert.equal('webSearchEnabled' in request, false);
      await request.onThreadStarted?.('thread-1');
      const command =
        'a3d compile part_scene.json --marker .part.start --intent part_intent.json --source part_build.py';
      const events: RuntimeEvent[] = [
        { threadId: 'thread-1', type: 'thread.started' },
        { type: 'turn.started' },
        {
          item: {
            command,
            id: 'command-1',
            status: 'in_progress',
            type: 'command_execution',
          },
          type: 'item.started',
        },
        {
          commandId: 'command-1',
          stage: 'source',
          status: 'running',
          type: 'cad.compile.progress',
        },
        {
          commandId: 'command-1',
          elapsedMs: 1_200,
          stage: 'source',
          status: 'pass',
          type: 'cad.compile.progress',
        },
        {
          item: {
            command,
            id: 'command-1',
            status: 'in_progress',
            type: 'command_execution',
          },
          type: 'item.updated',
        },
        {
          commandId: 'command-1',
          stage: 'render',
          status: 'running',
          type: 'cad.compile.progress',
        },
        {
          commandId: 'command-1',
          elapsedMs: 850,
          stage: 'render',
          status: 'pass',
          type: 'cad.compile.progress',
        },
        {
          commandId: 'command-1',
          stage: 'custom-check',
          status: 'running',
          type: 'cad.compile.progress',
        },
        {
          commandId: 'command-1',
          elapsedMs: 900,
          stage: 'custom-check',
          status: 'pass',
          type: 'cad.compile.progress',
        },
        {
          commandId: 'command-1',
          stage: 'mesh-qa:part',
          status: 'running',
          type: 'cad.compile.progress',
        },
        {
          commandId: 'command-1',
          elapsedMs: 2_500,
          stage: 'mesh-qa:part',
          status: 'fail',
          type: 'cad.compile.progress',
        },
        {
          item: {
            command,
            id: 'command-1',
            status: 'in_progress',
            type: 'command_execution',
          },
          type: 'item.updated',
        },
        {
          commandId: 'command-1',
          elapsedMs: 5_000,
          stage: 'freshness',
          status: 'timeout',
          type: 'cad.compile.progress',
        },
        {
          item: {
            command,
            exitCode: 1,
            id: 'command-1',
            status: 'failed',
            type: 'command_execution',
          },
          type: 'item.completed',
        },
        {
          item: {
            command: 'a3d search "private-query-sentinel"',
            id: 'search-1',
            status: 'in_progress',
            type: 'command_execution',
          },
          type: 'item.started',
        },
        {
          item: {
            command: 'a3d search "private-query-sentinel"',
            exitCode: 0,
            id: 'search-1',
            status: 'completed',
            type: 'command_execution',
          },
          type: 'item.completed',
        },
        {
          item: { id: 'answer-1', text: '模', type: 'agent_message' },
          type: 'item.updated',
        },
        {
          item: { id: 'answer-1', text: '模型完成', type: 'agent_message' },
          type: 'item.completed',
        },
      ];
      for (const event of events) await request.onEvent?.(event);
      return { finalResponse: '模型完成', threadId: 'thread-1' };
    },
  };
  const app = express();
  app.use(express.json());
  registerChatRoute(app, {
    python: { executable: 'python', ready: true, version: '3.13' },
    runtime,
    runtimeError: undefined,
    sessionRoot: join(runtime.stateRoot, 'sessions'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/chat`, {
      body: JSON.stringify({
        message: '创建一个支架',
        sessionId: SESSION_ID,
        taskType: 'cad',
        webSearchEnabled: false,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);

    assert.equal(response.status, 200);
    assert.equal(runCalls, 1);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'complete');
    if (terminal?.type !== 'complete') throw new Error('Expected completion.');
    assert.equal(terminal.content, '模型完成');
    const streamedBody = JSON.stringify(events);
    assert.doesNotMatch(streamedBody, /a3d compile/u);
    assert.doesNotMatch(streamedBody, /private-query-sentinel/u);
    assert.doesNotMatch(streamedBody, /internal compiler output/u);
    assert.deepEqual(
      events
        .filter((event): event is Extract<AgentEvent, { type: 'step' }> =>
          event.type === 'step',
        )
        .map(({ step }) => step.label),
      [
        '正在启动 A3D · openai/test-model',
        'A3D 已启动',
        'A3D 正在分析请求',
        '正在编译并检查 CAD',
        '正在生成 CAD 几何',
        '正在渲染 CAD 预览',
        '正在执行 CAD 检查',
        '正在检查可打印网格',
        '正在检查产物新鲜度',
        '命令返回非零退出码，需结合结果判断原因',
        '正在搜索网络资料',
        'A3D 正在分析搜索结果',
        '正在组织回复',
        '正在整理生成文件',
        '已发现 0 个工作区文件',
      ],
    );
    assert.deepEqual(
      events
        .filter((event): event is Extract<AgentEvent, { type: 'step' }> =>
          event.type === 'step',
        )
        .map(({ step }) => step.localizedLabel?.en),
      [
        'Starting A3D · openai/test-model',
        'A3D started',
        'A3D is analyzing the request',
        'Compiling and validating CAD',
        'Generating CAD geometry',
        'Rendering the CAD preview',
        'Running a CAD validation stage',
        'Checking printable meshes',
        'Checking artifact freshness',
        'The command returned a nonzero exit code',
        'Searching web references',
        'A3D is analyzing the search results',
        'Organizing the response',
        'Collecting generated files',
        '0 workspace files discovered',
      ],
    );
    const stepEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: 'step' }> =>
        event.type === 'step',
    );
    const deltaEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: 'step_delta' }> =>
        event.type === 'step_delta',
    );
    const progressFor = (label: string) => {
      const stepId = stepEvents.find(({ step }) => step.label === label)?.step.id;
      assert.ok(stepId, `Missing step: ${label}`);
      return deltaEvents
        .filter((event) => event.stepId === stepId)
        .map(({ content }) => content)
        .join('');
    };
    assert.equal(progressFor('正在生成 CAD 几何'), 'pass · 1.20 s');
    assert.equal(progressFor('正在渲染 CAD 预览'), 'pass · 850 ms');
    assert.equal(progressFor('正在执行 CAD 检查'), 'pass · 900 ms');
    assert.equal(progressFor('正在检查可打印网格'), 'fail · 2.50 s');
    assert.equal(progressFor('正在检查产物新鲜度'), 'timeout · 5.00 s');
    assert.equal(progressFor('正在组织回复'), '模型完成');
    const messages = await readSessionMessages(
      join(stateRoot, 'sessions', `${SESSION_ID}.json`),
    );
    assert.equal(
      await readSessionThreadId(join(stateRoot, 'sessions'), SESSION_ID),
      'thread-1',
    );
    assert.deepEqual(messages.map(({ role }) => role), ['user', 'assistant']);
    const assistant = messages.at(-1);
    assert.equal(assistant?.role, 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('Expected assistant turn.');
    assert.equal(typeof assistant.startedAt, 'number');
    if (assistant.startedAt === undefined) throw new Error('Expected start time.');
    assert.equal(assistant.startedAt <= assistant.steps[0]!.occurredAt, true);
    assert.equal(assistant.finishedAt! >= assistant.startedAt, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { force: true, recursive: true });
  }
});

test('does not require Python for a plain Codex chat turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-codex-chat-'));
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot: join(root, 'workspace'),
    runTurn: async (request) => {
      assert.equal('webSearchEnabled' in request, false);
      return { finalResponse: 'ok', threadId: 'thread-1' };
    },
  };
  const app = express();
  app.use(express.json());
  registerChatRoute(app, {
    python: { executable: null, ready: false, version: null },
    runtime,
    runtimeError: undefined,
    sessionRoot: join(runtime.stateRoot, 'sessions'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/chat`, {
      body: JSON.stringify({
        message: '解释 BRep',
        sessionId: SESSION_ID,
        taskType: 'chat',
        webSearchEnabled: true,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { force: true, recursive: true });
  }
});

test('streams Codex failures without aborting the settled runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-codex-failure-'));
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  let signalWasAborted = false;
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'codex-hosted',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: true,
    workspaceRoot: join(root, 'workspace'),
    runTurn: async (request) => {
      request.signal?.addEventListener(
        'abort',
        () => {
          signalWasAborted = true;
        },
        { once: true },
      );
      throw new Error(
        'exceeded retry limit, last status: 429 Too Many Requests',
      );
    },
  };
  const app = express();
  app.use(express.json());
  registerChatRoute(app, {
    python: { executable: null, ready: false, version: null },
    runtime,
    runtimeError: undefined,
    sessionRoot: join(runtime.stateRoot, 'sessions'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/chat`, {
      body: JSON.stringify({
        message: '解释 BRep',
        sessionId: SESSION_ID,
        taskType: 'chat',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);

    assert.equal(response.status, 200);
    assert.equal(signalWasAborted, false);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'error');
    if (terminal?.type !== 'error') throw new Error('Expected error event.');
    assert.equal(terminal.code, 'codex_error');
    assert.equal(
      terminal.message,
      'exceeded retry limit, last status: 429 Too Many Requests',
    );
    assert.equal(typeof terminal.finishedAt, 'number');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { force: true, recursive: true });
  }
});

test('surfaces max_output_tokens as an incomplete model turn instead of completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-output-limit-route-'));
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot: join(root, 'workspace'),
    runTurn: async () => {
      throw new ModelOutputLimitError();
    },
  };
  const app = express();
  app.use(express.json());
  registerChatRoute(app, {
    python: { executable: null, ready: false, version: null },
    runtime,
    runtimeError: undefined,
    sessionRoot: join(runtime.stateRoot, 'sessions'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/chat`, {
      body: JSON.stringify({
        message: '继续建模',
        sessionId: SESSION_ID,
        taskType: 'chat',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'error');
    if (terminal?.type !== 'error') throw new Error('Expected error event.');
    assert.equal(terminal.code, 'model_output_limit');
    assert.match(terminal.message, /max_output_tokens/u);
    const messages = await readSessionMessages(
      join(root, 'state', 'sessions', `${SESSION_ID}.json`),
    );
    const assistant = messages.at(-1);
    assert.equal(assistant?.role, 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('Expected assistant turn.');
    assert.match(assistant.replyText, /max_output_tokens/u);
    assert.ok(assistant.steps.some(({ status }) => status === 'failed'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { force: true, recursive: true });
  }
});

test('createApp forwards an optional turn executor into the chat route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-create-app-lease-'));
  const sessionRoot = join(root, 'state', 'sessions');
  const workspaceRoot = join(root, 'workspace');
  await Promise.all([
    mkdir(sessionRoot, { recursive: true }),
    mkdir(join(workspaceRoot, 'sessions', SESSION_ID), { recursive: true }),
  ]);
  let openCalls = 0;
  let closeCalls = 0;
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot,
    runTurn: async () => ({ finalResponse: 'ok', threadId: 'thread-1' }),
  };
  const app = createApp({
    openTurnExecutor: () => {
      openCalls += 1;
      return {
        close: () => {
          closeCalls += 1;
        },
      };
    },
    paths: {
      bundledPomodoroRoot: join(root, 'bundled'),
      distPath: join(root, 'missing-dist'),
      projectRoot: root,
      sessionRoot,
      workspaceRoot,
    },
    python: { executable: null, ready: false, version: null },
    runtime,
    runtimeError: undefined,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/chat`, {
      body: JSON.stringify({
        message: '解释 BRep',
        sessionId: SESSION_ID,
        taskType: 'chat',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);
    assert.equal(response.status, 200);
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(openCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { force: true, recursive: true });
  }
});

async function withChatServer(
  root: string,
  dependencies: Parameters<typeof registerChatRoute>[1],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  registerChatRoute(app, dependencies);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { force: true, recursive: true });
  }
}

function postChat(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
}

test('closes a lease returned during open when the client disconnects mid-open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-turn-lease-open-abort-'));
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  let closeCalls = 0;
  let sawOpenStart = false;
  let runCalls = 0;
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot: join(root, 'workspace'),
    runTurn: async () => {
      runCalls += 1;
      return { finalResponse: 'late', threadId: 'thread-1' };
    },
  };
  await withChatServer(
    root,
    {
      openTurnExecutor: async () => {
        sawOpenStart = true;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          close: () => {
            closeCalls += 1;
          },
        };
      },
      python: { executable: null, ready: false, version: null },
      runtime,
      runtimeError: undefined,
      sessionRoot: join(runtime.stateRoot, 'sessions'),
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const responsePromise = fetch(`${baseUrl}/api/chat`, {
        body: JSON.stringify({
          message: '长任务',
          sessionId: SESSION_ID,
          taskType: 'chat',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      }).catch(() => undefined);
      const deadline = Date.now() + 3_000;
      while (!sawOpenStart && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(sawOpenStart, true);
      controller.abort();
      await responsePromise;
      while (closeCalls < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(closeCalls, 1);
      assert.equal(runCalls, 0);
    },
  );
});

test('opens and closes a turn executor lease around a successful turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-turn-lease-ok-'));
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  let closeCalls = 0;
  let openCalls = 0;
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot: join(root, 'workspace'),
    runTurn: async (request) => {
      assert.equal(request.taskType, 'chat');
      return { finalResponse: 'ok', threadId: 'thread-1' };
    },
  };
  await withChatServer(
    root,
    {
      openTurnExecutor: (context) => {
        openCalls += 1;
        assert.equal(context.cadSystem, 'a3d-text');
        assert.equal(context.sessionId, SESSION_ID);
        assert.equal(context.taskType, 'chat');
        assert.equal(context.runtime, runtime);
        return {
          close: () => {
            closeCalls += 1;
          },
        };
      },
      python: { executable: null, ready: false, version: null },
      runtime,
      runtimeError: undefined,
      sessionRoot: join(runtime.stateRoot, 'sessions'),
    },
    async (baseUrl) => {
      const response = await postChat(baseUrl, {
        message: '解释 BRep',
        sessionId: SESSION_ID,
        taskType: 'chat',
      });
      const events = (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentEvent);
      assert.equal(response.status, 200);
      assert.equal(events.at(-1)?.type, 'complete');
      assert.equal(openCalls, 1);
      assert.equal(closeCalls, 1);
    },
  );
});

test('closes the turn executor lease when the runtime turn fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-turn-lease-fail-'));
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  let closeCalls = 0;
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot: join(root, 'workspace'),
    runTurn: async () => {
      throw new Error('worker exploded');
    },
  };
  await withChatServer(
    root,
    {
      openTurnExecutor: () => ({
        close: () => {
          closeCalls += 1;
        },
      }),
      python: { executable: null, ready: false, version: null },
      runtime,
      runtimeError: undefined,
      sessionRoot: join(runtime.stateRoot, 'sessions'),
    },
    async (baseUrl) => {
      const response = await postChat(baseUrl, {
        message: '继续建模',
        sessionId: SESSION_ID,
        taskType: 'chat',
      });
      const events = (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AgentEvent);
      assert.equal(events.at(-1)?.type, 'error');
      assert.equal(closeCalls, 1);
    },
  );
});

test('closes the turn executor lease when the client disconnects mid-turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-turn-lease-abort-'));
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  let closeCalls = 0;
  let signalAborted = false;
  let sawTurnStarted = false;
  const runtime: CodexRuntimeLike = {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot: join(root, 'workspace'),
    runTurn: async (request) => {
      sawTurnStarted = true;
      request.signal?.addEventListener(
        'abort',
        () => {
          signalAborted = true;
        },
        { once: true },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        request.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
      return { finalResponse: 'late', threadId: 'thread-1' };
    },
  };
  await withChatServer(
    root,
    {
      openTurnExecutor: () => ({
        close: () => {
          closeCalls += 1;
        },
      }),
      python: { executable: null, ready: false, version: null },
      runtime,
      runtimeError: undefined,
      sessionRoot: join(runtime.stateRoot, 'sessions'),
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const responsePromise = fetch(`${baseUrl}/api/chat`, {
        body: JSON.stringify({
          message: '长任务',
          sessionId: SESSION_ID,
          taskType: 'chat',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      }).catch(() => undefined);
      const deadline = Date.now() + 3_000;
      while (!sawTurnStarted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(sawTurnStarted, true);
      controller.abort();
      await responsePromise;
      while (closeCalls < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(signalAborted, true);
      assert.equal(closeCalls, 1);
    },
  );
});

const SDK_USAGE = {
  cache_write_input_tokens: 3,
  cached_input_tokens: 40,
  input_tokens: 100,
  output_tokens: 25,
  reasoning_output_tokens: 9,
};

function chatRuntime(
  root: string,
  runTurn: CodexRuntimeLike['runTurn'],
): CodexRuntimeLike {
  return {
    configured: true,
    modelName: 'openai/test-model',
    runtimeReady: true,
    searchBackend: 'disabled',
    skillDiagnostics: [],
    skills: [],
    stateRoot: join(root, 'state'),
    webSearchEnabled: false,
    workspaceRoot: join(root, 'workspace'),
    runTurn,
  };
}

function chatDependencies(
  root: string,
  runtime: CodexRuntimeLike,
): Parameters<typeof registerChatRoute>[1] {
  return {
    python: { executable: null, ready: false, version: null },
    runtime,
    runtimeError: undefined,
    sessionRoot: join(runtime.stateRoot, 'sessions'),
  };
}

test('failed model turn preserves CAD status and delivers existing files once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-failed-cad-evidence-'));
  const workspace = join(root, 'workspace', 'sessions', SESSION_ID);
  await mkdir(workspace, { recursive: true });
  const source = join(workspace, 'build.py');
  await writeFile(source, '# source');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const runtime = chatRuntime(root, async (request) => {
    await writeFile(join(workspace, 'model_compile-result.json'), JSON.stringify({
      schema: 'evidence-cad-compile-result/v2', runId: 'cad-run', status: 'awaiting-visual-review',
      pass: true, visualReviewRequired: true, inputBindings: { source: { path: source, sha256: hash(await readFile(source)) } },
    }));
    await request.onEvent?.({ type: 'turn.completed', usage: normalizeTurnUsage(SDK_USAGE) });
    throw new ModelOutputLimitError({ eventIndex: 4, completionSeen: true, threadId: 'thread' });
  });
  await withChatServer(root, { ...chatDependencies(root, runtime), python: { executable: 'python', ready: true, version: null } }, async (baseUrl) => {
    const response = await postChat(baseUrl, { message: '生成模型', sessionId: SESSION_ID, taskType: 'cad' });
    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as AgentEvent);
    assert.equal(events.filter((event) => event.type === 'artifacts').length, 1);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'error');
    if (terminal?.type === 'error') assert.match(terminal.message, /CAD 自动检查已通过.*需要视觉审查/u);
    const messages = await readSessionMessages(join(root, 'state', 'sessions', `${SESSION_ID}.json`));
    const turn = messages.at(-1);
    assert.equal(turn?.role, 'assistant');
    if (turn?.role === 'assistant') {
      assert.equal(turn.accounting?.outcome, 'failed');
      assert.equal(turn.cadResult?.pass, true);
      assert.equal(turn.cadResult?.visualReviewRequired, true);
      assert.equal(turn.runtimeFailure?.eventIndex, 4);
      assert.equal(turn.accounting?.usage?.inputTokens, 100);
    }
  });
});

test('persists the five SDK counts per attempt across two turns of one session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-usage-route-'));
  const sessionRoot = join(root, 'state', 'sessions');
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  const second: TurnUsage = {
    cacheWriteInputTokens: 0,
    cachedInputTokens: 0,
    inputTokens: 7,
    outputTokens: 2,
    reasoningOutputTokens: 0,
  };
  const reports: TurnUsage[] = [normalizeTurnUsage(SDK_USAGE)!, second];
  let call = 0;
  const runtime = chatRuntime(root, async (request) => {
    const usage = reports[call]!;
    call += 1;
    await request.onEvent?.({ type: 'turn.started' });
    await request.onEvent?.({ type: 'turn.completed', usage });
    // The turn result repeats the same snapshot; accounting keeps one copy.
    return { finalResponse: 'ok', threadId: 'thread-1', usage };
  });

  await withChatServer(root, chatDependencies(root, runtime), async (baseUrl) => {
    for (const message of ['创建支架', '加厚侧壁']) {
      const response = await postChat(baseUrl, {
        message,
        sessionId: SESSION_ID,
        taskType: 'chat',
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    const messages = await readSessionMessages(join(sessionRoot, `${SESSION_ID}.json`));
    const turns = messages.filter(
      (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
        message.role === 'assistant',
    );
    assert.equal(turns.length, 2);
    assert.deepEqual(
      turns.map(({ accounting }) => accounting?.usage),
      [normalizeTurnUsage(SDK_USAGE), second],
    );
    assert.deepEqual(
      turns.map(({ accounting }) => accounting?.usageCoverage),
      ['full', 'full'],
    );
    assert.deepEqual(
      turns.map(({ accounting }) => accounting?.outcome),
      ['completed', 'completed'],
    );
    assert.deepEqual(
      turns.map(({ accounting }) => accounting?.model),
      ['openai/test-model', 'openai/test-model'],
    );
    assert.deepEqual(
      turns.map(({ accounting }) => accounting?.usageSource),
      ['sdk', 'sdk'],
    );
    assert.equal(
      turns[0]!.accounting!.attemptId !== turns[1]!.accounting!.attemptId,
      true,
    );
  });
});

test('records a failed attempt without inventing zero usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-usage-failed-'));
  const sessionRoot = join(root, 'state', 'sessions');
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  const runtime = chatRuntime(root, async (request) => {
    await request.onEvent?.({ type: 'turn.started' });
    await request.onEvent?.({ message: 'stream reset', type: 'error' });
    throw new Error('stream reset');
  });

  await withChatServer(root, chatDependencies(root, runtime), async (baseUrl) => {
    const response = await postChat(baseUrl, {
      message: '解释 BRep',
      sessionId: SESSION_ID,
      taskType: 'chat',
    });
    await response.text();
    const [assistant] = (await readSessionMessages(
      join(sessionRoot, `${SESSION_ID}.json`),
    )).filter(
      (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
        message.role === 'assistant',
    );
    assert.equal(assistant?.accounting?.outcome, 'failed');
    assert.equal(assistant?.accounting?.usageCoverage, 'unavailable');
    assert.equal('usage' in (assistant?.accounting ?? {}), false);
  });
});

test('keeps reported usage when max_output_tokens truncates the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-usage-output-limit-'));
  const sessionRoot = join(root, 'state', 'sessions');
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  const runtime = chatRuntime(root, async (request) => {
    await request.onEvent?.({ type: 'turn.started' });
    await request.onEvent?.({
      type: 'turn.completed',
      usage: normalizeTurnUsage(SDK_USAGE),
    });
    throw new ModelOutputLimitError();
  });

  await withChatServer(root, chatDependencies(root, runtime), async (baseUrl) => {
    const response = await postChat(baseUrl, {
      message: '继续建模',
      sessionId: SESSION_ID,
      taskType: 'chat',
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);
    assert.equal(events.at(-1)?.type, 'error');
    const [assistant] = (await readSessionMessages(
      join(sessionRoot, `${SESSION_ID}.json`),
    )).filter(
      (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
        message.role === 'assistant',
    );
    // Usage is what the attempt cost; the truncated turn still failed.
    assert.equal(assistant?.accounting?.outcome, 'failed');
    assert.equal(assistant?.accounting?.usageCoverage, 'full');
    assert.deepEqual(assistant?.accounting?.usage, normalizeTurnUsage(SDK_USAGE));
  });
});

test('a reasoning-only finish fails the CAD route while preserving thread and usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-incomplete-final-route-'));
  const progress = '我分批查询所需的建模操作合同（上限 20 个）。';
  let modelCalls = 0;
  const runtime = await CodexRuntime.create(root, {
    environment: { LLM_API_KEY: 'test-key', PATH: '/usr/bin' },
    clientFactory: () => {
      const thread = {
        id: 'incomplete-final-thread',
        async runStreamed() {
          modelCalls += 1;
          async function* events() {
            yield { type: 'thread.started', thread_id: thread.id } as const;
            yield { type: 'turn.started' } as const;
            yield { type: 'item.completed', item: { type: 'agent_message', id: 'progress', text: progress } } as const;
            for (const id of ['batch-1', 'batch-2']) yield {
              type: 'item.completed',
              item: { type: 'command_execution', id, command: 'a3d agent capabilities <batch>',
                aggregated_output: '{}', status: 'completed', exit_code: 0 },
            } as const;
            yield { type: 'item.completed', item: { type: 'reasoning', id: 'reasoning', text: '' } } as const;
            yield { type: 'turn.completed', usage: SDK_USAGE } as const;
          }
          return { events: events() };
        },
      };
      return { startThread: () => thread, resumeThread: () => thread };
    },
  });
  await withChatServer(root, {
    ...chatDependencies(root, runtime),
    python: { executable: null, ready: true, version: null },
  }, async (baseUrl) => {
    const response = await postChat(baseUrl, {
      message: '生成桌面机器人', sessionId: SESSION_ID, taskType: 'cad',
    });
    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as AgentEvent);
    const terminal = events.at(-1);
    assert.ok(terminal?.type === 'error');
    assert.equal(terminal.code, 'model_incomplete_response');
    assert.equal(events.some(({ type }) => type === 'complete'), false);
    assert.equal(modelCalls, 1);
    const sessionRoot = join(runtime.stateRoot, 'sessions');
    assert.equal(await readSessionThreadId(sessionRoot, SESSION_ID), 'incomplete-final-thread');
    const [assistant] = (await readSessionMessages(join(sessionRoot, `${SESSION_ID}.json`))).filter(
      (message): message is Extract<ChatMessage, { role: 'assistant' }> => message.role === 'assistant',
    );
    assert.ok(assistant);
    assert.equal(assistant.accounting?.outcome, 'failed');
    assert.equal(assistant.accounting?.usageCoverage, 'full');
    assert.deepEqual(assistant.accounting?.usage, normalizeTurnUsage(SDK_USAGE));
    assert.deepEqual(assistant.runtimeFailure, {
      code: 'model_incomplete_response', eventIndex: 7,
      threadId: 'incomplete-final-thread', completionSeen: true,
    });
    assert.match(assistant.replyText, /没有有效的最终回复/u);
    assert.notEqual(assistant.replyText, progress);
    assert.ok(assistant.steps.some(({ status }) => status === 'failed'));
    assert.equal(assistant.steps.some(({ stage }) => stage === 'files'), false);
    assert.equal(assistant.cadResult, undefined);
  });
});

test('marks an attempt that never reached the model as not started', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-usage-not-started-'));
  const sessionRoot = join(root, 'state', 'sessions');
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  let runCalls = 0;
  const runtime = chatRuntime(root, async () => {
    runCalls += 1;
    return { finalResponse: 'ok', threadId: 'thread-1' };
  });

  await withChatServer(
    root,
    {
      ...chatDependencies(root, runtime),
      openTurnExecutor: () => {
        throw new Error('no executor available');
      },
    },
    async (baseUrl) => {
      const response = await postChat(baseUrl, {
        message: '解释 BRep',
        sessionId: SESSION_ID,
        taskType: 'chat',
      });
      await response.text();
      assert.equal(runCalls, 0);
      const [assistant] = (await readSessionMessages(
        join(sessionRoot, `${SESSION_ID}.json`),
      )).filter(
        (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
          message.role === 'assistant',
      );
      assert.equal(assistant?.accounting?.outcome, 'not_started');
      assert.equal(assistant?.accounting?.usageCoverage, 'unavailable');
    },
  );
});

test('keeps usage reported before a client disconnect without marking success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amagine-usage-disconnect-'));
  const sessionRoot = join(root, 'state', 'sessions');
  await mkdir(join(root, 'workspace', 'sessions', SESSION_ID), {
    recursive: true,
  });
  let sawTurnStarted = false;
  const runtime = chatRuntime(root, async (request) => {
    sawTurnStarted = true;
    await request.onEvent?.({ type: 'turn.started' });
    await request.onEvent?.({
      type: 'turn.completed',
      usage: normalizeTurnUsage(SDK_USAGE),
    });
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        { once: true },
      );
    });
    return { finalResponse: 'late', threadId: 'thread-1' };
  });

  await withChatServer(root, chatDependencies(root, runtime), async (baseUrl) => {
    const controller = new AbortController();
    const responsePromise = fetch(`${baseUrl}/api/chat`, {
      body: JSON.stringify({
        message: '长任务',
        sessionId: SESSION_ID,
        taskType: 'chat',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    }).catch(() => undefined);
    const deadline = Date.now() + 3_000;
    while (!sawTurnStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sawTurnStarted, true);
    controller.abort();
    await responsePromise;
    // The turn settles after the client is gone; wait for the ledger to land
    // before asserting on it.
    let assistant: Extract<ChatMessage, { role: 'assistant' }> | undefined;
    while (!assistant && Date.now() < deadline) {
      assistant = (await readSessionMessages(
        join(sessionRoot, `${SESSION_ID}.json`),
      )).find(
        (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
          message.role === 'assistant',
      );
      if (!assistant) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(assistant?.accounting?.outcome, 'cancelled');
    assert.deepEqual(assistant?.accounting?.usage, normalizeTurnUsage(SDK_USAGE));
  });
});
