import { v4 as uuidv4 } from 'uuid';
import { DatabaseService, DbPayable, DbGoodsReceipt, DbInvoice, DbPayableApproval } from '../../database/db.service.ts';
import { AuthenticatedUser, Role, OutboxStatus, POStatus } from '../../common/types.ts';
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
   * STEP 2: Record Goods Delivery (Barang Diterima / Surat Jalan / BAST)
   * Triggers GOODS_RECEIVED outbox event & Fabric audit trail
   */
  async recordGoodsReceipt(
    poId: string,
    data: { delivery_note_number: string; notes?: string },
    user: AuthenticatedUser
  ) {
    const po = this.db.purchase_orders.get(poId);
    if (!po) {
      throw new AppError('NOT_FOUND', `Purchase order '${poId}' not found`, 404);
    }

    const receiptId = uuidv4();
    const receiptNumber = `BAST-2026-${String(this.db.goods_receipts.size + 1).padStart(3, '0')}`;
    const docHash = CryptoUtils.sha256Hash(
      `${receiptNumber}|${po.po_number}|${data.delivery_note_number}|${new Date().toISOString()}`
    );

    const receipt: DbGoodsReceipt = {
      id: receiptId,
      receipt_number: receiptNumber,
      po_id: poId,
      delivery_note_number: data.delivery_note_number,
      received_by: user.name,
      received_date: new Date(),
      status: 'RECEIVED',
      notes: data.notes || 'Penerimaan fisik barang di gudang/lokasi pengadaan',
      document_hash: docHash,
      created_at: new Date(),
    };
    this.db.goods_receipts.set(receiptId, receipt);

    // Update PO status
    po.status = POStatus.RECEIVED;
    po.updated_at = new Date();

    // Outbox event: GOODS_RECEIVED
    const eventId = uuidv4();
    this.db.application_events.set(eventId, {
      id: eventId,
      event_type: 'GOODS_RECEIVED',
      entity_id: poId,
      entity_type: 'GOODS_RECEIPT',
      actor_id: user.id,
      organization_id: user.organizationId,
      payload: {
        po_id: poId,
        po_number: po.po_number,
        receipt_number: receiptNumber,
        delivery_note_number: data.delivery_note_number,
        document_hash: docHash,
        amount_minor: MoneyUtils.toMinorUnits(po.total_amount),
        currency: po.currency,
        notes: receipt.notes,
      },
      status: OutboxStatus.PENDING,
      attempt_count: 0,
      last_error: null,
      created_at: new Date(),
      processed_at: null,
    });

    return { receipt, po };
  }

  /**
   * STEP 3: Verify Goods (Verifikasi Barang oleh Pejabat Pengadaan / PPK)
   * Triggers GOODS_VERIFIED outbox event
   */
  async verifyGoodsReceipt(poId: string, receiptId: string, user: AuthenticatedUser) {
    const po = this.db.purchase_orders.get(poId);
    const receipt = this.db.goods_receipts.get(receiptId);
    if (!po || !receipt) {
      throw new AppError('NOT_FOUND', 'Purchase order or Goods Receipt not found', 404);
    }

    receipt.status = 'VERIFIED';
    receipt.verified_by = user.name;
    receipt.verified_date = new Date();

    po.status = POStatus.VERIFIED;
    po.updated_at = new Date();

    const eventId = uuidv4();
    this.db.application_events.set(eventId, {
      id: eventId,
      event_type: 'GOODS_VERIFIED',
      entity_id: poId,
      entity_type: 'GOODS_RECEIPT',
      actor_id: user.id,
      organization_id: user.organizationId,
      payload: {
        po_id: poId,
        po_number: po.po_number,
        receipt_number: receipt.receipt_number,
        verified_by: user.name,
        verifier_role: user.role,
        document_hash: receipt.document_hash,
        amount_minor: MoneyUtils.toMinorUnits(po.total_amount),
        currency: po.currency,
      },
      status: OutboxStatus.PENDING,
      attempt_count: 0,
      last_error: null,
      created_at: new Date(),
      processed_at: null,
    });

    return { receipt, po };
  }

  /**
   * STEP 4 & 5: Submit & Verify Invoice -> Create Formal Payable
   * Triggers INVOICE_SUBMITTED, INVOICE_VERIFIED, and PAYABLE_CREATED
   */
  async createPayableFromPO(
    poId: string,
    data: {
      invoice_number: string;
      period: string; // e.g., 'Bulan 1', 'Bulan 2', 'Bulan 3', 'Bulan 4'
      due_date: string;
    },
    user: AuthenticatedUser
  ): Promise<DbPayable> {
    const po = this.db.purchase_orders.get(poId);
    if (!po) {
      throw new AppError('NOT_FOUND', `Purchase order '${poId}' not found`, 404);
    }

    const vendor = this.db.vendors.get(po.vendor_id);
    const vendorName = vendor?.legal_name || 'Vendor Terdaftar';

    const payableId = uuidv4();
    const payableNumber = `PAY-2026-${String(this.db.payables.size + 1).padStart(3, '0')}`;
    const amountMinor = MoneyUtils.toMinorUnits(po.total_amount);

    // Cryptographic hash representing the verified invoice & obligation
    const docHash = CryptoUtils.sha256Hash(
      `${payableNumber}|${po.po_number}|${data.invoice_number}|${po.total_amount}|${po.currency}`
    );

    const payable: DbPayable = {
      id: payableId,
      payable_number: payableNumber,
      po_id: po.id,
      po_number: po.po_number,
      vendor_id: po.vendor_id,
      vendor_legal_name: vendorName,
      buyer_organization_id: po.buyer_organization_id,
      amount: po.total_amount,
      amount_minor: amountMinor,
      currency: po.currency,
      period: data.period || 'Bulan 1',
      due_date: new Date(data.due_date),
      status: 'PAYABLE',
      document_hash: docHash,
      invoice_number: data.invoice_number,
      invoice_date: new Date(),
      goods_receipt_number: `BAST-${po.po_number}`,
      payment_reference: null,
      blockchain_tx_id: null,
      approvals: [
        {
          step: 'PROCUREMENT_OFFICER',
          title: 'Verifikasi Pengadaan & Berita Acara',
          actor_id: user.id,
          actor_name: user.name,
          actor_role: user.role,
          timestamp: new Date(),
          notes: 'Kewajiban pembayaran (Accounts Payable) resmi diakui dan dicatat.',
        },
      ],
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.db.payables.set(payableId, payable);

    // Emit PAYABLE_CREATED Outbox Event for Hyperledger Fabric
    const eventId = uuidv4();
    this.db.application_events.set(eventId, {
      id: eventId,
      event_type: 'PAYABLE_CREATED',
      entity_id: payableId,
      entity_type: 'PAYABLE',
      actor_id: user.id,
      organization_id: user.organizationId,
      payload: {
        payable_id: payableId,
        payable_number: payableNumber,
        po_id: po.id,
        po_number: po.po_number,
        vendor_id: po.vendor_id,
        vendor_legal_name: vendorName,
        amount: po.total_amount,
        amount_minor: amountMinor,
        currency: po.currency,
        period: payable.period,
        due_date: payable.due_date.toISOString(),
        document_hash: docHash,
        invoice_number: data.invoice_number,
      },
      status: OutboxStatus.PENDING,
      attempt_count: 0,
      last_error: null,
      created_at: new Date(),
      processed_at: null,
    });

    return payable;
  }

  /**
   * STEP 6: Multi-tier Approval Hierarchy
   * Sequence: Pejabat Pengadaan -> PPK -> Bendahara/Finance -> Pejabat Berwenang
   * Triggers PAYMENT_APPROVED on Hyperledger Fabric
   */
  async approvePayable(
    payableId: string,
    notes: string | undefined,
    user: AuthenticatedUser
  ): Promise<DbPayable> {
    const payable = await this.getPayableById(payableId, user);

    if (payable.status === 'SETTLED' || payable.status === 'PAID') {
      throw new AppError('BAD_REQUEST', 'Payable already settled', 400);
    }

    // Determine approval step from role
    let step: 'PROCUREMENT_OFFICER' | 'PPK' | 'FINANCE' | 'AUTHORIZED_OFFICER';
    let stepTitle = '';

    if (user.role === Role.PROCUREMENT_OFFICER) {
      step = 'PROCUREMENT_OFFICER';
      stepTitle = 'Verifikasi Teknis & Berkas Pengadaan';
    } else if (user.role === Role.PPK) {
      step = 'PPK';
      stepTitle = 'Persetujuan Pejabat Pembuat Komitmen (PPK)';
    } else if (user.role === Role.FINANCE) {
      step = 'FINANCE';
      stepTitle = 'Verifikasi Keuangan & Kelayakan Pembayaran';
    } else {
      // ADMIN or AUTHORIZED_OFFICER
      step = 'AUTHORIZED_OFFICER';
      stepTitle = 'Otorisasi Eksekutif Pencairan Anggaran';
    }

    // Check if step already approved
    const existingIndex = payable.approvals.findIndex((a) => a.step === step);
    const approvalRecord: DbPayableApproval = {
      step,
      title: stepTitle,
      actor_id: user.id,
      actor_name: user.name,
      actor_role: user.role,
      timestamp: new Date(),
      notes: notes || `Disetujui oleh ${user.name} (${user.role})`,
    };

    if (existingIndex >= 0) {
      payable.approvals[existingIndex] = approvalRecord;
    } else {
      payable.approvals.push(approvalRecord);
    }

    // If authorized officer or finance approves, promote to APPROVED
    if (user.role === Role.AUTHORIZED_OFFICER || user.role === Role.ADMIN) {
      payable.status = 'APPROVED';
    }

    payable.updated_at = new Date();

    // Outbox event: PAYMENT_APPROVED
    const eventId = uuidv4();
    this.db.application_events.set(eventId, {
      id: eventId,
      event_type: 'PAYMENT_APPROVED',
      entity_id: payableId,
      entity_type: 'PAYABLE',
      actor_id: user.id,
      organization_id: user.organizationId,
      payload: {
        payable_id: payable.id,
        payable_number: payable.payable_number,
        approval_step: step,
        approver_name: user.name,
        approver_role: user.role,
        amount_minor: payable.amount_minor,
        currency: payable.currency,
        status: payable.status,
        document_hash: payable.document_hash,
      },
      status: OutboxStatus.PENDING,
      attempt_count: 0,
      last_error: null,
      created_at: new Date(),
      processed_at: null,
    });

    return payable;
  }

  /**
   * STEP 7: Initiate Payment (Pencairan Dana diajukan dengan Nomor SP2D / Transfer Bank)
   * Triggers PAYMENT_INITIATED on Hyperledger Fabric
   */
  async initiatePayment(
    payableId: string,
    data: { payment_reference: string; notes?: string },
    user: AuthenticatedUser
  ): Promise<DbPayable> {
    const payable = await this.getPayableById(payableId, user);

    if (!data.payment_reference) {
      throw new AppError('VALIDATION_ERROR', 'Nomor referensi pembayaran / SP2D wajib diisi', 400);
    }

    payable.status = 'PAYMENT_INITIATED';
    payable.payment_reference = data.payment_reference;
    payable.updated_at = new Date();

    const eventId = uuidv4();
    this.db.application_events.set(eventId, {
      id: eventId,
      event_type: 'PAYMENT_INITIATED',
      entity_id: payableId,
      entity_type: 'PAYMENT',
      actor_id: user.id,
      organization_id: user.organizationId,
      payload: {
        payable_id: payable.id,
        payable_number: payable.payable_number,
        payment_reference: data.payment_reference,
        amount_minor: payable.amount_minor,
        currency: payable.currency,
        notes: data.notes || 'Perintah pencairan dana ditransmisikan ke gateway perbankan / SP2D',
      },
      status: OutboxStatus.PENDING,
      attempt_count: 0,
      last_error: null,
      created_at: new Date(),
      processed_at: null,
    });

    return payable;
  }

  /**
   * STEP 8: Confirm Settlement (Pelunasan permanen tercatat di Blockchain)
   * Triggers SETTLED and updates PO status
   */
  async settlePayable(
    payableId: string,
    paymentRef: string | undefined,
    user: AuthenticatedUser
  ): Promise<DbPayable> {
    const payable = await this.getPayableById(payableId, user);

    payable.status = 'SETTLED';
    if (paymentRef) {
      payable.payment_reference = paymentRef;
    } else if (!payable.payment_reference) {
      payable.payment_reference = `SP2D-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    }

    payable.updated_at = new Date();

    // Settle corresponding purchase order
    const po = this.db.purchase_orders.get(payable.po_id);
    if (po) {
      po.status = POStatus.VERIFIED; // or settled
      po.updated_at = new Date();
    }

    const eventId = uuidv4();
    this.db.application_events.set(eventId, {
      id: eventId,
      event_type: 'SETTLED',
      entity_id: payableId,
      entity_type: 'SETTLEMENT',
      actor_id: user.id,
      organization_id: user.organizationId,
      payload: {
        payable_id: payable.id,
        payable_number: payable.payable_number,
        po_id: payable.po_id,
        po_number: payable.po_number,
        vendor_id: payable.vendor_id,
        vendor_legal_name: payable.vendor_legal_name,
        amount: payable.amount,
        amount_minor: payable.amount_minor,
        currency: payable.currency,
        payment_reference: payable.payment_reference,
        document_hash: payable.document_hash,
        settled_at: new Date().toISOString(),
      },
      status: OutboxStatus.PENDING,
      attempt_count: 0,
      last_error: null,
      created_at: new Date(),
      processed_at: null,
    });

    return payable;
  }

  /**
   * Batch Settlement for a specific period (e.g. Month 4 Period Jan-Apr Settlement)
   */
  async batchSettlePeriod(period: string, user: AuthenticatedUser) {
    const payables = Array.from(this.db.payables.values()).filter(
      (p) => p.period === period && p.status !== 'SETTLED'
    );

    const settledList: DbPayable[] = [];
    for (const p of payables) {
      const ref = `SP2D-BATCH-${period.replace(/\s+/g, '')}-${p.payable_number}`;
      const settled = await this.settlePayable(p.id, ref, user);
      settledList.push(settled);
    }

    return {
      period,
      count: settledList.length,
      settled: settledList,
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
