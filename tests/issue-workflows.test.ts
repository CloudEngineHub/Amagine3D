import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-16T02:17:00Z');
const statuses = ['needs-info', 'planned', 'in-progress'];

type Issue = {
  number: number;
  state: string;
  labels: { name: string }[];
  updated_at: string;
  pull_request?: object;
  assignees?: object[];
  milestone?: object;
};
type Event = { id: number; event: string; label: { name: string } };

function issue(number: number, labels: string[] = [], idleDays = 0): Issue {
  return {
    number, state: 'open', labels: labels.map(name => ({ name })),
    updated_at: new Date(now - idleDays * day).toISOString(),
  };
}

function fixture(issues: Issue[], labelNames = statuses) {
  const labels = new Set(labelNames);
  const events = new Map<number, Event[]>();
  const fresh = new Map<number, Issue>();
  const comments: { issue_number: number; body: string }[] = [];
  const writes: { operation: string; input: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const find = (number: number) => {
    const found = issues.find(item => item.number === number);
    assert.ok(found, `Missing fixture issue #${number}`);
    return found;
  };
  const rest = {
    async listLabelsForRepo() { return [...labels].map(name => ({ name })); },
    async listForRepo(input: { state: string; labels?: string }) {
      return structuredClone(issues.filter(item =>
        (input.state === 'all' || item.state === input.state) &&
        (!input.labels || item.labels.some(label => label.name === input.labels)),
      ));
    },
    async listEvents(input: { issue_number: number }) { return events.get(input.issue_number) ?? []; },
    async get(input: { issue_number: number }) {
      return { data: structuredClone(fresh.get(input.issue_number) ?? find(input.issue_number)) };
    },
    async createLabel(input: { name: string }) {
      writes.push({ operation: 'createLabel', input });
      labels.add(input.name);
    },
    async updateLabel(input: { name: string; new_name: string }) {
      writes.push({ operation: 'updateLabel', input });
      labels.delete(input.name);
      labels.add(input.new_name);
      for (const item of issues) {
        for (const label of item.labels) {
          if (label.name === input.name) label.name = input.new_name;
        }
      }
    },
    async deleteLabel(input: { name: string }) {
      writes.push({ operation: 'deleteLabel', input });
      labels.delete(input.name);
      for (const item of issues) item.labels = item.labels.filter(label => label.name !== input.name);
    },
    async addLabels(input: { issue_number: number; labels: string[] }) {
      writes.push({ operation: 'addLabels', input });
      const item = find(input.issue_number);
      for (const name of input.labels) {
        if (!item.labels.some(label => label.name === name)) item.labels.push({ name });
      }
    },
    async removeLabel(input: { issue_number: number; name: string }) {
      writes.push({ operation: 'removeLabel', input });
      const item = find(input.issue_number);
      item.labels = item.labels.filter(label => label.name !== input.name);
    },
    async update(input: { issue_number: number; state: string; state_reason: string }) {
      writes.push({ operation: 'update', input });
      assert.equal(input.state_reason, 'not_planned');
      find(input.issue_number).state = input.state;
    },
    async createComment(input: { issue_number: number; body: string }) {
      writes.push({ operation: 'createComment', input });
      comments.push(input);
    },
  };
  return {
    issues, labels, events, fresh, comments, writes, logs,
    github: { rest: { issues: rest }, paginate: async (method: Function, input: unknown) => method(input) },
    core: { info: (message: string) => logs.push(message), warning: (message: string) => logs.push(message) },
  };
}

// Execute the actual github-script block with mocked GitHub APIs and a fixed
// clock, so tests cover the deployed workflow rather than a copy of its logic.
async function runWorkflow(
  name: 'issue-status' | 'stale-issues',
  state: ReturnType<typeof fixture>,
  options: { dryRun?: string; time?: number; issueNumber?: number } = {},
): Promise<void> {
  const yaml = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  const marker = '          script: |\n';
  assert.equal(yaml.split(marker).length, 2);
  const script = yaml.slice(yaml.indexOf(marker) + marker.length).replace(/^ {12}/gmu, '');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', 'Date', script);
  await execute(state.github, {
    repo: { owner: 'test', repo: 'test' }, ref: 'refs/heads/main',
    eventName: options.issueNumber ? 'issues' : 'workflow_dispatch',
    issue: { number: options.issueNumber },
  }, state.core, {
    env: { ISSUE_INACTIVITY_DRY_RUN: options.dryRun ?? 'false' },
  }, class extends Date { static now() { return options.time ?? now; } });
}

test('status sync leaves untriaged issues and unchanged statuses alone, including after replies', async () => {
  const state = fixture([
    issue(1), issue(2, ['bug']), issue(3, ['needs-info']),
    issue(4, ['planned']), issue(5, ['in-progress']),
  ]);
  await runWorkflow('issue-status', state);
  assert.deepEqual(state.writes, []);
  state.issues[2]!.updated_at = new Date(now + day).toISOString();
  await runWorkflow('issue-status', state, { issueNumber: 3 });
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.issues[2]!.labels, [{ name: 'needs-info' }]);
});

