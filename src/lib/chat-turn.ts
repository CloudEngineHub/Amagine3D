import type { TurnUsage } from '@amagine3d/a3d-runtime';

import type {
  CadRunEvidence,
  ChatStep,
  ChatTaskType,
  ChatTurn,
  ChatTurnAccounting,
  ChatTurnTerminalStatus,
  TurnAccountingOutcome,
  TurnUsageCoverage,
} from '../types';

export const CHAT_TURN_CUSTOM_TYPE = 'amagine3d.chat-turn.v2';

// Mirrors the runtime's TurnUsage field names so persisted accounting can be
// validated without pulling the Node-only runtime package into the browser.
const USAGE_FIELDS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const satisfies readonly (keyof TurnUsage)[];
const OUTCOMES = new Set<TurnAccountingOutcome>([
  'cancelled',
  'completed',
  'failed',
  'not_started',
  'timed_out',
]);
const TASK_TYPES = new Set<ChatTaskType>(['cad', 'chat']);
const COVERAGE = new Set<TurnUsageCoverage>(['full', 'partial', 'unavailable']);

export interface ChatTurnCompletion {
  accounting?: ChatTurnAccounting;
  finishedAt: number;
  replyText: string;
  sourceStepId?: string;
  status: ChatTurnTerminalStatus;
}

export function emptyChatTurn(startedAt = Date.now()): ChatTurn {
  return { replyText: '', startedAt, steps: [] };
}

export function startChatStep(
  current: ChatTurn,
  next: ChatStep,
): ChatTurn {
  return {
    ...current,
    steps: [
      ...current.steps.map((step) =>
        step.status === 'running'
          ? { ...step, status: 'completed' as const }
          : step,
      ),
      next,
    ],
  };
}

export function appendChatStepText(
  current: ChatTurn,
  stepId: string,
  content: string,
): ChatTurn {
  if (!content) return current;
  return {
    ...current,
    steps: current.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            progressText: `${step.progressText ?? ''}${content}`,
          }
        : step,
    ),
  };
}

/**
 * Record what one `runTurn` attempt cost and how it ended. Counts the SDK did
 * not report stay missing: a failure is never booked as a zero-cost turn.
 */
export function turnAccounting(input: {
  attemptId: string;
  model: string;
  outcome: TurnAccountingOutcome;
  taskType: ChatTaskType;
  usage?: TurnUsage;
}): ChatTurnAccounting {
  return {
    attemptId: input.attemptId,
    model: input.model,
    outcome: input.outcome,
    taskType: input.taskType,
    ...(input.usage ? { usage: input.usage } : {}),
    usageCoverage: usageCoverage(input.usage),
    usageSource: 'sdk',
  };
}

function usageCoverage(usage: TurnUsage | undefined): TurnUsageCoverage {
  if (!usage) return 'unavailable';
  return USAGE_FIELDS.every((field) => field in usage) ? 'full' : 'partial';
}

function restoreUsage(value: unknown): TurnUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: TurnUsage = {};
  for (const field of USAGE_FIELDS) {
    const count = source[field];
    if (count === undefined) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return undefined;
    }
    usage[field] = count;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function restoreAccounting(value: unknown): ChatTurnAccounting | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Partial<ChatTurnAccounting> & Record<string, unknown>;
  if (
    typeof source.attemptId !== 'string' ||
    source.attemptId === '' ||
    typeof source.model !== 'string' ||
    source.model === '' ||
    !OUTCOMES.has(source.outcome as TurnAccountingOutcome) ||
    !TASK_TYPES.has(source.taskType as ChatTaskType) ||
    !COVERAGE.has(source.usageCoverage as TurnUsageCoverage) ||
    source.usageSource !== 'sdk'
  ) {
    return undefined;
  }
  const usage = 'usage' in source ? restoreUsage(source.usage) : undefined;
  if ('usage' in source && source.usage !== undefined && usage === undefined) {
    return undefined;
  }
  const coverage = source.usageCoverage as TurnUsageCoverage;
  // The recorded coverage must describe the recorded counts exactly, so a
  // ledger cannot claim a complete bill for a partial or missing report.
  if (coverage !== usageCoverage(usage)) return undefined;
  return {
    ...source,
    attemptId: source.attemptId,
    model: source.model,
    outcome: source.outcome as TurnAccountingOutcome,
    taskType: source.taskType as ChatTaskType,
    ...(usage ? { usage } : {}),
    usageCoverage: coverage,
    usageSource: 'sdk',
  };
}

