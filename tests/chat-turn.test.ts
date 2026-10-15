import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  appendChatStepText,
  completeChatTurn,
  emptyChatTurn,
  restoreChatTurn,
  startChatStep,
  turnAccounting,
} from '../src/lib/chat-turn.ts';
import { chatStepLabel } from '../src/lib/chat-step-label.ts';
import type { ChatStep } from '../src/types.ts';

function step(id: string, label: string): ChatStep {
  return { id, label, occurredAt: 1, stage: id, status: 'running' };
}

test('chat turns retain ordered steps and append text to the owning step', () => {
  const first = startChatStep(emptyChatTurn(0), step('one', '读取需求'));
  const second = startChatStep(first, step('two', '生成模型'));
  const withProgress = appendChatStepText(second, 'two', '主体已经生成。');
  assert.deepEqual(
    withProgress.steps.map(({ label, progressText, status }) => ({
      label,
      progressText,
      status,
    })),
    [
      {
        label: '读取需求',
        progressText: undefined,
        status: 'completed',
      },
      {
        label: '生成模型',
        progressText: '主体已经生成。',
        status: 'running',
      },
    ],
  );

  const completed = completeChatTurn(withProgress, {
    finishedAt: 10,
    replyText: '模型已经生成。',
    sourceStepId: 'two',
    status: 'completed',
  });
  assert.deepEqual(
    completed.steps.map(({ progressText, status }) => ({
      progressText,
      status,
    })),
    [
      { progressText: undefined, status: 'completed' },
      { progressText: undefined, status: 'completed' },
    ],
  );
  assert.equal(completed.replyText, '模型已经生成。');
  assert.equal(completed.startedAt, 0);
  assert.equal(completed.finishedAt, 10);
});

test('restored chat turns reject malformed or unfinished persisted data', () => {
  const turn = {
    finishedAt: 10,
    replyText: '完成',
    startedAt: 0,
    steps: [{ ...step('one', '完成'), status: 'completed' as const }],
  };
  assert.deepEqual(restoreChatTurn(turn), turn);
  assert.equal(restoreChatTurn({ ...turn, finishedAt: undefined }), undefined);
  assert.equal(
    restoreChatTurn({ ...turn, steps: [step('one', '仍在运行')] }),
    undefined,
  );
  assert.equal(
    restoreChatTurn({ ...turn, steps: [{ label: 'missing fields' }] }),
    undefined,
  );
  const { startedAt: _startedAt, ...legacyTurn } = turn;
  assert.deepEqual(restoreChatTurn(legacyTurn), { ...turn, startedAt: 1 });
});

test('model failure and independent CAD evidence survive completion and restore', () => {
  const started = startChatStep(emptyChatTurn(0), step('one', '构建'));
  const cadResult = { runId: 'cad-run', report: { path: '/workspace/result.json', sha256: 'a'.repeat(64) },
    status: 'awaiting-visual-review', pass: true, visualReviewRequired: true, inputsCurrent: true,
    revision: 'revision-2', stages: { cadExport: { status: 'passed' }, visualReview: { status: 'pending' } } };
  for (const code of ['model_output_limit', 'model_incomplete_response'] as const) {
    const runtimeFailure = { code, eventIndex: 12, completionSeen: true, threadId: 'thread-1' };
    const completed = completeChatTurn({ ...started, cadResult, runtimeFailure }, {
      finishedAt: 10, replyText: '模型本轮未完成', status: 'failed',
    });
    assert.deepEqual(restoreChatTurn(completed), completed);
    assert.equal(completed.cadResult?.visualReviewRequired, true);
    assert.equal(restoreChatTurn({ ...completed, cadResult: { ...cadResult, pass: 'true' } }), undefined);
    assert.equal(restoreChatTurn({ ...completed, runtimeFailure: { ...runtimeFailure, eventIndex: -1 } }), undefined);
    assert.equal(restoreChatTurn({ ...completed, runtimeFailure: { ...runtimeFailure, code: 'unknown' } }), undefined);
  }
});