test('the last applied status replaces other statuses and preserves type labels', async () => {
  const state = fixture([issue(1, ['bug', ...statuses])]);
  state.events.set(1, statuses.map((name, index) => ({ id: index, event: 'labeled', label: { name } })));
  await runWorkflow('issue-status', state, { issueNumber: 1 });
  assert.deepEqual(state.issues[0]!.labels.map(label => label.name), ['bug', 'in-progress']);
});

test('migration preserves planned assignments and needs-info while retiring old labels', async () => {
  const state = fixture([
    issue(1, ['status: planned']),
    issue(2, ['status: in-progress']),
    issue(3, ['status: discussion', 'needs-info']),
    issue(4),
  ], ['status: planned', 'status: in-progress', 'status: discussion', 'needs-info', 'stale', 'no-stale']);
  await runWorkflow('issue-status', state);
  assert.deepEqual([...state.labels].sort(), [...statuses].sort());
  assert.deepEqual(state.issues.map(item => item.labels.map(label => label.name)), [
    ['planned'], ['in-progress'], ['needs-info'], [],
  ]);
});

test('migration merges an already-created destination label without losing issue assignments', async () => {
  const state = fixture([issue(1, ['status: planned', 'documentation'])], [...statuses, 'status: planned', 'documentation']);
  await runWorkflow('issue-status', state);
  assert.deepEqual(state.issues[0]!.labels.map(label => label.name), ['documentation', 'planned']);
  assert.equal(state.labels.has('status: planned'), false);
});

test('closes needs-info after 30 inactive days, leaving other states and PRs alone', async () => {
  const state = fixture([
    issue(1, ['needs-info'], 30), issue(2, ['needs-info'], 29.999),
    issue(3, [], 100), issue(4, ['bug'], 100),
    issue(5, ['planned', 'needs-info'], 100), issue(6, ['in-progress', 'needs-info'], 100),
    { ...issue(7, ['needs-info'], 100), pull_request: {} },
    { ...issue(8, ['needs-info'], 100), state: 'closed' },
    { ...issue(9, ['needs-info'], 31), assignees: [{}], milestone: {} },
  ]);
  await runWorkflow('stale-issues', state);
  assert.deepEqual(state.writes.filter(write => write.operation === 'update').map(write => write.input.issue_number), [1, 9]);
  assert.deepEqual(state.comments.map(comment => comment.issue_number), [1, 9]);
  assert.ok(state.writes.every(write => ['update', 'createComment'].includes(write.operation)));
  assert.deepEqual(state.issues[0]!.labels, [{ name: 'needs-info' }]);
});

test('activity restarts the 30-day clock and retains needs-info before eventual closure', async () => {
  const state = fixture([issue(1, ['needs-info'], 1)]);
  await runWorkflow('stale-issues', state);
  assert.deepEqual(state.writes, []);
  await runWorkflow('stale-issues', state, { time: now + 28 * day });
  assert.deepEqual(state.writes, []);
  await runWorkflow('stale-issues', state, { time: now + 29 * day });
  assert.equal(state.issues[0]!.state, 'closed');
  assert.deepEqual(state.issues[0]!.labels, [{ name: 'needs-info' }]);
});

test('rechecks activity and status immediately before closing', async () => {
  const state = fixture([issue(1, ['needs-info'], 31), issue(2, ['needs-info'], 31), issue(3, ['needs-info'], 31)]);
  state.fresh.set(1, issue(1, ['needs-info'], 0));
  state.fresh.set(2, issue(2, ['planned'], 31));
  state.fresh.set(3, issue(3, [], 31));
  await runWorkflow('stale-issues', state);
  assert.deepEqual(state.writes, []);
});

test('preview mode reports eligible issues without modifying them', async () => {
  const state = fixture([issue(1, ['needs-info'], 40)]);
  await runWorkflow('stale-issues', state, { dryRun: 'true' });
  assert.deepEqual(state.writes, []);
  assert.ok(state.logs.some(message => message.includes('Would close #1')));
});
