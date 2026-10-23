import { Router, Request, Response } from 'express';
import { AuthService } from './modules/auth/auth.service.ts';
import { VendorsService } from './modules/vendors/vendors.service.ts';
import { PurchaseOrdersService } from './modules/purchase-orders/po.service.ts';
import { OutboxService } from './modules/outbox/outbox.service.ts';
import { BlockchainFactory } from '../../../packages/blockchain/src/index.ts';
import { authMiddleware, requireRoles } from './common/auth.guard.ts';
import { gatewayWebhookGuard } from './common/gateway-webhook.guard.ts';
import { Role } from './common/types.ts';
import { successResponse, errorResponse, AppError } from './common/response.dto.ts';
import { DatabaseService } from './database/db.service.ts';
import { GatewayWebhookService } from './modules/webhooks/gateway-webhook.service.ts';
import { SwitchingInboundService } from './modules/integration/switching-inbound.service.ts';
import { timingSafeStringEqual } from './common/crypto-utils.ts';

export function createApiRouter(): Router {
  const router = Router();

  const authService = new AuthService();
  const vendorsService = new VendorsService();
  const poService = new PurchaseOrdersService();
  const outboxService = OutboxService.getInstance();
  const db = DatabaseService.getInstance();
  const gatewayWebhookService = new GatewayWebhookService();
  const switchingInboundService = new SwitchingInboundService();

  // Helper for catching async errors
  const asyncHandler = (fn: (req: Request, res: Response) => Promise<unknown>) => {
    return (req: Request, res: Response) => {
      fn(req, res).catch((err: unknown) => {
        if (err instanceof AppError) {
          return res.status(err.statusCode).json(errorResponse(err.code, err.message, err.details, req.requestId));
        }
        const message = err instanceof Error ? err.message : 'Internal Server Error';
        return res.status(500).json(errorResponse('INTERNAL_SERVER_ERROR', message, undefined, req.requestId));
      });
    };
  };

  // -------------------------------------------------------------
  // AUTHENTICATION ENDPOINTS
  // -------------------------------------------------------------
  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body || {};
      const result = await authService.login(email, password);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/auth/refresh',
    asyncHandler(async (req, res) => {
      const { refresh_token } = req.body || {};
      const result = await authService.refreshToken(refresh_token);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/auth/logout',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await authService.logout(req.user!.id);
      return res.status(200).json(successResponse(result));
    })
  );

  router.get(
    '/auth/me',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await authService.getCurrentUser(req.user!.id);
      return res.status(200).json(successResponse(result));
    })
  );

  // -------------------------------------------------------------
  // VENDORS ENDPOINTS
  // -------------------------------------------------------------
  router.get(
    '/vendors',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const query = {
        search: req.query.search as string,
        status: req.query.status as any,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 10,
      };
      const result = await vendorsService.getVendors(query, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  // Catatan: tidak ada endpoint untuk membuat vendor di sini. Data vendor
  // datang dari e-commerce melalui Switching (lihat /v1/integration/ledger-events).

  router.get(
    '/vendors/:id',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await vendorsService.getVendorById(req.params.id, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  // -------------------------------------------------------------
  // PURCHASE ORDERS ENDPOINTS
  // -------------------------------------------------------------
  router.get(
    '/purchase-orders',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const query = {
        status: req.query.status as any,
        vendor_id: req.query.vendor_id as string,
        search: req.query.search as string,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 10,
      };
      const result = await poService.getPOs(query, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.get(
    '/purchase-orders/:id',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await poService.getPOById(req.params.id, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  // Catatan: tidak ada endpoint untuk membuat, mengubah, menerbitkan, atau
  // membatalkan PO di sini. Seluruh PO berasal dari e-commerce melalui
  // Switching (lihat /v1/integration/ledger-events).

  // Catatan: tidak ada endpoint buku besar utang. Utang bukan entitas yang
  // dikirim e-commerce melalui Switching, sehingga aplikasi ini tidak
  // menyimpan maupun menyajikannya.

  // -------------------------------------------------------------
  // AUDIT & BLOCKCHAIN OUTBOX MONITORING ENDPOINTS
  // -------------------------------------------------------------
  router.get(
    '/audit/events',
    authMiddleware,
    asyncHandler(async (_req, res) => {
      const events = Array.from(db.application_events.values()).sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime()
      );
      return res.status(200).json(successResponse(events));
    })
  );

  router.get(
    '/audit/blockchain-transactions',
    authMiddleware,
    asyncHandler(async (_req, res) => {
      const txs = Array.from(db.blockchain_transactions.values()).sort(
        (a, b) => b.submitted_at.getTime() - a.submitted_at.getTime()
      );
      return res.status(200).json(successResponse(txs));
    })
  );

  router.get(
    '/audit/blockchain-history/:entityId',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const blockchainService = outboxService.getBlockchainService();
      const history = await blockchainService.getTransactionHistory(req.params.entityId);
      return res.status(200).json(successResponse(history));
    })
  );

  // -------------------------------------------------------------
  // PHASE 3 DIRECT BLOCKCHAIN LEDGER QUERY & VERIFICATION
  // -------------------------------------------------------------
  router.get(
    '/ledger/:entityId/history',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const entityId = req.params.entityId;
      const blockchainService = outboxService.getBlockchainService();
      const events = await blockchainService.getTransactionHistory(entityId);

      const auditResponse = {
        entity_id: entityId,
        entity_type: events[0]?.entityType || 'PURCHASE_ORDER',
        events: events.map((ev) => ({
          event_id: ev.eventId,
          event_type: ev.eventType,
          actor_id: ev.actorId,
          actor_role: ev.actorRole,
          organization_id: ev.organizationId,
          amount_minor: ev.amountMinor ?? ev.amountMinorUnits ?? null,
          currency: ev.currency ?? null,
          timestamp: ev.timestamp,
          blockchain_transaction_id: ev.blockchainTransactionId,
        })),
        source: blockchainService.getProviderName(),
      };

      return res.status(200).json(successResponse(auditResponse));
    })
  );

  router.get(
    '/ledger/:entityId/verify',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const entityId = req.params.entityId;
      const documentHash = (req.query.document_hash as string) || (req.query.hash as string);
      if (!documentHash) {
        throw new AppError('VALIDATION_ERROR', 'Query parameter document_hash is required', 400);
      }

      const blockchainService = outboxService.getBlockchainService();
      const verification = await blockchainService.verifyDocumentHash(entityId, documentHash);

      return res.status(200).json(
        successResponse({
          entity_id: entityId,
          document_hash: documentHash,
          match: verification.match,
          stored_hash: verification.storedHash,
          matching_events: verification.matchingEvents,
          source: blockchainService.getProviderName(),
        })
      );
    })
  );

  router.post(
    '/audit/outbox/process',
    authMiddleware,
    requireRoles(Role.ADMIN),
    asyncHandler(async (_req, res) => {
      const result = await outboxService.processPendingEvents();
      return res.status(200).json(successResponse(result));
    })
  );

  // -------------------------------------------------------------
  // BLOCKCHAIN PROVIDER & STATUS MANAGEMENT
  // -------------------------------------------------------------
  router.get(
    '/blockchain/status',
    authMiddleware,
    asyncHandler(async (_req, res) => {
      const blockchainService = outboxService.getBlockchainService();
      const health = await blockchainService.isHealthy();
      return res.status(200).json(
        successResponse({
          provider: health.provider,
          provider_name: blockchainService.getProviderName(),
          channel: health.channel || 'procurementchannel',
          chaincode: health.chaincode || 'procurement-ledger',
          status: health.status,
          connected: health.status === 'connected' || health.status === 'mock',
          timestamp: new Date().toISOString(),
        })
      );
    })
  );

  router.post(
    '/blockchain/provider',
    authMiddleware,
    requireRoles(Role.ADMIN),
    asyncHandler(async (req, res) => {
      const { provider } = req.body || {};
      if (provider !== 'fabric' && provider !== 'mock') {
        throw new AppError('VALIDATION_ERROR', 'Provider must be "fabric" or "mock"', 400);
      }
      BlockchainFactory.setForcedProvider(provider);
      const newService = BlockchainFactory.getBlockchainService();
      outboxService.setBlockchainService(newService);
      const health = await newService.isHealthy();

      return res.status(200).json(
        successResponse({
          provider: health.provider,
          provider_name: newService.getProviderName(),
          channel: health.channel || 'procurementchannel',
          chaincode: health.chaincode || 'procurement-ledger',
          status: health.status,
          connected: health.status === 'connected' || health.status === 'mock',
          timestamp: new Date().toISOString(),
        })
      );
    })
  );

  // -------------------------------------------------------------
  // GATEWAY INBOUND WEBHOOK ENDPOINT (Authenticated by HMAC + API Key)
  // -------------------------------------------------------------
  router.post(
    '/v1/webhooks/gateway',
    gatewayWebhookGuard,
    asyncHandler(async (req, res) => {
      const result = await gatewayWebhookService.handleGatewayWebhook(req.body);
      return res.status(200).json(successResponse(result));
    }),
  );

  // -------------------------------------------------------------
  // SWITCHING HUB INBOUND (Jalur A — business service)
  // -------------------------------------------------------------
  // Switching mendorong transaksi e-commerce ke endpoint ini memakai
  // routing rule `targetConfig.endpointUrl`. Pada jalur ini Switching hanya
  // mengirim header Content-Type, jadi token ditaruh di query string URL.
  //
  // Rantai outbox → blockchain diproses langsung di dalam request ini karena
  // worker `setInterval` (server.ts) tidak hidup di lingkungan serverless.
  // Tanpa langkah ini, PO akan tersimpan tetapi hash-nya tidak pernah terbentuk.
  router.post(
    '/v1/integration/ledger-events',
    asyncHandler(async (req, res) => {
      const expectedToken = process.env.SWITCHING_INBOUND_TOKEN;
      if (!expectedToken) {
        return res
          .status(503)
          .json(
            errorResponse('INBOUND_NOT_CONFIGURED', 'SWITCHING_INBOUND_TOKEN is not configured', undefined, req.requestId),
          );
      }

      const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
      const providedToken = req.header('x-switching-token') || queryToken;
      if (!timingSafeStringEqual(providedToken, expectedToken)) {
        return res
          .status(401)
          .json(errorResponse('UNAUTHORIZED', 'Invalid switching inbound token', undefined, req.requestId));
      }

      const result = await switchingInboundService.handleLedgerEvent(req.body ?? {});

      // Hanya diproses bila peristiwa benar-benar diterapkan. Duplikat dan tipe
      // yang tidak didukung dibiarkan tanpa menyentuh outbox.
      let ledger: { processed: number; confirmed: number; failed: number; blockchain_status: string | null } | undefined;
      if (result.applied) {
        const batchSize = Number(process.env.OUTBOX_BATCH_SIZE) || 20;
        const outboxResult = await outboxService.processPendingEvents(batchSize);
        const poId = 'po_id' in result ? result.po_id : undefined;
        const po = typeof poId === 'string' ? db.purchase_orders.get(poId) : undefined;
        ledger = {
          processed: outboxResult.processed,
          confirmed: outboxResult.confirmed,
          failed: outboxResult.failed,
          blockchain_status: po?.blockchain_status ?? null,
        };
      }

      return res.status(202).json(successResponse({ ...result, ledger }));
    }),
  );

  // -------------------------------------------------------------
  // INTERNAL CRON (Vercel Cron → pengganti outbox setInterval)
  // -------------------------------------------------------------
  // Di serverless, worker outbox tidak bisa berjalan sebagai background interval,
  // sehingga pemicunya adalah cron yang memanggil endpoint ini.
  router.all(
    '/cron/outbox',
    asyncHandler(async (req, res) => {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const authorization = req.header('authorization') || '';
        if (authorization !== `Bearer ${cronSecret}`) {
          return res
            .status(401)
            .json(errorResponse('UNAUTHORIZED', 'Invalid cron secret', undefined, req.requestId));
        }
      }

      const batchSize = Number(process.env.OUTBOX_BATCH_SIZE) || 20;
      const result = await outboxService.processPendingEvents(batchSize);
      return res.status(200).json(successResponse(result));
    }),
  );

  return router;
}