test('localized step labels switch immediately and preserve legacy fallbacks', () => {
  const localized = {
    ...step('one', '正在分析'),
    localizedLabel: { en: 'Analyzing', zh: '正在分析' },
  };
  assert.equal(chatStepLabel(localized, 'en'), 'Analyzing');
  assert.equal(chatStepLabel(localized, 'zh'), '正在分析');
  assert.equal(chatStepLabel(step('legacy', '旧会话原文'), 'en'), '旧会话原文');

  const persisted = {
    finishedAt: 10,
    replyText: '完成',
    startedAt: 0,
    steps: [{ ...localized, status: 'completed' as const }],
  };
  assert.deepEqual(restoreChatTurn(persisted), persisted);
  assert.equal(
    restoreChatTurn({
      ...persisted,
      steps: [
        {
          ...persisted.steps[0],
          localizedLabel: { en: 'Analyzing', zh: 1 },
        },
      ],
    }),
    undefined,
  );
});

test('complete and restore keep one attempt of usage accounting', () => {
  const accounting = turnAccounting({
    attemptId: 'attempt-1',
    model: 'openai/gpt-5.5',
    outcome: 'completed',
    taskType: 'cad',
    usage: {
      cacheWriteInputTokens: 3,
      cachedInputTokens: 40,
      inputTokens: 100,
      outputTokens: 25,
      reasoningOutputTokens: 9,
    },
  });
  assert.deepEqual(accounting, {
    attemptId: 'attempt-1',
    model: 'openai/gpt-5.5',
    outcome: 'completed',
    taskType: 'cad',
    usage: {
      cacheWriteInputTokens: 3,
      cachedInputTokens: 40,
      inputTokens: 100,
      outputTokens: 25,
      reasoningOutputTokens: 9,
    },
    usageCoverage: 'full',
    usageSource: 'sdk',
  });

  const started = startChatStep(emptyChatTurn(0), step('one', '生成模型'));
  const completed = completeChatTurn(started, {
    accounting,
    finishedAt: 10,
    replyText: '完成',
    status: 'completed',
  });
  assert.deepEqual(completed.accounting, accounting);
  assert.deepEqual(restoreChatTurn(completed), completed);

  // A turn that already collected accounting keeps it when no new record is
  // supplied, so a late rebuild cannot drop the ledger.
  assert.deepEqual(
    completeChatTurn({ ...started, accounting }, {
      finishedAt: 11,
      replyText: '完成',
      status: 'completed',
    }).accounting,
    accounting,
  );
});

test('accounting keeps partial and missing usage distinct from zero cost', () => {
  assert.equal(
    turnAccounting({
      attemptId: 'a',
      model: 'm',
      outcome: 'failed',
      taskType: 'chat',
    }).usageCoverage,
    'unavailable',
  );
  const partial = turnAccounting({
    attemptId: 'a',
    model: 'm',
    outcome: 'cancelled',
    taskType: 'chat',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  assert.equal(partial.usageCoverage, 'partial');
  assert.deepEqual(partial.usage, { inputTokens: 0, outputTokens: 0 });

  const turn = {
    finishedAt: 10,
    replyText: '完成',
    startedAt: 0,
    steps: [{ ...step('one', '完成'), status: 'completed' as const }],
    accounting: partial,
  };
  assert.deepEqual(restoreChatTurn(turn), turn);
  assert.deepEqual(restoreChatTurn(turn)?.accounting?.usage, {
    inputTokens: 0,
    outputTokens: 0,
  });
  for (const broken of [
    { ...partial, outcome: 'stopped' },
    { ...partial, usageSource: 'estimated' },
    { ...partial, usageCoverage: 'full' },
    { ...partial, usage: { inputTokens: -1 } },
    { ...partial, usage: { inputTokens: 1.5 } },
    { ...partial, usage: {} },
  ]) {
    assert.equal(
      restoreChatTurn({ ...turn, accounting: broken }),
      undefined,
      JSON.stringify(broken),
    );
  }
});
