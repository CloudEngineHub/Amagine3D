import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createApp } from '../server/app.ts';

const sessionId = '3b0d4f25-1707-4cc8-92cf-6f5c28edfc93';
const artifactBase = `/api/sessions/${sessionId}/artifacts`;
const model = 'solid part\nendsolid part\n';
const source = 'globalThis.artifactExecuted = true;';

async function serveFixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'amagine-http-security-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    bundledPomodoroRoot: join(root, 'bundled'),
    distPath: join(root, 'dist'),
    projectRoot: root,
    sessionRoot: join(root, 'state', 'sessions'),
    workspaceRoot: join(root, 'workspace'),
  };
  const sessionWorkspace = join(paths.workspaceRoot, 'sessions', sessionId);
  await Promise.all([
    mkdir(join(paths.distPath, 'assets'), { recursive: true }),
    mkdir(paths.bundledPomodoroRoot),
    mkdir(paths.sessionRoot, { recursive: true }),
    mkdir(sessionWorkspace, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(paths.distPath, 'index.html'), '<!doctype html><title>Workbench</title>'),
    writeFile(join(paths.distPath, 'assets', 'app.js'), 'globalThis.appLoaded = true;'),
    writeFile(join(paths.bundledPomodoroRoot, 'model.stl'), model),
    writeFile(join(sessionWorkspace, 'model.stl'), model),
    ...['source.js', 'source.mjs'].map((name) =>
      writeFile(join(sessionWorkspace, name), source),
    ),
  ]);
  const app = createApp({
    paths,
    python: { executable: null, ready: false, version: null },
    runtime: undefined,
    runtimeError: 'Runtime unavailable in test.',
  });
  app.set('env', 'test');
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function assertBaselineHeaders(response: Response): void {
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.ok(response.headers.get('content-security-policy'));
}

test('protects built HTML, SPA fallbacks, static scripts, and API responses', async (context) => {
  const origin = await serveFixture(context);
  for (const path of ['/', '/workbench/session', '/assets/app.js', '/trpc/health']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assertBaselineHeaders(response);
    const directives = new Map(response.headers.get('content-security-policy')!
      .split(';').map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/u);
        return [name, sources];
      }));
    for (const directive of ['default-src', 'script-src', 'connect-src']) {
      assert.deepEqual(directives.get(directive), ["'self'"], directive);
    }
    for (const directive of ['object-src', 'frame-src', 'frame-ancestors', 'base-uri', 'worker-src']) {
      assert.deepEqual(directives.get(directive), ["'none'"], directive);
    }
    assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'blob:']);
    assert.deepEqual(directives.get('style-src'), ["'self'", "'unsafe-inline'"]);
    if (path === '/assets/app.js') {
      assert.match(response.headers.get('content-type')!, /javascript/u);
    }
    await response.arrayBuffer();
  }
});

test('retains security headers on invalid JSON, oversized bodies, and missing artifacts', async (context) => {
  const origin = await serveFixture(context);
  for (const [body, status] of [
    ['{', 400],
    [JSON.stringify({ payload: 'x'.repeat(18 * 1024 * 1024) }), 413],
  ] as const) {
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, status);
    assertBaselineHeaders(response);
    // Express's error handler replaces CSP with a fully restrictive policy.
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
    await response.arrayBuffer();
  }
  const missing = await fetch(`${origin}${artifactBase}/file?path=missing.stl`);
  assert.equal(missing.status, 404);
  assertBaselineHeaders(missing);
  await missing.arrayBuffer();
});

test('keeps artifact caching distinct and generated JavaScript non-executable', async (context) => {
  const origin = await serveFixture(context);
  for (const name of ['model.stl', 'source.js', 'source.mjs']) {
    const response = await fetch(`${origin}${artifactBase}/file?path=${name}`);
    assert.equal(response.status, 200);
    assertBaselineHeaders(response);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (name.startsWith('source.')) {
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(await response.text(), source);
    } else {
      assert.equal(await response.text(), model);
    }
  }
  const bundled = await fetch(`${origin}/api/bundled-artifacts/file?path=model.stl`);
  assertBaselineHeaders(bundled);
  assert.equal(bundled.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await bundled.text(), model);

  const archive = await fetch(`${origin}${artifactBase}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: ['model.stl', 'source.js'] }),
  });
  assert.equal(archive.status, 200);
  assertBaselineHeaders(archive);
  assert.equal(archive.headers.get('cache-control'), 'no-store');
  assert.match(archive.headers.get('content-disposition')!, /^attachment;/u);
  assert.ok((await archive.arrayBuffer()).byteLength > 0);
});

test('does not grant cross-origin API access or preflight permission', async (context) => {
  const origin = await serveFixture(context);
  for (const method of ['GET', 'OPTIONS']) {
    const response = await fetch(`${origin}/trpc/health`, {
      method,
      headers: {
        Origin: 'https://untrusted.example',
        ...(method === 'OPTIONS' ? {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        } : {}),
      },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    await response.arrayBuffer();
  }
});
