import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  cadSystemDescriptor,
  DEFAULT_CAD_SYSTEM,
  isCadSystem,
  type CadSystem,
} from '@amagine3d/a3d-runtime';

import {
  BUNDLED_POMODORO_SESSION_ID,
  type ArtifactCollection,
  type ChatMessage,
  type ChatTurn,
  type SessionCatalog,
  type SessionSummary,
  type WorkspaceStorage,
} from '../src/types.ts';
import { USER_SESSION_ID } from '../src/session-id.ts';
import { scanArtifacts } from './artifacts.ts';
import { readCadRunArtifacts } from './cad-run-evidence.ts';
import { bundledPomodoroArtifacts } from './bundled-workspace.ts';
import { discoverModelBuilds } from './model-builds.ts';

const SESSION_VERSION = 1;
const BUILTIN_CREATED_AT = '2026-08-19T15:34:44.000Z';

interface StoredSession {
  cadSystem?: CadSystem;
  codexThreadId?: string;
  createdAt: string;
  id: string;
  messages: ChatMessage[];
  updatedAt: string;
  version: typeof SESSION_VERSION;
}

export interface UserSessionInfo {
  createdAt: string;
  id: string;
  path: string;
  updatedAt: string;
}

export const BUILTIN_POMODORO_SESSION: SessionSummary = {
  createdAt: BUILTIN_CREATED_AT,
  id: BUNDLED_POMODORO_SESSION_ID,
  kind: 'builtin',
  persisted: true,
  readOnly: true,
  title: 'Amagine3D Pomodoro Timer',
  updatedAt: BUILTIN_CREATED_AT,
};

function sessionPath(sessionRoot: string, sessionId: string): string {
  return join(sessionRoot, `${sessionId}.json`);
}

function cleanTitle(value: string): string {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return 'Image CAD session';
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

function validStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredSession>;
  return (
    item.version === SESSION_VERSION &&
    typeof item.id === 'string' &&
    USER_SESSION_ID.test(item.id) &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    Array.isArray(item.messages) &&
    (item.cadSystem === undefined || isCadSystem(item.cadSystem)) &&
    (item.codexThreadId === undefined || typeof item.codexThreadId === 'string')
  );
}

