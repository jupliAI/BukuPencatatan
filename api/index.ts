/**
 * Vercel Serverless Function entry point.
 *
 * File ini adalah padanan `server.ts` untuk environment serverless:
 *  - memakai `createApp()` yang sama, sehingga seluruh route & guard identik
 *  - menginisialisasi database (bootstrap schema Postgres + hydrate/seed) sekali
 *    per cold start, lalu di-memoize
 *
 * Routing: seluruh request `/api/*` diarahkan ke function ini melalui `vercel.json`.
 *
 * Catatan: modul aplikasi dimuat lewat `import()` dinamis (bukan import statis di
 * top-level). Jika ada dependensi yang gagal dimuat di runtime serverless, kegagalan
 * itu bisa ditangkap di sini dan dilaporkan sebagai JSON — bukan halaman error
 * generik dari platform ("A server error occurred") yang menyulitkan diagnosis.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

let bootstrapPromise: Promise<NodeRequestHandler> | null = null;

function getApp(): Promise<NodeRequestHandler> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const { createApp } = await import('../apps/api/src/app.ts');
      const { DatabaseService } = await import('../apps/api/src/database/db.service.ts');

      const app = createApp();
      await DatabaseService.getInstance().seedDefaultData();
      return app as unknown as NodeRequestHandler;
    })().catch((err: unknown) => {
      // Set null agar request berikutnya pada instance ini mencoba inisialisasi ulang.
      bootstrapPromise = null;
      throw err;
    });
  }
  return bootstrapPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await getApp();
    app(req, res);
  } catch (err) {
    const error = err as Error & { code?: string };
    console.error('[vercel] Application bootstrap failed:', error);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'BOOTSTRAP_FAILED',
          message: error?.message || 'Unknown error',
          error_code: error?.code,
          stack: error?.stack?.split('\n').slice(0, 6).join('\n'),
        },
      }),
    );
  }
}
