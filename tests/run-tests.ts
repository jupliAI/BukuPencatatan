import assert from 'assert';
import { AuthService } from '../apps/api/src/modules/auth/auth.service.ts';
import { VendorsService } from '../apps/api/src/modules/vendors/vendors.service.ts';
import { PurchaseOrdersService } from '../apps/api/src/modules/purchase-orders/po.service.ts';
import { OutboxService } from '../apps/api/src/modules/outbox/outbox.service.ts';
import { DatabaseService } from '../apps/api/src/database/db.service.ts';
import { Role, UserStatus, VendorStatus, POStatus, OutboxStatus, BlockchainTxStatus } from '../apps/api/src/common/types.ts';
import { MoneyUtils } from '../apps/api/src/common/decimal-utils.ts';
import { MockBlockchainService } from '../packages/blockchain/src/index.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✗\x1b[0m ${name}`);
    console.error(`    \x1b[31m${err.message || err}\x1b[0m`);
    failed++;
  }
}

export async function runAllTests(): Promise<{ passed: number; failed: number }> {
  passed = 0;
  failed = 0;
  console.log('\n\x1b[1m=== RUNNING PHASE 2 UNIT & INTEGRATION TEST SUITES ===\x1b[0m\n');

  const db = DatabaseService.getInstance();
  await db.seedDefaultData();

  const authService = new AuthService();
  const vendorsService = new VendorsService();
  const poService = new PurchaseOrdersService();
  const mockBlockchain = new MockBlockchainService();
  const outboxService = new OutboxService(mockBlockchain);

  // Users for testing
  const adminUser = {
    id: 'usr-admin-001',
    name: 'Admin',
    email: 'admin@example.local',
    role: Role.ADMIN,
    organizationId: 'org-001-default-uuid',
    status: UserStatus.ACTIVE,
  };

  const procUser = {
    id: 'usr-proc-001',
    name: 'Budi Santoso',
    email: 'procurement@example.local',
    role: Role.PROCUREMENT_OFFICER,
    organizationId: 'org-001-default-uuid',
    status: UserStatus.ACTIVE,
  };

  const crossOrgProcUser = {
    id: 'usr-proc-002',
    name: 'External Officer Org 2',
    email: 'procurement.org2@example.local',
    role: Role.PROCUREMENT_OFFICER,
    organizationId: 'org-002-isolated-uuid',
    status: UserStatus.ACTIVE,
  };

  // ========================================================
  // 1. AUTHENTICATION TESTS
  // ========================================================
  console.log('\x1b[36mSuite 1: Authentication & Token Rotation\x1b[0m');

  await test('Login with valid credentials returns tokens and user profile', async () => {
    const result = await authService.login('procurement@example.local', 'Password123!');
    assert(result.access_token, 'Access token should be present');
    assert(result.refresh_token, 'Refresh token should be present');
    assert.strictEqual(result.user.email, 'procurement@example.local');
    assert.strictEqual(result.user.role, Role.PROCUREMENT_OFFICER);
  });

  await test('Login with invalid password throws 401 INVALID_CREDENTIALS', async () => {
    try {
      await authService.login('procurement@example.local', 'WrongPassword!');
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.strictEqual(err.code, 'INVALID_CREDENTIALS');
      assert.strictEqual(err.statusCode, 401);
    }
  });

  await test('Login with unknown email throws 401 INVALID_CREDENTIALS', async () => {
    try {
      await authService.login('nobody@example.local', 'Password123!');
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.strictEqual(err.code, 'INVALID_CREDENTIALS');
      assert.strictEqual(err.statusCode, 401);
    }
  });

  await test('Disabled user account login is rejected with 403 ACCOUNT_DISABLED', async () => {
    const user = db.users.get('usr-proc-001')!;
    user.status = UserStatus.SUSPENDED;
    try {
      await authService.login('procurement@example.local', 'Password123!');
      assert.fail('Should have rejected suspended user');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ACCOUNT_DISABLED');
      assert.strictEqual(err.statusCode, 403);
    } finally {
      user.status = UserStatus.ACTIVE;
    }
  });

  await test('Refresh token rotation succeeds and invalidates reused token', async () => {
    const loginResult = await authService.login('procurement@example.local', 'Password123!');
    const originalRefreshToken = loginResult.refresh_token;

    // Use refresh token once
    const refreshed = await authService.refreshToken(originalRefreshToken);
    assert(refreshed.access_token, 'New access token must be generated');
    assert(refreshed.refresh_token, 'Rotated refresh token must be generated');
    assert.notStrictEqual(refreshed.refresh_token, originalRefreshToken, 'Token must be rotated');

    // Attempting to reuse the old refresh token MUST fail with TOKEN_REUSE_DETECTED
    try {
      await authService.refreshToken(originalRefreshToken);
      assert.fail('Reusing previous refresh token must be rejected');
    } catch (err: any) {
      assert.strictEqual(err.code, 'TOKEN_REUSE_DETECTED');
      assert.strictEqual(err.statusCode, 401);
    }
  });

  // ========================================================
  // 2. VENDOR TESTS
  // ========================================================
  console.log('\n\x1b[36mSuite 2: Vendor Management & Integrity\x1b[0m');

  let testVendorId = '';

  await test('Create vendor successfully generates VENDOR_CREATED outbox event', async () => {
    const vendor = await vendorsService.createVendor(
      {
        vendor_code: 'VEND-002',
        legal_name: 'PT Mitra Solusi Digital',
        tax_id: '02.999.888.7-001.000',
        address: 'Jl. Sudirman Kav 21, Jakarta Selatan',
        contact_email: 'sales@mitradigital.co.id',
      },
      procUser
    );
    testVendorId = vendor.id;
    assert.strictEqual(vendor.vendor_code, 'VEND-002');
    assert.strictEqual(vendor.status, VendorStatus.ACTIVE);

    // Verify Outbox Event created
    const event = Array.from(db.application_events.values()).find(
      (e) => e.entity_id === vendor.id && e.event_type === 'VENDOR_CREATED'
    );
    assert(event, 'Outbox event VENDOR_CREATED must exist');
    assert.strictEqual(event.status, OutboxStatus.PENDING);
  });

  await test('Duplicate vendor code in the same organization is rejected', async () => {
    try {
      await vendorsService.createVendor(
        {
          vendor_code: 'VEND-002', // duplicate
          legal_name: 'PT Mitra Lain',
          tax_id: '03.111.222.3-000.000',
          address: 'Jl. Lain',
          contact_email: 'lain@mitra.co.id',
        },
        procUser
      );
      assert.fail('Should reject duplicate vendor code');
    } catch (err: any) {
      assert.strictEqual(err.code, 'DUPLICATE_VENDOR_CODE');
      assert.strictEqual(err.statusCode, 409);
    }
  });

  await test('Update vendor fields updates record and creates VENDOR_UPDATED event', async () => {
    const updated = await vendorsService.updateVendor(
      testVendorId,
      { legal_name: 'PT Mitra Solusi Digital Prima' },
      procUser
    );
    assert.strictEqual(updated.legal_name, 'PT Mitra Solusi Digital Prima');

    const event = Array.from(db.application_events.values()).find(
      (e) => e.entity_id === testVendorId && e.event_type === 'VENDOR_UPDATED'
    );
    assert(event, 'Outbox event VENDOR_UPDATED must exist');
  });

  // ========================================================
  // 3. PURCHASE ORDER & MONETARY ACCURACY TESTS
  // ========================================================
  console.log('\n\x1b[36mSuite 3: Purchase Order Lifecycle & Safe Money Rules\x1b[0m');

  let testPoId = '';

  await test('Monetary calculation uses Decimal without JS floating point artifacts', async () => {
    // Standard JS float error: 0.1 + 0.2 = 0.30000000000000004
    // MoneyUtils must produce exact '0.30'
    const total = MoneyUtils.sumTotals(['0.10', '0.20']);
    assert.strictEqual(total, '0.30');

    // 2 x 50,000,000.00 = 100,000,000.00
    const itemTotal = MoneyUtils.calculateItemTotal(2, '50000000.00');
    assert.strictEqual(itemTotal, '100000000.00');
    assert.strictEqual(MoneyUtils.toMinorUnits(itemTotal), '10000000000');
  });

  await test('Create PO computes totals server-side and creates PO_CREATED outbox event', async () => {
    const po = await poService.createPO(
      {
        vendor_id: 'vend-001-default-uuid',
        description: 'New Datacenter Servers',
        external_po_number: 'PO-TEST-001',
        due_date: '2026-11-30',
        currency: 'IDR',
        items: [
          { description: 'Rack Server Node A', quantity: 2, unit_price: '50000000.00' },
          { description: 'Rack Server Node B', quantity: 1, unit_price: '25000000.00' },
        ],
      },
      procUser
    );

    testPoId = po.id;
    // Server-side calculation: 2 * 50,000,000 + 1 * 25,000,000 = 125,000,000.00
    assert.strictEqual(po.total_amount, '125000000.00');
    assert.strictEqual(po.status, POStatus.DRAFT);
    assert.strictEqual(po.blockchain_status, 'PENDING');
    assert.strictEqual(po.items.length, 2);

    // Verify PO_CREATED outbox event was generated
    const event = Array.from(db.application_events.values()).find(
      (e) => e.entity_id === po.id && e.event_type === 'PO_CREATED'
    );
    assert(event, 'PO_CREATED event must be in outbox');
    assert.strictEqual(event.status, OutboxStatus.PENDING);
  });

  await test('Creating PO with invalid item quantity or price is rejected', async () => {
    try {
      await poService.createPO(
        {
          vendor_id: 'vend-001-default-uuid',
          description: 'Invalid Item PO',
          external_po_number: 'PO-TEST-002',
          currency: 'IDR',
          due_date: '2026-12-30',
          items: [{ description: 'Broken Quantity', quantity: 0, unit_price: '1000.00' }],
        },
        procUser
      );
      assert.fail('Should reject zero quantity');
    } catch (err: any) {
      assert.strictEqual(err.code, 'INVALID_QUANTITY');
    }
  });

  await test('Cannot issue PO with inactive vendor', async () => {
    const vendor = db.vendors.get('vend-001-default-uuid')!;
    vendor.status = VendorStatus.SUSPENDED;
    try {
      await poService.issuePO(testPoId, procUser);
      assert.fail('Should reject issuing to suspended vendor');
    } catch (err: any) {
      assert.strictEqual(err.code, 'INACTIVE_VENDOR');
    } finally {
      vendor.status = VendorStatus.ACTIVE;
    }
  });

  await test('Issue PO transitions state to ISSUED and creates PO_ISSUED outbox event', async () => {
    const result = await poService.issuePO(testPoId, procUser);
    assert.strictEqual(result.status, POStatus.ISSUED);
    assert(result.issue_date, 'Issue date must be populated');

    const event = Array.from(db.application_events.values()).find(
      (e) => e.entity_id === testPoId && e.event_type === 'PO_ISSUED'
    );
    assert(event, 'PO_ISSUED event must be in outbox');
    assert.strictEqual(event.status, OutboxStatus.PENDING);
  });

  await test('Invalid state transition: Cannot re-issue already ISSUED purchase order', async () => {
    try {
      await poService.issuePO(testPoId, procUser);
      assert.fail('Re-issuing should fail');
    } catch (err: any) {
      assert.strictEqual(err.code, 'INVALID_STATE_TRANSITION');
    }
  });

  await test('Cross-organization access is rejected (ORG-002 officer cannot touch ORG-001 PO)', async () => {
    try {
      await poService.getPOById(testPoId, crossOrgProcUser);
      assert.fail('Cross-organization access should be forbidden');
    } catch (err: any) {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.statusCode, 403);
    }
  });

  await test('Cancel PO transitions state to CANCELLED and disallows further edits', async () => {
    const cancelRes = await poService.cancelPO(testPoId, 'Procurement plan revised', procUser);
    assert.strictEqual(cancelRes.status, POStatus.CANCELLED);

    // Further issue or update attempts MUST fail
    try {
      await poService.issuePO(testPoId, procUser);
      assert.fail('Cancelled PO cannot be issued');
    } catch (err: any) {
      assert.strictEqual(err.code, 'INVALID_STATE_TRANSITION');
    }
  });

  // ========================================================
  // 4. OUTBOX WORKER & BLOCKCHAIN INTEGRATION TESTS
  // ========================================================
  console.log('\n\x1b[36mSuite 4: Outbox Worker, Mock Blockchain & Idempotency\x1b[0m');

  await test('Outbox worker processes pending events into confirmed blockchain transactions', async () => {
    const res = await outboxService.processPendingEvents(50);
    assert(res.processed > 0, 'Should have processed pending outbox events');
    assert(res.succeeded > 0, 'Events should succeed with mock blockchain adapter');

    // Verify blockchain_transactions table has records
    const txs = Array.from(db.blockchain_transactions.values());
    assert(txs.length > 0, 'Blockchain transactions must be persisted');
    const firstTx = txs[0];
    assert.strictEqual(firstTx.status, BlockchainTxStatus.CONFIRMED);
    assert(firstTx.transaction_id.startsWith('tx_fabric_'));
  });

  await test('Outbox idempotency: Duplicate run will not re-submit confirmed transactions', async () => {
    // Process again with empty pending queue
    const res = await outboxService.processPendingEvents(50);
    assert.strictEqual(res.processed, 0, 'No pending events should remain to process');
  });

  await test('Outbox failure handling and retry policy', async () => {
    // Create a new PO to generate a new PENDING event
    const newPO = await poService.createPO(
      {
        vendor_id: 'vend-001-default-uuid',
        description: 'Test Failure Handling PO',
        external_po_number: 'PO-TEST-003',
        currency: 'IDR',
        due_date: '2026-12-31',
        items: [{ description: 'Test Item', quantity: 1, unit_price: '1000.00' }],
      },
      procUser
    );

    const pendingEvent = Array.from(db.application_events.values()).find(
      (e) => e.entity_id === newPO.id && e.event_type === 'PO_CREATED'
    )!;

    // Simulate Fabric temporary network failure on next call
    mockBlockchain.simulateFailureOnNext(true, 'Peer timeout endorsement simulation');

    const failResult = await outboxService.processEvent(pendingEvent);
    assert.strictEqual(failResult.success, false);
    assert(pendingEvent.last_error?.includes('Peer timeout'));
    // Since attempt_count < 3, status is retained as PENDING for retry
    assert.strictEqual(pendingEvent.status, OutboxStatus.PENDING);
    assert.strictEqual(pendingEvent.attempt_count, 1);

    // Next retry succeeds
    const successResult = await outboxService.processEvent(pendingEvent);
    assert.strictEqual(successResult.success, true);
    assert.strictEqual(pendingEvent.status, OutboxStatus.CONFIRMED);
  });

  console.log(`\n\x1b[1m=== TEST RESULTS: ${passed} PASSED, ${failed} FAILED ===\x1b[0m\n`);
  return { passed, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().then((res) => {
    if (res.failed > 0) process.exit(1);
    else process.exit(0);
  });
}