async function readStoredSession(path: string): Promise<StoredSession | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return validStoredSession(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeStoredSession(
  sessionRoot: string,
  session: StoredSession,
): Promise<void> {
  await mkdir(sessionRoot, { recursive: true });
  const destination = sessionPath(sessionRoot, session.id);
  const temporary = join(sessionRoot, `.${session.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
    flag: 'wx',
  });
  await rename(temporary, destination);
}

async function loadOrCreateSession(
  sessionRoot: string,
  sessionId: string,
): Promise<StoredSession> {
  if (!USER_SESSION_ID.test(sessionId)) throw new Error('Invalid session id.');
  const existing = await readStoredSession(sessionPath(sessionRoot, sessionId));
  if (existing) return existing;
  const timestamp = new Date().toISOString();
  return {
    cadSystem: DEFAULT_CAD_SYSTEM,
    createdAt: timestamp,
    id: sessionId,
    messages: [],
    updatedAt: timestamp,
    version: SESSION_VERSION,
  };
}

function summary(session: StoredSession): SessionSummary {
  const firstUserMessage = session.messages.find(
    (message) => message.role === 'user',
  );
  return {
    cadSystem: session.cadSystem ?? DEFAULT_CAD_SYSTEM,
    createdAt: session.createdAt,
    id: session.id,
    kind: 'user',
    persisted: true,
    readOnly: false,
    title: cleanTitle(firstUserMessage?.text ?? ''),
    updatedAt: session.updatedAt,
  };
}

async function storedSessions(
  sessionRoot: string,
): Promise<Array<{ path: string; session: StoredSession }>> {
  let names: string[];
  try {
    names = await readdir(sessionRoot);
  } catch {
    return [];
  }
  const loaded = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const path = join(sessionRoot, name);
        const session = await readStoredSession(path);
        return session ? { path, session } : undefined;
      }),
  );
  return loaded
    .filter((item) => item !== undefined)
    .sort((left, right) =>
      right.session.updatedAt.localeCompare(left.session.updatedAt),
    );
}

export function sessionWorkspaceRoot(
  workspaceRoot: string,
  sessionId: string,
): string | undefined {
  return USER_SESSION_ID.test(sessionId)
    ? join(workspaceRoot, 'sessions', sessionId)
    : undefined;
}

export async function appendSessionUserMessage(
  sessionRoot: string,
  sessionId: string,
  text: string,
  cadSystem: CadSystem = DEFAULT_CAD_SYSTEM,
): Promise<void> {
  const session = await loadOrCreateSession(sessionRoot, sessionId);
  if (session.messages.length > 0) {
    // Existing history locks to one system. A missing field is legacy default.
    const locked = session.cadSystem ?? DEFAULT_CAD_SYSTEM;
    if (locked !== cadSystem) {
      throw new Error('This session already uses a different CAD system.');
    }
  }
  session.cadSystem = cadSystem;
  session.messages.push({ id: randomUUID(), role: 'user', text });
  session.updatedAt = new Date().toISOString();
  await writeStoredSession(sessionRoot, session);
}

export async function appendSessionAssistantTurn(
  sessionRoot: string,
  sessionId: string,
  turn: ChatTurn,
): Promise<void> {
  const session = await loadOrCreateSession(sessionRoot, sessionId);
  session.messages.push({ id: randomUUID(), role: 'assistant', ...turn });
  session.updatedAt = new Date().toISOString();
  await writeStoredSession(sessionRoot, session);
}

export async function sessionCadSystem(
  sessionRoot: string,
  sessionId: string,
  requested: CadSystem = DEFAULT_CAD_SYSTEM,
): Promise<CadSystem> {
  const session = await readStoredSession(sessionPath(sessionRoot, sessionId));
  if (!session) {
    cadSystemDescriptor(requested);
    return requested;
  }
  // Existing sessions keep one system. A missing field is legacy default.
  const effective = session.cadSystem ?? DEFAULT_CAD_SYSTEM;
  if (requested !== effective) {
    throw new Error(
      'This session uses a different CAD system. Start a new project to switch systems.',
    );
  }
  cadSystemDescriptor(effective);
  return effective;
}

export async function readSessionThreadId(
  sessionRoot: string,
  sessionId: string,
): Promise<string | undefined> {
  return (await readStoredSession(sessionPath(sessionRoot, sessionId)))
    ?.codexThreadId;
}

export async function setSessionThreadId(
  sessionRoot: string,
  sessionId: string,
  threadId: string,
): Promise<void> {
  const session = await loadOrCreateSession(sessionRoot, sessionId);
  session.codexThreadId = threadId;
  session.updatedAt = new Date().toISOString();
  await writeStoredSession(sessionRoot, session);
}

export async function listSessionCatalog(
  sessionRoot: string,
): Promise<SessionCatalog> {
  const userSessions = (await storedSessions(sessionRoot)).map(({ session }) =>
    summary(session),
  );
  return {
    initialSessionId: userSessions[0]?.id ?? BUNDLED_POMODORO_SESSION_ID,
    sessions: [...userSessions, BUILTIN_POMODORO_SESSION],
  };
}

export async function listWorkspaceStorage(
  sessionRoot: string,
  workspaceRoot: string,
  bundledPomodoroRoot: string,
): Promise<WorkspaceStorage> {
  const catalog = await listSessionCatalog(sessionRoot);
  const groups = await Promise.all(
    catalog.sessions.map(async (session) => {
      const collection = await artifactsForSession(
        workspaceRoot,
        bundledPomodoroRoot,
        session.id,
      );
      return collection ? { ...collection, session } : undefined;
    }),
  );
  return { groups: groups.filter((group) => group !== undefined) };
}

export async function findUserSession(
  sessionRoot: string,
  sessionId: string,
): Promise<UserSessionInfo | undefined> {
  if (!USER_SESSION_ID.test(sessionId)) return undefined;
  const path = sessionPath(sessionRoot, sessionId);
  const session = await readStoredSession(path);
  return session
    ? {
        createdAt: session.createdAt,
        id: session.id,
        path,
        updatedAt: session.updatedAt,
      }
    : undefined;
}

export async function readSessionMessages(path: string): Promise<ChatMessage[]> {
  return (await readStoredSession(path))?.messages ?? [];
}

export async function userSessionArtifacts(
  workspaceRoot: string,
  sessionId: string,
): Promise<ArtifactCollection | undefined> {
  const root = sessionWorkspaceRoot(workspaceRoot, sessionId);
  if (!root) return undefined;
  const scannedArtifacts = await scanArtifacts(root);
  const stagedArtifacts = await readCadRunArtifacts(root);
  const builds = await discoverModelBuilds(root, scannedArtifacts);
  const featuredPaths = new Set(
    builds.map(({ displayPreviewPath }) => displayPreviewPath),
  );
  const primaryPaths = new Set(
    builds.flatMap(({ topLevelArtifactPaths }) => topLevelArtifactPaths),
  );
  const legacyPaths = new Set(builds.filter((build) => build.legacy).flatMap((build) => build.artifactPaths));
  const displayMetadata = new Map(builds.flatMap((build) =>
    build.topLevelArtifactPaths.map((path) => {
      const plate = build.printPlates?.find((item) => item.stlPath === path || item.threeMfPath === path);
      return [path, { modelId: build.modelId, buildId: build.runId, ...(build.legacy ? { legacy: true, readOnly: true } : {}),
        ...(plate ? { plateId: plate.id } : {}) }] as const;
    }),
  ));
  const combined = new Map(scannedArtifacts.map((artifact) => [artifact.path, artifact]));
  for (const artifact of stagedArtifacts) combined.set(artifact.path, artifact);
  const artifacts = [...combined.values()].map((artifact) => ({
    ...artifact,
    ...displayMetadata.get(artifact.path),
    ...(featuredPaths.has(artifact.path) ? { featured: true } : {}),
    ...(primaryPaths.has(artifact.path) ? { primary: artifact.purpose !== 'internal-evidence' || artifact.status === undefined,
      manufacturingStatus: artifact.manufacturingStatus ?? (legacyPaths.has(artifact.path) ? undefined : 'pending'),
      status: artifact.status ?? (legacyPaths.has(artifact.path) ? 'diagnostic' as const : 'validated' as const),
      purpose: artifact.status !== undefined ? artifact.purpose : artifact.format === 'step' ? featuredPaths.has(artifact.path) ? 'display-preview' as const : 'cad-model' as const : artifact.format ? 'print-package' as const : 'cad-model' as const } : {}),
    ...(artifact.previewImagePath ? { previewImageUrl: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/file?path=${encodeURIComponent(artifact.previewImagePath)}` } : {}),
    url: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/file?path=${encodeURIComponent(artifact.path)}`,
  }));
  return {
    artifacts,
    artifactWorkspace: {
      id: sessionId,
      name: 'Workspace',
      path: `workspace/sessions/${sessionId}/`,
      readOnly: false,
      sessionId,
    },
  };
}

export async function artifactsForSession(
  workspaceRoot: string,
  bundledPomodoroRoot: string,
  sessionId: string,
): Promise<ArtifactCollection | undefined> {
  if (sessionId === BUNDLED_POMODORO_SESSION_ID) {
    return bundledPomodoroArtifacts(bundledPomodoroRoot);
  }
  return userSessionArtifacts(workspaceRoot, sessionId);
}