function restoreCadResult(value: unknown): CadRunEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as Partial<CadRunEvidence>;
  if (typeof result.runId !== 'string' || !result.runId ||
      typeof result.status !== 'string' || !result.status ||
      typeof result.pass !== 'boolean' || typeof result.visualReviewRequired !== 'boolean' ||
      typeof result.inputsCurrent !== 'boolean' || !result.report ||
      typeof result.report.path !== 'string' || !result.report.path ||
      typeof result.report.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.report.sha256)) return undefined;
  return { runId: result.runId, status: result.status, pass: result.pass,
    visualReviewRequired: result.visualReviewRequired, inputsCurrent: result.inputsCurrent,
    report: { path: result.report.path, sha256: result.report.sha256 },
    ...(typeof result.revision === 'string' ? { revision: result.revision } : {}),
    ...(result.stages && typeof result.stages === 'object' && !Array.isArray(result.stages) &&
      Object.values(result.stages).every((stage) => stage && typeof stage === 'object' && typeof stage.status === 'string')
      ? { stages: result.stages } : {}) };
}

function restoreRuntimeFailure(value: unknown): ChatTurn['runtimeFailure'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const failure = value as NonNullable<ChatTurn['runtimeFailure']>;
  if ((failure.code !== 'model_output_limit' && failure.code !== 'model_incomplete_response') ||
      !Number.isSafeInteger(failure.eventIndex) || failure.eventIndex < 1 ||
      typeof failure.completionSeen !== 'boolean' ||
      (failure.threadId !== undefined && (typeof failure.threadId !== 'string' || !failure.threadId))) return undefined;
  return { code: failure.code, eventIndex: failure.eventIndex, completionSeen: failure.completionSeen,
    ...(failure.threadId ? { threadId: failure.threadId } : {}) };
}

export function completeChatTurn(
  current: ChatTurn,
  completion: ChatTurnCompletion,
): ChatTurn {
  const accounting = completion.accounting ?? current.accounting;
  return {
    // Bookkeeping is rebuilt from the completed attempt but must survive a turn
    // that already collected it, so a restore cannot drop it either.
    ...(accounting ? { accounting } : {}),
    ...(current.cadResult ? { cadResult: current.cadResult } : {}),
    ...(current.runtimeFailure ? { runtimeFailure: current.runtimeFailure } : {}),
    finishedAt: completion.finishedAt,
    replyText: completion.replyText,
    startedAt:
      current.startedAt ?? current.steps[0]?.occurredAt ?? completion.finishedAt,
    steps: current.steps.map((step) => {
      const finalized =
        step.status === 'running'
          ? { ...step, status: completion.status }
          : step;
      if (step.id !== completion.sourceStepId) return finalized;
      const { progressText: _progressText, ...withoutProgressText } = finalized;
      return withoutProgressText;
    }),
  };
}

export function restoreChatTurn(value: unknown): ChatTurn | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<ChatTurn> & Record<string, unknown>;
  if (
    !Array.isArray(item.steps) ||
    typeof item.replyText !== 'string' ||
    typeof item.finishedAt !== 'number' ||
    !Number.isFinite(item.finishedAt)
  ) {
    return undefined;
  }
  const accounting =
    'accounting' in item && item.accounting !== undefined
      ? restoreAccounting(item.accounting)
      : undefined;
  if ('accounting' in item && item.accounting !== undefined && !accounting) {
    return undefined;
  }
  const cadResult = item.cadResult === undefined ? undefined : restoreCadResult(item.cadResult);
  const runtimeFailure = item.runtimeFailure === undefined ? undefined : restoreRuntimeFailure(item.runtimeFailure);
  if ((item.cadResult !== undefined && !cadResult) || (item.runtimeFailure !== undefined && !runtimeFailure)) return undefined;

  const steps = item.steps.flatMap((step): ChatStep[] => {
    if (!step || typeof step !== 'object') return [];
    const candidate = step as Partial<ChatStep>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.label !== 'string' ||
      (candidate.localizedLabel !== undefined &&
        (!candidate.localizedLabel ||
          typeof candidate.localizedLabel !== 'object' ||
          typeof candidate.localizedLabel.en !== 'string' ||
          typeof candidate.localizedLabel.zh !== 'string')) ||
      typeof candidate.occurredAt !== 'number' ||
      !Number.isFinite(candidate.occurredAt) ||
      (candidate.progressText !== undefined &&
        typeof candidate.progressText !== 'string') ||
      typeof candidate.stage !== 'string' ||
      !['cancelled', 'completed', 'failed', 'running'].includes(
        candidate.status ?? ''
      )
    ) {
      return [];
    }
    return [candidate as ChatStep];
  });
  if (
    steps.length === 0 ||
    steps.length !== item.steps.length ||
    steps.some(({ status }) => status === 'running')
  ) {
    return undefined;
  }
  const startedAt = item.startedAt ?? steps[0]!.occurredAt;
  if (
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    startedAt > steps[0]!.occurredAt ||
    item.finishedAt < steps[0]!.occurredAt
  ) {
    return undefined;
  }

  return {
    ...(accounting ? { accounting } : {}),
    ...(cadResult ? { cadResult } : {}),
    ...(runtimeFailure ? { runtimeFailure } : {}),
    finishedAt: item.finishedAt,
    replyText: item.replyText,
    startedAt,
    steps,
  };
}
