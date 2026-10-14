import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';

import type { CadCompileProgressStatus } from './compile-progress.ts';

/**
 * Token counts exactly as the SDK reported them for one turn.
 *
 * Cached input is a subset of the input count and reasoning output is a subset
 * of the output count, so these five numbers are never summed into one total. A
 * reported `0` is data; a missing field was not reported and stays missing.
 */
export interface TurnUsage {
  cacheWriteInputTokens?: number;
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

/** The five SDK counts, in the order they are read and reported. */
export const TURN_USAGE_FIELDS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const satisfies readonly (keyof TurnUsage)[];

const USAGE_SOURCE_FIELDS = {
  inputTokens: 'input_tokens',
  cachedInputTokens: 'cached_input_tokens',
  cacheWriteInputTokens: 'cache_write_input_tokens',
  outputTokens: 'output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
} as const satisfies Record<(typeof TURN_USAGE_FIELDS)[number], keyof Usage>;

function reportedCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Keep only counts the SDK actually reported as non-negative safe integers.
 * Negative, non-finite, or fractional values are unknown rather than coerced.
 */
export function normalizeTurnUsage(usage: unknown): TurnUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const source = usage as Partial<Record<keyof Usage, unknown>>;
  const normalized: TurnUsage = {};
  for (const target of TURN_USAGE_FIELDS) {
    const value = reportedCount(source[USAGE_SOURCE_FIELDS[target]]);
    if (value !== undefined) normalized[target] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export type RuntimeItem =
  | { id: string; phase?: 'commentary' | 'final_answer'; text: string; type: 'agent_message' }
  | {
      command: string;
      exitCode?: number;
      id: string;
      status: 'completed' | 'failed' | 'in_progress';
      type: 'command_execution';
    }
  | {
      changeCount: number;
      id: string;
      status: 'completed' | 'failed';
      type: 'file_change';
    }
  | {
      id: string;
      status: 'completed' | 'failed' | 'in_progress';
      type: 'mcp_tool_call';
    }
  | { id: string; text: string; type: 'reasoning' }
  | { id: string; query: string; type: 'web_search' }
  | {
      completedCount: number;
      id: string;
      totalCount: number;
      type: 'todo_list';
    }
  | { id: string; message: string; type: 'error' };

export type RuntimeEvent =
  | {
      commandId: string;
      elapsedMs?: number;
      stage: string;
      status: CadCompileProgressStatus;
      type: 'cad.compile.progress';
    }
  | { threadId: string; type: 'thread.started' }
  | { type: 'turn.started' }
  | {
      /** SDK-reported usage for this turn; absent when none was reported. */
      usage?: TurnUsage;
      type: 'turn.completed';
    }
  | { message: string; type: 'turn.failed' }
  | {
      item: RuntimeItem;
      type: 'item.completed' | 'item.started' | 'item.updated';
    }
  | { message: string; type: 'error' };

function normalizeThreadItem(item: ThreadItem): RuntimeItem {
  switch (item.type) {
    case 'agent_message': {
      // The current SDK types omit phase, but the stream may supply it.
      const { phase } = item as typeof item & { phase?: unknown };
      return {
        id: item.id,
        ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}),
        text: item.text,
        type: item.type,
      };
    }
    case 'command_execution':
      return {
        command: item.command,
        ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
        id: item.id,
        status: item.status,
        type: item.type,
      };
    case 'file_change':
      return {
        changeCount: item.changes.length,
        id: item.id,
        status: item.status,
        type: item.type,
      };
    case 'mcp_tool_call':
      return { id: item.id, status: item.status, type: item.type };
    case 'reasoning':
      return { id: item.id, text: item.text, type: item.type };
    case 'web_search':
      return { id: item.id, query: item.query, type: item.type };
    case 'todo_list':
      return {
        completedCount: item.items.filter(({ completed }) => completed).length,
        id: item.id,
        totalCount: item.items.length,
        type: item.type,
      };
    case 'error':
      return { id: item.id, message: item.message, type: item.type };
  }
}

export function normalizeThreadEvent(event: ThreadEvent): RuntimeEvent {
  switch (event.type) {
    case 'thread.started':
      return { threadId: event.thread_id, type: event.type };
    case 'turn.started':
      return { type: event.type };
    case 'turn.completed': {
      // The same snapshot is also returned by runTurn; never accumulate twice.
      const usage = normalizeTurnUsage(event.usage);
      return usage ? { type: event.type, usage } : { type: event.type };
    }
    case 'turn.failed':
      return { message: event.error.message, type: event.type };
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return { item: normalizeThreadItem(event.item), type: event.type };
    case 'error':
      return { message: event.message, type: event.type };
  }
}

export function isRuntimeProgressEvent(event: RuntimeEvent): boolean {
  return event.type !== 'error' && event.type !== 'turn.failed';
}
