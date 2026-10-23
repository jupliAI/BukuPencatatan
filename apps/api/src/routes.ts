import { Router, Request, Response } from 'express';
import { AuthService } from './modules/auth/auth.service.ts';
import { VendorsService } from './modules/vendors/vendors.service.ts';
import { PurchaseOrdersService } from './modules/purchase-orders/po.service.ts';
import { PayablesService } from './modules/payables/payables.service.ts';
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
  const payablesService = new PayablesService();
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

  router.post(
    '/vendors',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER),
    asyncHandler(async (req, res) => {
      const result = await vendorsService.createVendor(req.body, req.user!);
      return res.status(201).json(successResponse(result));
    })
  );

  router.get(
    '/vendors/:id',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await vendorsService.getVendorById(req.params.id, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.patch(
    '/vendors/:id',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER),
    asyncHandler(async (req, res) => {
      const result = await vendorsService.updateVendor(req.params.id, req.body, req.user!);
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

  router.patch(
    '/purchase-orders/:id',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER),
    asyncHandler(async (req, res) => {
      const result = await poService.updatePO(req.params.id, req.body, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/purchase-orders/:id/issue',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER),
    asyncHandler(async (req, res) => {
      const documentHash = req.body?.document_hash || req.body?.documentHash;
      const result = await poService.issuePO(req.params.id, req.user!, documentHash);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/purchase-orders/:id/cancel',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER),
    asyncHandler(async (req, res) => {
      const { reason } = req.body || {};
      const result = await poService.cancelPO(req.params.id, reason, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  // -------------------------------------------------------------
  // PROCUREMENT LIFECYCLE: GOODS RECEIPT & VERIFICATION
  // -------------------------------------------------------------
  router.post(
    '/purchase-orders/:id/goods-receipt',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER, Role.VENDOR),
    asyncHandler(async (req, res) => {
      const { delivery_note_number, notes } = req.body || {};
      if (!delivery_note_number) {
        throw new AppError('VALIDATION_ERROR', 'delivery_note_number (Nomor Surat Jalan) is required', 400);
      }
      const result = await payablesService.recordGoodsReceipt(
        req.params.id,
        { delivery_note_number, notes },
        req.user!
      );
      return res.status(201).json(successResponse(result));
    })
  );

  router.post(
    '/purchase-orders/:id/verify-goods',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER, Role.PPK),
    asyncHandler(async (req, res) => {
      const { receipt_id } = req.body || {};
      if (!receipt_id) {
        throw new AppError('VALIDATION_ERROR', 'receipt_id is required', 400);
      }
      const result = await payablesService.verifyGoodsReceipt(req.params.id, receipt_id, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  // -------------------------------------------------------------
  // ACCOUNTS PAYABLE LEDGER (BUKU BESAR UTANG) ENDPOINTS
  // -------------------------------------------------------------
  router.get(
    '/payables',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const filter = {
        period: req.query.period as string,
        status: req.query.status as string,
        vendor_id: req.query.vendor_id as string,
        search: req.query.search as string,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 20,
      };
      const result = await payablesService.getPayables(filter, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.get(
    '/payables/summary',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await payablesService.getPayablesSummary(req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.get(
    '/payables/:id',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await payablesService.getPayableById(req.params.id, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/payables/from-po/:poId',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER, Role.FINANCE, Role.PPK),
    asyncHandler(async (req, res) => {
      const { invoice_number, period, due_date } = req.body || {};
      if (!invoice_number || !due_date) {
        throw new AppError('VALIDATION_ERROR', 'invoice_number and due_date are required', 400);
      }
      const result = await payablesService.createPayableFromPO(
        req.params.poId,
        { invoice_number, period: period || 'Bulan 1', due_date },
        req.user!
      );
      return res.status(201).json(successResponse(result));
    })
  );

  router.post(
    '/payables/:id/approve',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.PROCUREMENT_OFFICER, Role.PPK, Role.FINANCE, Role.AUTHORIZED_OFFICER),
    asyncHandler(async (req, res) => {
      const { notes } = req.body || {};
      const result = await payablesService.approvePayable(req.params.id, notes, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/payables/:id/initiate-payment',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.FINANCE, Role.AUTHORIZED_OFFICER, Role.PAYMENT_SYSTEM),
    asyncHandler(async (req, res) => {
      const { payment_reference, notes } = req.body || {};
      if (!payment_reference) {
        throw new AppError('VALIDATION_ERROR', 'payment_reference (Nomor SP2D/Transfer) is required', 400);
      }
      const result = await payablesService.initiatePayment(
        req.params.id,
        { payment_reference, notes },
        req.user!
      );
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/payables/:id/settle',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.FINANCE, Role.AUTHORIZED_OFFICER, Role.PAYMENT_SYSTEM),
    asyncHandler(async (req, res) => {
      const { payment_reference } = req.body || {};
      const result = await payablesService.settlePayable(req.params.id, payment_reference, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/payables/batch-settle',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.FINANCE, Role.AUTHORIZED_OFFICER),
    asyncHandler(async (req, res) => {
      const { period } = req.body || {};
      if (!period) {
        throw new AppError('VALIDATION_ERROR', 'period parameter is required', 400);
      }
      const result = await payablesService.batchSettlePeriod(period, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  // -------------------------------------------------------------
  // TAMPER-EVIDENT DETECTION LAB & INTEGRITY AUDIT
  // -------------------------------------------------------------
  router.get(
    '/payables/:id/audit-integrity',
    authMiddleware,
    asyncHandler(async (req, res) => {
      const result = await payablesService.auditPayableIntegrity(req.params.id, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/payables/:id/tamper-simulate',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.AUDITOR),
    asyncHandler(async (req, res) => {
      const { tampered_amount } = req.body || {};
      if (!tampered_amount) {
        throw new AppError('VALIDATION_ERROR', 'tampered_amount is required', 400);
      }
      const result = await payablesService.tamperDatabaseRecord(req.params.id, tampered_amount, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

  router.post(
    '/payables/:id/tamper-restore',
    authMiddleware,
    requireRoles(Role.ADMIN, Role.AUDITOR),
    asyncHandler(async (req, res) => {
      const result = await payablesService.restoreDatabaseRecord(req.params.id, req.user!);
      return res.status(200).json(successResponse(result));
    })
  );

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
          amount_minor: ev.amountMinor || ev.amountMinorUnits || '0',
          currency: ev.currency || 'IDR',
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
      return res.status(202).json(successResponse(result));
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
