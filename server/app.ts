import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express, { type Express } from 'express';

import { registerArtifactRoutes } from './routes/artifacts.ts';
import { registerChatRoute, type TurnExecutorOpener } from './routes/chat.ts';
import type { TrpcContext } from './trpc/context.ts';
import { appRouter } from './trpc/router.ts';

export type AppDependencies = TrpcContext & {
  openTurnExecutor?: TurnExecutorOpener;
};

// This policy governs the built UI served by Express. Vite serves its own
// development HTML; see docs/threat-model.md for that separate boundary.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  // React uses inline styles for resizable panels and image previews.
  "style-src 'self' 'unsafe-inline'",
  // Attachments use data URLs; 3MF textures use object URLs.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function createApp(dependencies: AppDependencies): Express {
  const { openTurnExecutor, paths, python, runtime, runtimeError } =
    dependencies;
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '18mb' }));

  app.use(
    '/trpc',
    createExpressMiddleware({
      createContext: () => dependencies,
      router: appRouter,
    }),
  );
  registerArtifactRoutes(app, paths);
  registerChatRoute(app, {
    openTurnExecutor,
    python,
    runtime,
    runtimeError,
    sessionRoot: paths.sessionRoot,
  });

  if (existsSync(paths.distPath)) {
    app.use(express.static(paths.distPath));
    app.get('*splat', (_request, response) => {
      response.sendFile(join(paths.distPath, 'index.html'));
    });
  }

  return app;
}
