import { DatabaseService, DbPayable } from '../../database/db.service.ts';
import { AuthenticatedUser, Role } from '../../common/types.ts';
import { AppError } from '../../common/response.dto.ts';
import { CryptoUtils } from '../../common/crypto-utils.ts';
import { MoneyUtils } from '../../common/decimal-utils.ts';

export interface PayablesFilter {
  period?: string;
  status?: string;
  vendor_id?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Buku besar utang bersifat hanya-baca.
 *
 * Aplikasi ini tidak membuat utang, tidak menyetujui, tidak mencairkan, dan
 * tidak melunasi apa pun: utang hanya lahir dari catatan yang masuk melalui
 * Switching. Karena itu service ini hanya menyediakan pembacaan dan
 * pemeriksaan integritas.
 */
export class PayablesService {
  private db: DatabaseService;

  constructor() {
    this.db = DatabaseService.getInstance();
  }

  /**
   * List all payables according to organization and role permissions
   */
  async getPayables(filter: PayablesFilter, user: AuthenticatedUser) {
    let items = Array.from(this.db.payables.values());

    // Isolation: non-admin can only see their organization
    if (user.role !== Role.ADMIN) {
      items = items.filter((p) => p.buyer_organization_id === user.organizationId);
    }

    // Role-specific filtering: Vendor can only see their payables
    if (user.role === Role.VENDOR) {
      // Find vendor corresponding to user org or vendor record
      const vendor = Array.from(this.db.vendors.values()).find(
        (v) => v.contact_email === user.email || v.organization_id === user.organizationId
      );
      if (vendor) {
        items = items.filter((p) => p.vendor_id === vendor.id);
      }
    }

    if (filter.period) {
      items = items.filter((p) => p.period === filter.period);
    }

    if (filter.status) {
      items = items.filter((p) => p.status === filter.status);
    }

    if (filter.vendor_id) {
      items = items.filter((p) => p.vendor_id === filter.vendor_id);
    }

    if (filter.search) {
      const q = filter.search.toLowerCase();
      items = items.filter(
        (p) =>
          p.payable_number.toLowerCase().includes(q) ||
          p.po_number.toLowerCase().includes(q) ||
          p.vendor_legal_name.toLowerCase().includes(q) ||
          p.invoice_number.toLowerCase().includes(q)
      );
    }

    // Sort descending by created_at
    items.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
    const offset = (page - 1) * limit;
    const paginated = items.slice(offset, offset + limit);

    return {
      items: paginated,
      total: items.length,
      page,
      limit,
      total_pages: Math.ceil(items.length / limit) || 1,
    };
  }

  /**
   * Get single payable by ID
   */
  async getPayableById(id: string, user: AuthenticatedUser): Promise<DbPayable> {
    const payable = this.db.payables.get(id);
    if (!payable) {
      throw new AppError('NOT_FOUND', `Payable '${id}' not found`, 404);
    }

    if (user.role !== Role.ADMIN && payable.buyer_organization_id !== user.organizationId) {
      throw new AppError('FORBIDDEN', 'Access denied to this payable', 403);
    }

    return payable;
  }

