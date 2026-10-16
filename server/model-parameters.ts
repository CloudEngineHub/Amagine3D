import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ArtifactSummary, ModelParameter, ParameterModel } from '../src/types.ts';
import { readActiveDesignBinding } from './cad-run-evidence.ts';
import { discoverModelBuilds } from './model-builds.ts';
import type { ParameterBuildRequest } from './trpc/schemas.ts';

const CLI = resolve(import.meta.dirname, '../bin/a3d.mjs');
const MAX_OUTPUT = 2 * 1024 * 1024;

export class ParameterBuildError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ParameterBuildError';
  }
}

function hash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function agent(workspaceRoot: string, operation: string, request: Record<string, unknown>): Promise<Record<string, any>> {
  const directory = join(workspaceRoot, '.a3d-agent', 'parameter-requests');
  await mkdir(directory, { recursive: true });
  const requestDir = await mkdtemp(join(directory, 'request-'));
  const argsFile = join(requestDir, 'request.json');
  try {
    const canonicalRoot = await realpath(workspaceRoot);
    const canonicalRequest = await realpath(requestDir);
    const requestLocal = relative(canonicalRoot, canonicalRequest);
    if (!requestLocal || isAbsolute(requestLocal) || requestLocal === '..' || requestLocal.startsWith(`..${sep}`)) {
      throw new ParameterBuildError('Parameter request escaped the session workspace.', 400);
    }
    await writeFile(argsFile, JSON.stringify(request), 'utf8');
    const output = await new Promise<{ stdout: string; stderr: string; code: number }>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [CLI, 'agent', operation, '--args-file', relative(canonicalRoot, argsFile)], {
        cwd: workspaceRoot,
        detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (error?: Error, result?: { stdout: string; stderr: string; code: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error); else resolvePromise(result!);
      };
      const terminate = () => {
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.once('error', () => child.kill('SIGKILL'));
          killer.unref();
        } else child.kill('SIGKILL');
      };
      const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) {
          terminate();
          finish(new ParameterBuildError('CAD parameter process produced too much output.', 422));
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.once('error', (error) => finish(error));
      child.once('close', (code) => finish(undefined, { stdout, stderr, code: code ?? 1 }));
      timer = setTimeout(() => {
        terminate();
        finish(new ParameterBuildError('CAD parameter build timed out.', 422));
      }, 180_000);
    });
    let result: Record<string, any>;
    try { result = JSON.parse(output.stdout) as Record<string, any>; }
    catch { throw new ParameterBuildError(output.stderr.trim().slice(-2_000) || 'CAD parameter operation returned invalid JSON.', 422); }
    if (result.status === 'failed' || result.status === 'api-error' || output.code !== 0) {
      let reportIssue: string | undefined;
      if (result.report?.path && /^[a-f0-9]{64}$/u.test(result.report.sha256 ?? '')) {
        try {
          const root = await realpath(workspaceRoot);
          const reportPath = await realpath(resolve(root, result.report.path));
          const local = relative(root, reportPath);
          if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && (await stat(reportPath)).size <= MAX_OUTPUT) {
            const reportBytes = await readFile(reportPath);
            if (hash(reportBytes) === result.report.sha256) {
              const report = JSON.parse(reportBytes.toString('utf8'));
              reportIssue = report.issues?.[0]?.message;
            }
          }
        } catch { /* Preserve the bounded error if the optional report cannot be read. */ }
      }
      const issue = result.error?.message ?? result.issues?.[0]?.message ?? reportIssue ??
        (result.issues?.[0] ? JSON.stringify(result.issues[0]) : undefined);
      const detail = issue ?? JSON.stringify(result).slice(0, 1_500);
      throw new ParameterBuildError(detail || `CAD ${operation} failed (${result.status ?? output.code}).`, result.status === 'failed' ? 422 : 409);
    }
    return result;
  } finally {
    await rm(requestDir, { recursive: true, force: true });
  }
}

async function readDesignParameters(workspaceRoot: string, designPath: string, revision: string): Promise<ModelParameter[]> {
  const source = resolve(workspaceRoot, designPath);
  const root = await realpath(workspaceRoot);
  const path = await realpath(source);
  const local = relative(root, path);
  const bytes = await readFile(path);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || hash(bytes) !== revision) {
    throw new ParameterBuildError('The active design changed; reload parameters before editing.', 409);
  }
  const document = JSON.parse(bytes.toString('utf8')) as Record<string, any>;
  const definitions = document.params && typeof document.params === 'object' && !Array.isArray(document.params)
    ? document.params as Record<string, Record<string, any>> : {};
  const parameters: ModelParameter[] = [];
  for (const [id, definition] of Object.entries(definitions)) {
    if (!definition || !['length', 'angle', 'scalar', 'integer'].includes(definition.type) ||
      typeof definition.value !== 'number' || !Number.isFinite(definition.value)) continue;
    const range = Array.isArray(definition.range) ? definition.range : undefined;
    const minimum = typeof range?.[0] === 'number' ? range[0] : undefined;
    const maximum = typeof range?.[1] === 'number' ? range[1] : undefined;
    const rawLabel = definition.label;
    const label = rawLabel && typeof rawLabel === 'object' && !Array.isArray(rawLabel) &&
      typeof rawLabel.en === 'string' && typeof rawLabel.zh === 'string'
      ? { en: rawLabel.en, zh: rawLabel.zh }
      : undefined;
    parameters.push({
      id, kind: definition.type === 'integer' ? 'integer' : 'number',
      step: definition.type === 'integer' ? 1 : 0.01,
      ...(label ? { label } : {}),
      ...(definition.type === 'length' ? { unit: 'mm' } : definition.type === 'angle' ? { unit: 'deg' } : {}),
      ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}),
      value: definition.value,
    });
  }
  return parameters;
}

