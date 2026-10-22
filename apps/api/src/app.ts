import express, { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createApiRouter } from './routes.ts';
import { OutboxService } from './modules/outbox/outbox.service.ts';
import { DatabaseService } from './database/db.service.ts';
import { errorResponse } from './common/response.dto.ts';

/**
 * Membangun instance Express aplikasi TANPA `listen()` dan tanpa middleware Vite/static.
 *
 * Dipakai bersama oleh dua entry point:
 *  - `server.ts`   → development lokal & deployment Node long-running (VPS/Docker)
 *  - `api/index.ts` → Vercel serverless function
 *
 * Dengan cara ini, seluruh route, guard (termasuk HMAC webhook) dan perilaku aplikasi
 * identik di kedua environment.
 */
export function createApp(): express.Express {
  const app = express();
  const db = DatabaseService.getInstance();

  // Capture raw body SEBELUM JSON di-parse — wajib untuk verifikasi HMAC webhook.
  // Tanpa ini, signature dihitung ulang dari hasil re-serialize JSON dan tidak akan match.
  app.use(
    express.json({
      limit: '5mb',
      verify: (req: Request, _res: Response, buf: Buffer, encoding?: BufferEncoding) => {
        try {
          (req as unknown as { rawBody?: string }).rawBody = buf.toString(encoding || 'utf8');
        } catch {
          (req as unknown as { rawBody?: string }).rawBody = '';
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Request ID & security headers
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = (req.headers['x-request-id'] as string) || uuidv4();
    req.requestId = reqId;
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // CORS
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Flush penulisan database yang masih berjalan sebelum response dikirim.
  // Di serverless, function dibekukan setelah response terkirim — tanpa langkah ini
  // operasi write-through bisa terpotong dan data hilang.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      db.flushPersistence()
        .catch(() => undefined)
        .then(() => {
          originalJson(body);
        });
      return res;
    }) as Response['json'];
    next();
  });

  // Mount API Router
  app.use('/api', createApiRouter());

  // Health check endpoint with infrastructure and blockchain provider status
  app.get('/api/health', async (_req: Request, res: Response) => {
    const outbox = OutboxService.getInstance();
    const bcHealth = await outbox.getBlockchainService().isHealthy();
    res.status(200).json({
      status: 'healthy',
      api: 'ok',
      database: db.isPersistenceEnabled() ? 'postgres' : 'in-memory',
      blockchain: bcHealth,
      timestamp: new Date().toISOString(),
    });
  });

  // Global API 404 handler
  app.all('/api/*', (req: Request, res: Response) => {
    res.status(404).json(errorResponse('NOT_FOUND', `Route ${req.method} ${req.path} not found`, undefined, req.requestId));
  });

  return app;
}
