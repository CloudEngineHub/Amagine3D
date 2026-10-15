import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import type { ArtifactSummary } from '../src/types.ts';
import {
  type UnifiedBuildReport,
  reportPrintPlates,
  validateUnifiedBuildReport,
} from './build-report.ts';
import { resolveArtifactPath } from './artifacts.ts';

const MAX_BUILD_REPORT_BYTES = 2 * 1024 * 1024;

export interface ModelBuild {
  legacy?: boolean;
  cadArtifactPath?: string;
  artifactPaths: string[];
  displayPreviewPath: string;
  modelId: string;
  primaryPreviewPath: string;
  reportPath: string;
  sourcePath?: string;
  partArtifacts?: { partId: string; path: string }[];
  topLevelArtifactPaths: string[];
  runId?: string;
  printPlates?: { id: string; stlPath: string; threeMfPath: string }[];
}

function safeRelativePath(root: string, candidate: string): string | undefined {
  const path = relative(root, candidate);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`)) {
    return undefined;
  }
  return path.split(sep).join('/');
}

function primaryArtifactKey(
  report: UnifiedBuildReport,
): '3mf' | 'stl' | undefined {
  const parts = report.artifactMatrix?.parts;
  if (!parts || Object.keys(parts).length === 0) return undefined;
  const records = Object.values(parts);
  if (
    records.some(
      (record) =>
        record?.stl !== 'required' ||
        record?.displayStep !== 'required' ||
        !['required', 'not-applicable'].includes(String(record?.step)) ||
        !['required', 'not-applicable'].includes(String(record?.threeMf)),
    )
  ) {
    return undefined;
  }
  const backend = String(report.backend);
  const requiresThreeMf = records.some(
    (record) => record.threeMf === 'required',
  );
  if (
    (['brep-color-regions', 'hybrid-mesh'].includes(backend) &&
      !requiresThreeMf) ||
    (backend.startsWith('brep-') &&
      records.some((record) => record.step !== 'required'))
  ) {
    return undefined;
  }
  return requiresThreeMf ? '3mf' : 'stl';
}

function primaryArtifactReferenceKey(
  report: UnifiedBuildReport,
  key: '3mf' | 'stl',
): string | undefined {
  if (report.artifacts?.[key] || key === '3mf') return key;
  const partIds = Object.keys(report.artifactMatrix?.parts ?? {});
  return partIds.length === 1 ? `stl:${partIds[0]}` : undefined;
}

async function legacyModel(root: string, reportPath: string, localReport: string): Promise<ModelBuild | undefined> {
  try {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (report.schema !== 'evidence-a3d-build/v1' || !String(report.backend).startsWith('brep-')) return;
    const paths: Record<string, string> = {};
    for (const [key, ref] of Object.entries(report.artifacts ?? {})) {
      if (key === 'step:display') continue;
      if (!key.startsWith('step:') && !key.startsWith('stl') && key !== '3mf' && !/^plate:\d+:(stl|3mf)$/u.test(key)) continue;
      const file = ref as { path: string; sha256: string };
      try {
        const local = safeRelativePath(root, await realpath(resolvePath(reportPath, file.path)));
        if (!local) return;
        const candidate = await resolveArtifactPath(root, local);
        if (!candidate || createHash('sha256').update(await readFile(candidate)).digest('hex') !== file.sha256) continue;
        paths[key] = local;
      } catch { /* A missing old print/source file does not hide a bound CAD file. */ }
    }
    const cad = paths['step:assembly'] ?? Object.entries(paths).find(([key]) => key.startsWith('step:'))?.[1];
    if (!cad) return;
    let source: string | undefined;
    const ref = report.inputs?.source;
    if (ref) {
      try {
        source = safeRelativePath(root, await realpath(resolvePath(reportPath, ref.path)));
        const candidate = source && await resolveArtifactPath(root, source);
        if (!candidate || createHash('sha256').update(await readFile(candidate)).digest('hex') !== ref.sha256) source = undefined;
      } catch { source = undefined; }
    }
    const primary = paths['3mf'] ?? paths.stl ?? Object.entries(paths).find(([key]) => key.startsWith('stl:'))?.[1] ?? cad;
    return { legacy: true, cadArtifactPath: cad, artifactPaths: Object.values(paths), displayPreviewPath: cad,
      modelId: String(report.part), primaryPreviewPath: primary, reportPath: localReport,
      ...(source ? { sourcePath: source } : {}), topLevelArtifactPaths: [...new Set([cad, primary])], runId: report.runId };
  } catch { return undefined; }
}

function resolvePath(report: string, file: string): string {
  return resolve(dirname(report), file);
}

export async function discoverModelBuilds(
  workspaceRoot: string,
  artifacts: readonly ArtifactSummary[],
): Promise<ModelBuild[]> {
  const builds: ModelBuild[] = [];
  const canonicalRoot = await realpath(workspaceRoot);
  for (const artifact of artifacts) {
    if (
      artifact.kind !== 'report' ||
      !artifact.name.endsWith('_report.json') ||
      artifact.size > MAX_BUILD_REPORT_BYTES
    ) {
      continue;
    }
    const reportPath = await resolveArtifactPath(workspaceRoot, artifact.path);
    if (!reportPath) continue;
    const validated = await validateUnifiedBuildReport(
      workspaceRoot,
      reportPath,
      { maxBytes: MAX_BUILD_REPORT_BYTES },
    );
    if (!validated) {
      const legacy = await legacyModel(canonicalRoot, reportPath, artifact.path);
      if (legacy) builds.push(legacy);
      continue;
    }
    const report = validated.report;
    const primaryKey = primaryArtifactKey(report);
    if (!primaryKey) continue;
    const primaryReference = primaryArtifactReferenceKey(report, primaryKey);
    const primaryPreviewPath = primaryReference
      ? safeRelativePath(
          canonicalRoot,
          validated.artifactPaths[primaryReference] ?? '',
        )
      : undefined;
    const displayPreviewPath = safeRelativePath(
      canonicalRoot,
      validated.artifactPaths['step:display'] ?? '',
    );
    if (!primaryPreviewPath || !displayPreviewPath) continue;
    const sourcePath = validated.inputPaths.source
      ? safeRelativePath(canonicalRoot, validated.inputPaths.source)
      : undefined;
    const artifactPaths = [
      ...new Set(
        Object.values(validated.artifactPaths)
          .map((path) => safeRelativePath(canonicalRoot, path))
          .filter((path): path is string => Boolean(path)),
      ),
    ];
    const topLevelArtifactPaths = [
      displayPreviewPath,
      primaryPreviewPath,
      ...['3mf', 'stl'].map((key) =>
        safeRelativePath(
          canonicalRoot,
          validated.artifactPaths[key] ?? '',
        ),
      ),
    ].filter((path): path is string => Boolean(path));
    const cadKey = validated.artifactPaths['step:assembly'] ? 'step:assembly'
      : Object.keys(validated.artifactPaths).find((key) => key === 'step' || (key.startsWith('step:') && key !== 'step:display'));
    const cadArtifactPath = cadKey ? safeRelativePath(canonicalRoot, validated.artifactPaths[cadKey]!) : undefined;
    if (cadArtifactPath) topLevelArtifactPaths.push(cadArtifactPath);
    const printPlates = reportPrintPlates(report).map((plate) => ({
      id: plate.id,
      stlPath: safeRelativePath(canonicalRoot, validated.artifactPaths[plate.stlKey]!)!,
      threeMfPath: safeRelativePath(canonicalRoot, validated.artifactPaths[plate.threeMfKey]!)!,
    }));
    topLevelArtifactPaths.push(...printPlates.flatMap((plate) => [plate.stlPath, plate.threeMfPath]));
    builds.push({
      ...(cadArtifactPath ? { cadArtifactPath } : {}),
      artifactPaths,
      displayPreviewPath,
      modelId:
        typeof report.part === 'string' && report.part.trim()
          ? report.part
          : basename(primaryPreviewPath, `.${primaryKey}`),
      primaryPreviewPath,
      reportPath: artifact.path,
      ...(sourcePath ? { sourcePath } : {}),
      partArtifacts: Object.keys(report.artifactMatrix?.parts ?? {}).flatMap((partId) =>
        ['step', 'stl', '3mf'].flatMap((format) => {
          const path = validated.artifactPaths[`${format}:${partId}`];
          const local = path ? safeRelativePath(canonicalRoot, path) : undefined;
          return local && !topLevelArtifactPaths.includes(local) ? [{ partId, path: local }] : [];
        }),
      ),
      topLevelArtifactPaths: [...new Set(topLevelArtifactPaths)],
      ...(typeof report.runId === 'string' ? { runId: report.runId } : {}),
      ...(printPlates.length ? { printPlates } : {}),
    });
  }
  return builds.sort((left, right) =>
    left.primaryPreviewPath.localeCompare(right.primaryPreviewPath),
  );
}
