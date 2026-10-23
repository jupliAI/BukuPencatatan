import { DatabaseService } from '../apps/api/src/database/db.service.ts';
import { OutboxService } from '../apps/api/src/modules/outbox/outbox.service.ts';
import { VendorsService } from '../apps/api/src/modules/vendors/vendors.service.ts';
import { PurchaseOrdersService } from '../apps/api/src/modules/purchase-orders/po.service.ts';
import { BlockchainFactory } from '../packages/blockchain/src/blockchain.factory.ts';
import { FabricBlockchainService } from '../packages/blockchain/src/fabric-blockchain.service.ts';
import { MockBlockchainService } from '../packages/blockchain/src/mock-blockchain.service.ts';
import {
  OutboxStatus,
  BlockchainTxStatus,
  POStatus,
  Role,
  UserStatus,
  AuthenticatedUser,
} from '../apps/api/src/common/types.ts';

export async function runFabricOutboxE2ETests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`  ❌ FAIL: ${msg}`);
      failed++;
      throw new Error(msg);
    } else {
      console.log(`  ✓ ${msg}`);
      passed++;
    }
  }

  console.log('\x1b[36m=== Suite: Fabric Outbox & End-to-End Ledger Flow ===\x1b[0m');

  const db = DatabaseService.getInstance();
  await db.seedDefaultData();

  const procUser: AuthenticatedUser = {
    id: 'usr-proc-001',
    name: 'Budi Santoso',
    email: 'procurement@example.local',
    role: Role.PROCUREMENT_OFFICER,
    organizationId: 'org-001-default-uuid',
    status: UserStatus.ACTIVE,
  };

  // Test 1: Provider Switching via BlockchainFactory
  {
    BlockchainFactory.setForcedProvider('mock');
    const mockSvc = BlockchainFactory.getBlockchainService();
    assert(mockSvc instanceof MockBlockchainService, 'Factory returns MockBlockchainService when mock requested');
    assert(mockSvc.getProviderName() === 'MOCK_BLOCKCHAIN', 'Provider name is MOCK_BLOCKCHAIN');

    BlockchainFactory.setForcedProvider('fabric');
    const fabricSvc = BlockchainFactory.getBlockchainService();
    assert(fabricSvc instanceof FabricBlockchainService, 'Factory returns FabricBlockchainService when fabric requested');
    assert(fabricSvc.getProviderName() === 'HYPERLEDGER_FABRIC', 'Provider name is HYPERLEDGER_FABRIC');
  }

  // Switch OutboxService to use FabricBlockchainService
  const fabricService = new FabricBlockchainService();
  const outboxService = OutboxService.getInstance();
  outboxService.setBlockchainService(fabricService);

  const vendorsService = new VendorsService();
  const poService = new PurchaseOrdersService();

  // Test 2: Vendor Creation -> Outbox Event -> Fabric Submission
  let vendorId = '';
  {
    const vendor = await vendorsService.createVendor(
      {
        legal_name: 'PT Mitra Sukses Fabric',
        vendor_code: 'VND-FAB-001',
        contact_email: 'mitra@fabric.example.com',
        address: 'Jl. Sudirman Kav 28, Jakarta',
        tax_id: '01.234.567.8-012.000',
      },
      procUser
    );
    vendorId = vendor.id;

    assert(!!vendorId, 'Vendor created with unique ID');

    // Find VENDOR_CREATED event in outbox
    const events = Array.from(db.application_events.values()).filter(
      (e) => e.entity_id === vendorId && e.event_type === 'VENDOR_CREATED'
    );
    assert(events.length === 1, 'Exactly 1 VENDOR_CREATED outbox event created');
    assert(events[0].status === OutboxStatus.PENDING, 'Vendor outbox event begins in PENDING status');

    // Run outbox processor against Fabric
    const batchResult = await outboxService.processPendingEvents();
    assert(batchResult.processed >= 1, 'Outbox worker processed pending vendor event');
    assert(batchResult.confirmed >= 1, 'Outbox worker confirmed event on Fabric');

    // Verify event in DB is now CONFIRMED
    const updatedEv = db.application_events.get(events[0].id);
    assert(updatedEv?.status === OutboxStatus.CONFIRMED, 'Outbox event status transitioned to CONFIRMED');

    // Verify blockchain_transactions record created
    const txRecords = Array.from(db.blockchain_transactions.values()).filter(
      (tx) => tx.application_event_id === events[0].id
    );
    assert(txRecords.length === 1, 'blockchain_transactions table contains 1 entry');
    assert(txRecords[0].status === BlockchainTxStatus.CONFIRMED, 'blockchain_transactions status is CONFIRMED');
    assert(txRecords[0].transaction_id.startsWith('tx_fabric_'), 'Real Fabric transaction ID recorded in DB');
  }

  // Test 3: Purchase Order Intake -> Fabric Submission
  let poId = '';

  {
    // Step 3a: Record PO arriving from e-commerce via Switching
    const po = await poService.createPO(
      {
        vendor_id: vendorId,
        currency: 'IDR',
        description: 'Fabric Phase 3 Enterprise Hardware Procurement',
        external_po_number: 'PO-FABRIC-E2E-001',
        due_date: new Date(Date.now() + 30 * 86400000).toISOString(),
        items: [
          {
            description: 'Hyperledger Peer Node Server Model X',
            quantity: 2,
            unit_price: '50000000.00', // Rp50,000,000.00 * 2 = Rp100,000,000.00
          },
        ],
      },
      procUser
    );
    poId = po.id;
    assert(po.total_amount === '100000000.00', 'PO total amount computed accurately');
    assert(po.status === POStatus.DRAFT, 'PO recorded in DRAFT status as received');

    // Process PO_CREATED event to Fabric
    await outboxService.processPendingEvents();

    // Step 3b: Query Fabric Ledger directly for entity history
    const ledgerHistory = await fabricService.getTransactionHistory(poId, 'PURCHASE_ORDER');
    assert(ledgerHistory.length === 1, 'Fabric ledger contains exactly 1 chronological event for this PO');
    assert(ledgerHistory[0].eventType === 'PO_CREATED', 'Fabric event is PO_CREATED');
    assert(ledgerHistory[0].amountMinor === '10000000000', 'Amount on Fabric is exact minor units (Rp100,000,000.00)');
  }

  // Catatan: PO_ISSUED dan peristiwa lanjutan lainnya hanya lahir dari
  // e-commerce via Switching, bukan dari dalam aplikasi ini.

  // Test 4: Outbox Worker Idempotency with Fabric
  {
    const rerunResult = await outboxService.processPendingEvents();
    assert(rerunResult.processed === 0, 'No re-submission occurs on already confirmed events');
    assert(rerunResult.failed === 0, 'Zero failures on idempotent run');
  }

  // Clean up
  BlockchainFactory.reset();
  await fabricService.close();

  return { passed, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFabricOutboxE2ETests().then((res) => {
    if (res.failed > 0) process.exit(1);
    else process.exit(0);
  });
}