export async function parameterModelsForWorkspace(
  workspaceRoot: string,
  artifacts: readonly ArtifactSummary[],
): Promise<ParameterModel[]> {
  const binding = await readActiveDesignBinding(workspaceRoot);
  if (!binding) return [];
  const availableArtifacts = artifacts;
  const builds = await discoverModelBuilds(workspaceRoot, availableArtifacts);
  const related = builds.flatMap((build) => {
    const evidence = availableArtifacts.find((artifact) => artifact.kind === 'model' &&
      build.artifactPaths.includes(artifact.path) && artifact.designPath === binding.designPath);
    return evidence ? [{ build, evidence }] : [];
  });
  const associated = new Set(related.flatMap(({ build }) => build.artifactPaths));
  const fallbackRuns = new Map<string, ArtifactSummary[]>();
  for (const evidence of availableArtifacts) {
    if (evidence.kind !== 'model' || evidence.designPath !== binding.designPath || associated.has(evidence.path)) continue;
    const key = evidence.buildId ?? evidence.path;
    fallbackRuns.set(key, [...(fallbackRuns.get(key) ?? []), evidence]);
  }
  for (const [runId, members] of fallbackRuns) {
    const primary = members.find((artifact) => artifact.primary) ?? members[0]!;
    const paths = members.map((artifact) => artifact.path);
    related.push({ evidence: primary, build: {
      artifactPaths: paths, displayPreviewPath: members.find((artifact) => artifact.purpose === 'display-preview')?.path ?? primary.path,
      modelId: primary.modelId ?? primary.name, primaryPreviewPath: primary.path, reportPath: '',
      topLevelArtifactPaths: paths, runId: runId === primary.path ? primary.buildId : runId,
    } });
  }
  if (!related.length) return [];
  const parameters = await readDesignParameters(workspaceRoot, binding.designPath, binding.revision);
  const newest = (items: typeof related) => [...items].sort((left, right) => Date.parse(right.evidence.modifiedAt) - Date.parse(left.evidence.modifiedAt))[0];
  const currentGroup = newest(related.filter(({ evidence }) => evidence.revision === binding.revision && evidence.inputsCurrent === true)) ??
    newest(related);
  return related.map(({ build, evidence }) => {
    const activeDesign = currentGroup === related.find((group) => group.build.runId === build.runId && group.evidence.path === evidence.path);
    const buildStatus = activeDesign ? binding.buildStatus : evidence.status === 'diagnostic' ? 'failed' : evidence.status;
    return {
      artifactPaths: build.artifactPaths,
      displayPreviewPath: build.displayPreviewPath,
      modelId: build.modelId,
      parameters: activeDesign ? parameters : [],
      primaryPreviewPath: build.primaryPreviewPath,
      reportPath: build.reportPath,
      designPath: binding.designPath,
      revision: activeDesign ? binding.revision : evidence.revision ?? '',
      editable: activeDesign,
      previewStale: activeDesign && (evidence.inputsCurrent !== true || evidence.revision !== binding.revision),
      ...(buildStatus ? { buildStatus } : {}),
      ...(build.runId ? { runId: build.runId } : {}),
      ...(!activeDesign ? { parameterError: 'This model is from an earlier design revision and is read-only.' } : {}),
    };
  });
}

export async function rebuildModelWithParameters(options: {
  request: ParameterBuildRequest;
  workspaceRoot: string;
}): Promise<void> {
  const { request, workspaceRoot } = options;
  const binding = await readActiveDesignBinding(workspaceRoot);
  if (!binding || binding.designPath !== request.designPath || binding.revision !== request.revision) {
    throw new ParameterBuildError('The selected design changed; reload before rebuilding.', 409);
  }
  if (binding.intentStale) throw new ParameterBuildError('The active intent changed; refresh the project context before rebuilding.', 409);
  if (!binding.intentPath) throw new ParameterBuildError('Parameter rebuild requires a hash-bound active intent.', 409);
  const parameters = await readDesignParameters(workspaceRoot, binding.designPath, binding.revision);
  const byId = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  const changes = Object.entries(request.values).map(([id, value]) => {
    const parameter = byId.get(id);
    if (!parameter) throw new ParameterBuildError(`Parameter ${id} is derived or unavailable.`, 400);
    if (parameter.minimum !== undefined && value < parameter.minimum || parameter.maximum !== undefined && value > parameter.maximum ||
      parameter.kind === 'integer' && !Number.isInteger(value)) {
      throw new ParameterBuildError(`Parameter ${id} is outside its declared range or type.`, 400);
    }
    return { kind: 'update', target: `params.${id}`, set: { value } };
  });
  const applied = await agent(workspaceRoot, 'design', {
    action: 'apply', design: binding.designPath, baseRevision: binding.revision, changes,
  });
  if (typeof applied.revision !== 'string') throw new ParameterBuildError('Design edit returned no revision.', 422);
  await agent(workspaceRoot, 'build', {
    phase: 'compile', design: binding.designPath, revision: applied.revision,
    timeoutSeconds: 165,
    intent: binding.intentPath,
  });
}
