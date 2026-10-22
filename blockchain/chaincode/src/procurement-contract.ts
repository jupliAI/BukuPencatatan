import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  LedgerEvent,
  VALID_ENTITY_TYPES,
  VALID_EVENT_TYPES_PHASE3,
  VerifyHashResult,
} from './ledger-event';

@Info({
  title: 'ProcurementLedgerContract',
  description: 'Smart contract for immutable procurement and vendor ledger audit trail',
})
export class ProcurementLedgerContract extends Contract {
  constructor() {
    super('procurement-ledger');
  }

  /**
   * Records a business audit event to the ledger with strict idempotency and validation.
   */
  @Transaction()
  @Returns('string')
  public async recordEvent(ctx: Context, eventJson: string): Promise<string> {
    if (!eventJson || typeof eventJson !== 'string') {
      throw new Error('Event payload must be a non-empty JSON string');
    }

    let event: LedgerEvent;
    try {
      event = JSON.parse(eventJson);
    } catch (e: any) {
      throw new Error(`Invalid JSON format: ${e.message}`);
    }

    // 1. Validate required fields
    this.validateEventPayload(event);

    // 2. Validate event ID uniqueness & idempotency
    const eventKey = `EVENT:${event.eventId}`;
    const existingBytes = await ctx.stub.getState(eventKey);

    if (existingBytes && existingBytes.length > 0) {
      // Deterministic duplicate response for idempotency
      const existingEvent: LedgerEvent = JSON.parse(Buffer.from(existingBytes).toString('utf8'));
      const duplicateResponse = {
        success: true,
        eventId: existingEvent.eventId,
        transactionId: existingEvent.blockchainTransactionId || ctx.stub.getTxID(),
        duplicate: true,
        message: 'Event already recorded (idempotent submission)',
      };
      return JSON.stringify(duplicateResponse);
    }

    // 3. Obtain Fabric Transaction ID from context
    const txId = ctx.stub.getTxID();
    event.blockchainTransactionId = txId;

    // 4. Persist primary event record: EVENT:{eventId}
    const eventBytes = Buffer.from(JSON.stringify(event), 'utf8');
    await ctx.stub.putState(eventKey, eventBytes);

    // 5. Update Entity Index: ENTITY:{entityType}:{entityId}
    const entityIndexKey = `ENTITY:${event.entityType}:${event.entityId}`;
    const entityIndexBytes = await ctx.stub.getState(entityIndexKey);
    let eventIds: string[] = [];
    if (entityIndexBytes && entityIndexBytes.length > 0) {
      try {
        eventIds = JSON.parse(Buffer.from(entityIndexBytes).toString('utf8'));
      } catch {
        eventIds = [];
      }
    }

    if (!eventIds.includes(event.eventId)) {
      eventIds.push(event.eventId);
      await ctx.stub.putState(entityIndexKey, Buffer.from(JSON.stringify(eventIds), 'utf8'));
    }

    // 6. Emit Fabric chaincode event
    const chaincodeEventPayload = Buffer.from(
      JSON.stringify({
        eventId: event.eventId,
        entityId: event.entityId,
        entityType: event.entityType,
        eventType: event.eventType,
        organizationId: event.organizationId,
        transactionId: txId,
        timestamp: event.timestamp,
      }),
      'utf8'
    );
    ctx.stub.setEvent('PROCUREMENT_EVENT', chaincodeEventPayload);

    // 7. Return success response
    return JSON.stringify({
      success: true,
      eventId: event.eventId,
      transactionId: txId,
      duplicate: false,
    });
  }

  /**
   * Retrieves an event by eventId.
   */
  @Transaction(false)
  @Returns('string')
  public async getEvent(ctx: Context, eventId: string): Promise<string> {
    if (!eventId) {
      throw new Error('eventId is required');
    }
    const eventKey = `EVENT:${eventId}`;
    const eventBytes = await ctx.stub.getState(eventKey);
    if (!eventBytes || eventBytes.length === 0) {
      throw new Error(`Event not found: ${eventId}`);
    }
    return Buffer.from(eventBytes).toString('utf8');
  }

  /**
   * Checks if an event exists.
   */
  @Transaction(false)
  @Returns('boolean')
  public async eventExists(ctx: Context, eventId: string): Promise<boolean> {
    if (!eventId) return false;
    const eventBytes = await ctx.stub.getState(`EVENT:${eventId}`);
    return !!(eventBytes && eventBytes.length > 0);
  }

