import { v4 as uuidv4 } from 'uuid';
import { DatabaseService, DbApplicationEvent } from '../../database/db.service.ts';
import { OutboxStatus, BlockchainTxStatus } from '../../common/types.ts';
import { BlockchainService, BlockchainFactory, LedgerEvent } from '../../../../../packages/blockchain/src/index.ts';
import { MoneyUtils } from '../../common/decimal-utils.ts';

export class OutboxService {
  private static instance: OutboxService;
  private db = DatabaseService.getInstance();
  private blockchainService: BlockchainService;
  private pollingIntervalId: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;
  private maxRetries: number = 3;

  constructor(blockchainService?: BlockchainService) {
    this.blockchainService = blockchainService || BlockchainFactory.getBlockchainService();
  }

  public static getInstance(blockchainService?: BlockchainService): OutboxService {
    if (!OutboxService.instance) {
      OutboxService.instance = new OutboxService(blockchainService);
    }
    return OutboxService.instance;
  }

  public getBlockchainService(): BlockchainService {
    return this.blockchainService;
  }

  public setBlockchainService(blockchainService: BlockchainService): void {
    this.blockchainService = blockchainService;
  }

  /**
   * Processes a single pending application event with strict idempotency and atomic state transitions
   */
  async processEvent(event: DbApplicationEvent): Promise<{ success: boolean; txId?: string; error?: string }> {
    // Check if this event already has a confirmed transaction (Idempotency Guard)
    for (const tx of this.db.blockchain_transactions.values()) {
      if (tx.application_event_id === event.id && tx.status === BlockchainTxStatus.CONFIRMED) {
        event.status = OutboxStatus.CONFIRMED;
        event.processed_at = tx.confirmed_at || new Date();
        return { success: true, txId: tx.transaction_id };
      }
    }

    // Step 2 & 3: Lock/claim event safely by transitioning to PROCESSING
    event.status = OutboxStatus.PROCESSING;
    event.attempt_count += 1;
    this.db.application_events.set(event.id, event);

    try {
      // Format payload to LedgerEvent structure
      let amountMinorUnits: string | undefined;
      const rawAmount = (event.payload as Record<string, unknown>)?.total_amount;
      if (typeof rawAmount === 'string' && MoneyUtils.isValidAmount(rawAmount)) {
        amountMinorUnits = MoneyUtils.toMinorUnits(rawAmount);
      }

      const amountMinor = amountMinorUnits || '0';
      const docHash =
        ((event.payload as Record<string, unknown>)?.document_hash as string) ||
        ((event.payload as Record<string, unknown>)?.documentHash as string) ||
        undefined;

      const ledgerEvent: LedgerEvent = {
        eventId: event.id,
        entityId: event.entity_id,
        entityType: event.entity_type as LedgerEvent['entityType'],
        eventType: event.event_type as LedgerEvent['eventType'],
        actorId: event.actor_id || undefined,
        organizationId: event.organization_id || undefined,
        amountMinor,
        amountMinorUnits: amountMinor,
        // Mata uang hanya diambil dari payload peristiwa; tidak ada cadangan.
        currency: (event.payload as Record<string, unknown>)?.currency as string | undefined,
        documentHash: docHash,
        metadata: event.payload,
        timestamp: event.created_at.toISOString(),
      };

      // Step 4: Dispatch to BlockchainService
      const result = await this.blockchainService.recordEvent(ledgerEvent);

      if (result.success && result.transactionId) {
        // Step 5: On success
        event.status = OutboxStatus.CONFIRMED;
        event.processed_at = new Date();
        event.last_error = null;
        this.db.application_events.set(event.id, event);

        // Create blockchain_transactions record
        const txRecordId = uuidv4();
        this.db.blockchain_transactions.set(result.transactionId, {
          id: txRecordId,
          application_event_id: event.id,
          transaction_id: result.transactionId,
          event_type: event.event_type,
          entity_id: event.entity_id,
          entity_type: event.entity_type,
          status: BlockchainTxStatus.CONFIRMED,
          error_message: null,
          submitted_at: new Date(result.timestamp),
          confirmed_at: new Date(result.timestamp),
        });

        // Update target entity blockchain_status
        if (event.entity_type === 'PURCHASE_ORDER') {
          const po = this.db.purchase_orders.get(event.entity_id);
          if (po) {
            po.blockchain_status = 'CONFIRMED';
            this.db.purchase_orders.set(po.id, po);
          }
        }

        return { success: true, txId: result.transactionId };
      } else {
        throw new Error(result.errorMessage || 'Blockchain transaction failed without specific error');
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      event.last_error = errorMsg;

      if (event.attempt_count >= this.maxRetries) {
        event.status = OutboxStatus.FAILED;
      } else {
        event.status = OutboxStatus.PENDING; // Return to pending for retry policy
      }
      this.db.application_events.set(event.id, event);

      // Record failed transaction attempt
      const failedTxId = `tx_failed_${uuidv4().substring(0, 16)}`;
      this.db.blockchain_transactions.set(failedTxId, {
        id: uuidv4(),
        application_event_id: event.id,
        transaction_id: failedTxId,
        event_type: event.event_type,
        entity_id: event.entity_id,
        entity_type: event.entity_type,
        status: BlockchainTxStatus.FAILED,
        error_message: errorMsg,
        submitted_at: new Date(),
        confirmed_at: null,
      });

      if (event.entity_type === 'PURCHASE_ORDER') {
        const po = this.db.purchase_orders.get(event.entity_id);
        if (po) {
          po.blockchain_status = event.status === OutboxStatus.FAILED ? 'FAILED' : 'RETRYING';
          this.db.purchase_orders.set(po.id, po);
        }
      }

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Batch processes all pending outbox events
   */
  async processPendingEvents(batchSize: number = 20): Promise<{ processed: number; succeeded: number; confirmed: number; failed: number }> {
    if (this.isProcessing) return { processed: 0, succeeded: 0, confirmed: 0, failed: 0 };
    this.isProcessing = true;

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const pendingEvents = Array.from(this.db.application_events.values())
        .filter((ev) => ev.status === OutboxStatus.PENDING)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .slice(0, batchSize);

      for (const event of pendingEvents) {
        processed++;
        const res = await this.processEvent(event);
        if (res.success) succeeded++;
        else failed++;
      }
    } finally {
      this.isProcessing = false;
    }

    return { processed, succeeded, confirmed: succeeded, failed };
  }

  /**
   * Starts periodic polling in background
   */
  startPolling(intervalMs: number = 2000) {
    if (this.pollingIntervalId) return;
    this.pollingIntervalId = setInterval(async () => {
      await this.processPendingEvents();
    }, intervalMs);
  }

  /**
   * Stops background polling
   */
  stopPolling() {
    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }
}
