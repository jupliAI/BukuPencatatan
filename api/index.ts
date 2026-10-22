/**
 * Vercel Serverless Function entry point.
 *
 * File ini adalah padanan `server.ts` untuk environment serverless:
 *  - memakai `createApp()` yang sama, sehingga seluruh route & guard identik
 *  - menginisialisasi database (bootstrap schema Postgres + hydrate/seed) sekali
 *    per cold start, lalu di-memoize
 *
 * Routing: seluruh request `/api/*` diarahkan ke function ini melalui `vercel.json`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../apps/api/src/app.ts';
import { DatabaseService } from '../apps/api/src/database/db.service.ts';

const app = createApp();

let initialization: Promise<void> | null = null;

function ensureDatabaseReady(): Promise<void> {
  if (!initialization) {
    initialization = DatabaseService.getInstance()
      .seedDefaultData()
      .catch((err: unknown) => {
        // Set null agar request berikutnya pada instance ini mencoba inisialisasi ulang.
        initialization = null;
        throw err;
      });
  }
  return initialization;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await ensureDatabaseReady();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'DATABASE_INIT_FAILED',
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      }),
    );
    return;
  }

  (app as unknown as (request: IncomingMessage, response: ServerResponse) => void)(req, res);
}