  /**
   * Retrieves chronological event history for an entity.
   */
  @Transaction(false)
  @Returns('string')
  public async getEntityHistory(
    ctx: Context,
    entityType: string,
    entityId: string
  ): Promise<string> {
    if (!entityType || !entityId) {
      throw new Error('entityType and entityId are required');
    }

    const entityIndexKey = `ENTITY:${entityType}:${entityId}`;
    const indexBytes = await ctx.stub.getState(entityIndexKey);
    if (!indexBytes || indexBytes.length === 0) {
      return JSON.stringify([]);
    }

    const eventIds: string[] = JSON.parse(Buffer.from(indexBytes).toString('utf8'));
    const events: LedgerEvent[] = [];

    for (const id of eventIds) {
      const eventBytes = await ctx.stub.getState(`EVENT:${id}`);
      if (eventBytes && eventBytes.length > 0) {
        events.push(JSON.parse(Buffer.from(eventBytes).toString('utf8')));
      }
    }

    // Chronological ordering
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return JSON.stringify(events);
  }

  /**
   * Computes the latest known status and state for an entity.
   */
  @Transaction(false)
  @Returns('string')
  public async getEntityState(
    ctx: Context,
    entityType: string,
    entityId: string
  ): Promise<string> {
    const historyJson = await this.getEntityHistory(ctx, entityType, entityId);
    const history: LedgerEvent[] = JSON.parse(historyJson);

    if (history.length === 0) {
      return JSON.stringify({
        entityId,
        entityType,
        status: 'UNKNOWN',
        eventCount: 0,
        lastUpdated: null,
      });
    }

    const latestEvent = history[history.length - 1];
    return JSON.stringify({
      entityId,
      entityType,
      currentStatus: latestEvent.eventType,
      lastEventId: latestEvent.eventId,
      lastTransactionId: latestEvent.blockchainTransactionId,
      eventCount: history.length,
      lastUpdated: latestEvent.timestamp,
      currency: latestEvent.currency,
      amountMinor: latestEvent.amountMinor,
    });
  }

  /**
   * Verifies whether a given document hash matches any stored audit event for an entity.
   */
  @Transaction(false)
  @Returns('string')
  public async verifyDocumentHash(
    ctx: Context,
    entityId: string,
    documentHash: string
  ): Promise<string> {
    if (!entityId || !documentHash) {
      throw new Error('entityId and documentHash are required');
    }

    const matchingEvents: LedgerEvent[] = [];
    let storedHash: string | undefined;

    // Search across primary entity types
    for (const type of VALID_ENTITY_TYPES) {
      const indexBytes = await ctx.stub.getState(`ENTITY:${type}:${entityId}`);
      if (indexBytes && indexBytes.length > 0) {
        const eventIds: string[] = JSON.parse(Buffer.from(indexBytes).toString('utf8'));
        for (const id of eventIds) {
          const eventBytes = await ctx.stub.getState(`EVENT:${id}`);
          if (eventBytes && eventBytes.length > 0) {
            const ev: LedgerEvent = JSON.parse(Buffer.from(eventBytes).toString('utf8'));
            if (ev.documentHash) {
              storedHash = ev.documentHash;
              if (ev.documentHash.toLowerCase() === documentHash.toLowerCase()) {
                matchingEvents.push(ev);
              }
            }
          }
        }
      }
    }

    const result: VerifyHashResult = {
      match: matchingEvents.length > 0,
      storedHash,
      matchingEvents,
    };

    return JSON.stringify(result);
  }

  /**
   * Validates structure, types, and amounts according to Phase 3 rules.
   */
  private validateEventPayload(event: LedgerEvent): void {
    if (!event.eventId || typeof event.eventId !== 'string') {
      throw new Error('Validation failed: eventId is required');
    }
    if (!event.entityId || typeof event.entityId !== 'string') {
      throw new Error('Validation failed: entityId is required');
    }
    if (!event.entityType || typeof event.entityType !== 'string') {
      throw new Error('Validation failed: entityType is required');
    }
    if (!VALID_ENTITY_TYPES.includes(event.entityType as any)) {
      throw new Error(`Validation failed: invalid entityType '${event.entityType}'`);
    }

    if (!event.eventType || typeof event.eventType !== 'string') {
      throw new Error('Validation failed: eventType is required');
    }
    if (!VALID_EVENT_TYPES_PHASE3.includes(event.eventType as any)) {
      throw new Error(`Validation failed: invalid eventType '${event.eventType}' for Phase 3`);
    }

    if (!event.organizationId || typeof event.organizationId !== 'string') {
      throw new Error('Validation failed: organizationId is required');
    }

    // Monetary minor units validation
    if (event.amountMinor === undefined || event.amountMinor === null) {
      throw new Error('Validation failed: amountMinor is required');
    }
    if (typeof event.amountMinor !== 'string') {
      throw new Error('Validation failed: amountMinor must be a string representation of minor units');
    }
    // Must be valid non-negative integer representation in string
    if (!/^\d+$/.test(event.amountMinor)) {
      throw new Error(`Validation failed: amountMinor '${event.amountMinor}' must contain only digits (no floating point)`);
    }

    if (!event.currency || typeof event.currency !== 'string') {
      throw new Error('Validation failed: currency is required');
    }

    if (!event.timestamp || isNaN(Date.parse(event.timestamp))) {
      throw new Error('Validation failed: timestamp must be a valid ISO-8601 date string');
    }
  }
}
