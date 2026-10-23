import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DatabaseService } from '../apps/api/src/database/db.service.ts';
import { PayablesService } from '../apps/api/src/modules/payables/payables.service.ts';
import { Role, UserStatus } from '../apps/api/src/common/types.ts';

describe('Phase 4: Accounts Payable Ledger (Read-Only) && Tamper Detection', async () => {
  const db = DatabaseService.getInstance();
  await db.seedDefaultData();
  const payablesService = new PayablesService();

  const adminUser = {
    id: 'usr-admin-001',
    name: 'System Administrator',
    email: 'admin@example.local',
    role: Role.ADMIN,
    organizationId: 'org-001-default-uuid',
    status: UserStatus.ACTIVE,
  };

  it('1. Seeded 4-Month Cycle contains payables across Bulan 1, 2, 3, and 4', async () => {
    const summary = await payablesService.getPayablesSummary(adminUser);
    assert.ok(summary);
    assert.strictEqual(summary.period_breakdown.length, 4);

    const b1 = summary.period_breakdown.find((p) => p.period === 'Bulan 1');
    const b2 = summary.period_breakdown.find((p) => p.period === 'Bulan 2');
    const b3 = summary.period_breakdown.find((p) => p.period === 'Bulan 3');
    const b4 = summary.period_breakdown.find((p) => p.period === 'Bulan 4');

    assert.ok(b1);
    assert.strictEqual(b1.total_amount, '150000000.00'); // Vendor A 100M + Vendor B 50M
    assert.ok(b2);
    assert.strictEqual(b2.total_amount, '200000000.00'); // PO-003 75M + PO-004 125M
    assert.ok(b3);
    assert.strictEqual(b3.total_amount, '200000000.00'); // PO-005 200M
    assert.ok(b4);
  });

  // Catatan: utang hanya lahir dari catatan yang masuk melalui Switching.
  // Aplikasi ini tidak menyetujui, mencairkan, atau melunasi utang, sehingga
  // tidak ada pengujian alur persetujuan/pembayaran di sini.

  it('2. Tamper-Evident Detection: Database manipulation triggers cryptographic mismatch with Hyperledger Fabric', async () => {
    const payables = await payablesService.getPayables({}, adminUser);
    const target = payables.items[0];

    // Initial state: genuine and verified
    const initialAudit = await payablesService.auditPayableIntegrity(target.id, adminUser);
    assert.strictEqual(initialAudit.is_match, true);
    assert.strictEqual(initialAudit.tamper_detected, false);
    assert.strictEqual(initialAudit.status, 'VERIFIED_GENUINE');

    // Simulate tampering: malicious actor changes amount from 100M to 150M in relational DB
    await payablesService.tamperDatabaseRecord(target.id, '150000000.00', adminUser);

    // Re-audit: system MUST detect mismatch
    const tamperedAudit = await payablesService.auditPayableIntegrity(target.id, adminUser);
    assert.strictEqual(tamperedAudit.is_match, false);
    assert.strictEqual(tamperedAudit.tamper_detected, true);
    assert.strictEqual(tamperedAudit.status, 'TAMPER_DETECTED');
    assert.notStrictEqual(tamperedAudit.database_hash, tamperedAudit.ledger_hash);

    // Restore genuine record
    await payablesService.restoreDatabaseRecord(target.id, adminUser);

    // Re-audit: integrity restored
    const restoredAudit = await payablesService.auditPayableIntegrity(target.id, adminUser);
    assert.strictEqual(restoredAudit.is_match, true);
    assert.strictEqual(restoredAudit.tamper_detected, false);
    assert.strictEqual(restoredAudit.status, 'VERIFIED_GENUINE');
  });
});

export async function runPayablesLifecycleTests(): Promise<{ passed: number; failed: number }> {
  console.log('\x1b[36m=== Suite: Phase 4 Accounts Payable Ledger (Read-Only) & Tamper Detection ===\x1b[0m');
  const db = DatabaseService.getInstance();
  await db.seedDefaultData();
  const payablesService = new PayablesService();

  const adminUser = {
    id: 'usr-admin-001',
    name: 'System Administrator',
    email: 'admin@example.local',
    role: Role.ADMIN,
    organizationId: 'org-001-default-uuid',
    status: UserStatus.ACTIVE,
  };

  let passed = 0;
  let failed = 0;

  const check = (desc: string, condition: boolean) => {
    if (condition) {
      console.log(`  \x1b[32m✓\x1b[0m ${desc}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${desc}`);
      failed++;
    }
  };

  try {
    // 1. Seeded 4-Month Cycle
    const summary = await payablesService.getPayablesSummary(adminUser);
    check('Seeded 4-Month Cycle breakdown contains 4 periods', summary.period_breakdown.length === 4);
    const b1 = summary.period_breakdown.find((p) => p.period === 'Bulan 1');
    const b2 = summary.period_breakdown.find((p) => p.period === 'Bulan 2');
    const b3 = summary.period_breakdown.find((p) => p.period === 'Bulan 3');
    check('Bulan 1 total obligation matches Rp150.000.000 (Vendor A 100M + Vendor B 50M)', b1?.total_amount === '150000000.00');
    check('Bulan 2 total obligation matches Rp200.000.000 (PO-003 75M + PO-004 125M)', b2?.total_amount === '200000000.00');
    check('Bulan 3 total obligation matches Rp200.000.000 (PO-005 200M)', b3?.total_amount === '200000000.00');

    // 2. Tamper-evident Detection
    const payables = await payablesService.getPayables({}, adminUser);
    const target = payables.items[0];

    const initialAudit = await payablesService.auditPayableIntegrity(target.id, adminUser);
    check('Cryptographic audit confirms genuine database state matches Hyperledger Fabric hash', initialAudit.is_match && !initialAudit.tamper_detected);

    await payablesService.tamperDatabaseRecord(target.id, '999999999.00', adminUser);
    const tamperedAudit = await payablesService.auditPayableIntegrity(target.id, adminUser);
    check('Tamper Detection Lab flags database manipulation with MISMATCH (Database Hash != Fabric Hash)', !tamperedAudit.is_match && tamperedAudit.tamper_detected);

    await payablesService.restoreDatabaseRecord(target.id, adminUser);
    const restoredAudit = await payablesService.auditPayableIntegrity(target.id, adminUser);
    check('Restoration of authentic ledger values returns state to VERIFIED_GENUINE', restoredAudit.is_match && !restoredAudit.tamper_detected);
  } catch (err: any) {
    console.error('Payables test error:', err);
    failed++;
  }

  return { passed, failed };
}
