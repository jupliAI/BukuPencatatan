import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createApp } from './apps/api/src/app.ts';
import { OutboxService } from './apps/api/src/modules/outbox/outbox.service.ts';
import { DatabaseService } from './apps/api/src/database/db.service.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Entry point untuk Node long-running (development lokal, VPS, Docker).
 * Untuk Vercel serverless, entry point-nya adalah `api/index.ts`.
 */
async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;

  // Initialize DB: bootstrap schema Postgres + hydrate, atau seed in-memory bila tanpa DB.
  const db = DatabaseService.getInstance();
  await db.seedDefaultData();

  const app = createApp();

  // Outbox worker berbasis setInterval hanya valid pada proses yang hidup terus.
  // Di serverless, pemicunya adalah Vercel Cron → endpoint /api/cron/outbox.
  const outboxService = OutboxService.getInstance();
  outboxService.startPolling(Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 2500);

  // In development, hook into Vite middlewares
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve static files
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[Enterprise AP Ledger] Server running at http://0.0.0.0:${PORT} (database: ${
        db.isPersistenceEnabled() ? 'postgres' : 'in-memory'
      })`,
    );
  });
}

startServer().catch((err) => {
  console.error('[Enterprise AP Ledger] Fatal startup error:', err);
  process.exit(1);
});