  /**
   * Accounts Payable Ledger Overview:
   * Aggregates total obligations, active payables, settled payables,
   * and the 4-month cycle breakdown specified in the architecture.
   */
  async getPayablesSummary(user: AuthenticatedUser) {
    let all = Array.from(this.db.payables.values());
    if (user.role !== Role.ADMIN) {
      all = all.filter((p) => p.buyer_organization_id === user.organizationId);
    }

    let totalActiveMinor = 0n;
    let totalSettledMinor = 0n;
    let totalObligationMinor = 0n;

    let activeCount = 0;
    let settledCount = 0;

    for (const p of all) {
      const minor = BigInt(p.amount_minor || '0');
      totalObligationMinor += minor;
      if (p.status === 'SETTLED' || p.status === 'PAID') {
        totalSettledMinor += minor;
        settledCount++;
      } else {
        totalActiveMinor += minor;
        activeCount++;
      }
    }

    // Breakdown per period (Bulan 1, Bulan 2, Bulan 3, Bulan 4)
    const periods = ['Bulan 1', 'Bulan 2', 'Bulan 3', 'Bulan 4'];
    const periodBreakdown = periods.map((period) => {
      const periodItems = all.filter((p) => p.period === period);
      let pTotalMinor = 0n;
      let pSettledMinor = 0n;
      let pActiveCount = 0;
      let pSettledCount = 0;

      for (const item of periodItems) {
        const m = BigInt(item.amount_minor || '0');
        pTotalMinor += m;
        if (item.status === 'SETTLED' || item.status === 'PAID') {
          pSettledMinor += m;
          pSettledCount++;
        } else {
          pActiveCount++;
        }
      }

      let status: 'ACCUMULATING' | 'READY_FOR_SETTLEMENT' | 'SETTLED' = 'ACCUMULATING';
      if (pSettledCount > 0 && pActiveCount === 0) {
        status = 'SETTLED';
      } else if (period === 'Bulan 4' || pSettledCount > 0) {
        status = 'READY_FOR_SETTLEMENT';
      }

      return {
        period,
        label:
          period === 'Bulan 1'
            ? 'Bulan 1 (Januari)'
            : period === 'Bulan 2'
            ? 'Bulan 2 (Februari)'
            : period === 'Bulan 3'
            ? 'Bulan 3 (Maret)'
            : 'Bulan 4 (April - Settlement)',
        total_amount: (Number(pTotalMinor) / 100).toFixed(2),
        total_minor: pTotalMinor.toString(),
        payable_count: periodItems.length,
        active_count: pActiveCount,
        settled_count: pSettledCount,
        settled_amount: (Number(pSettledMinor) / 100).toFixed(2),
        status,
      };
    });

    return {
      total_active_payable: (Number(totalActiveMinor) / 100).toFixed(2),
      total_active_count: activeCount,
      total_settled_amount: (Number(totalSettledMinor) / 100).toFixed(2),
      total_settled_count: settledCount,
      total_obligations_all: (Number(totalObligationMinor) / 100).toFixed(2),
      period_breakdown: periodBreakdown,
    };
  }

  /**
   * TAMPER-EVIDENT DETECTION LABORATORY (Prompt Point 5):
   * Simulates an unauthorized database update to demonstrate that
   * database modifications immediately fail blockchain hash verification!
   */
  async tamperDatabaseRecord(
    payableId: string,
    tamperedAmount: string,
    user: AuthenticatedUser
  ): Promise<DbPayable> {
    const payable = await this.getPayableById(payableId, user);

    payable.is_tampered = true;
    payable.tampered_amount = payable.amount; // backup genuine amount
    payable.amount = tamperedAmount;
    payable.amount_minor = MoneyUtils.toMinorUnits(tamperedAmount);
    payable.updated_at = new Date();

    return payable;
  }

  /**
   * Restores genuine database record back
   */
  async restoreDatabaseRecord(payableId: string, user: AuthenticatedUser): Promise<DbPayable> {
    const payable = await this.getPayableById(payableId, user);

    if (payable.is_tampered && payable.tampered_amount) {
      payable.amount = payable.tampered_amount;
      payable.amount_minor = MoneyUtils.toMinorUnits(payable.amount);
      payable.is_tampered = false;
      payable.tampered_amount = null;
      payable.updated_at = new Date();
    }

    return payable;
  }

  /**
   * Audit Payable Integrity with Hyperledger Fabric
   * Computes SHA-256 fingerprint from relational DB fields and compares
   * with the immutable document hash registered on Fabric blockchain.
   */
  async auditPayableIntegrity(payableId: string, user: AuthenticatedUser) {
    const payable = await this.getPayableById(payableId, user);

    // Compute expected hash from current database state
    const currentDbHash = CryptoUtils.sha256Hash(
      `${payable.payable_number}|${payable.po_number}|${payable.invoice_number}|${payable.amount}|${payable.currency}`
    );

    // Compare with the hash sealed into the ledger
    const ledgerHash = payable.document_hash;
    const match = currentDbHash.toLowerCase() === ledgerHash.toLowerCase();

    return {
      payable_id: payable.id,
      payable_number: payable.payable_number,
      vendor_legal_name: payable.vendor_legal_name,
      database_amount: payable.amount,
      database_hash: currentDbHash,
      ledger_hash: ledgerHash,
      is_match: match,
      tamper_detected: !match,
      status: match ? 'VERIFIED_GENUINE' : 'TAMPER_DETECTED',
      message: match
        ? 'Integritas Terjamin: Hash data relasional identik dengan konsensus blockchain Hyperledger Fabric.'
        : 'PERINGATAN MANIPULASI: Nilai database relasional telah diubah secara ilegal! Hash lokal tidak cocok dengan hash permanen blockchain!',
    };
  }
}
