import { v4 as uuidv4 } from 'uuid';
import {
  Role,
  UserStatus,
  OrganizationStatus,
  VendorStatus,
  POStatus,
  OutboxStatus,
  BlockchainTxStatus,
} from '../common/types.ts';
import { CryptoUtils } from '../common/crypto-utils.ts';
import { PersistentMap } from './persistent-map.ts';
import { PostgresStore, TABLES } from './postgres.store.ts';

export interface DbOrganization {
  id: string;
  name: string;
  code: string;
  address: string | null;
  contact_email: string | null;
  status: OrganizationStatus;
  created_at: Date;
  updated_at: Date;
}

export interface DbUser {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  organization_id: string;
  status: UserStatus;
  refresh_token_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbVendor {
  id: string;
  vendor_code: string;
  legal_name: string;
  tax_id: string;
  address: string;
  contact_email: string;
  organization_id: string;
  status: VendorStatus;
  created_at: Date;
  updated_at: Date;
}

export interface DbPurchaseOrder {
  id: string;
  po_number: string;
  vendor_id: string;
  buyer_organization_id: string;
  description: string;
  total_amount: string; // Stored as decimal string to preserve precision
  currency: string;
  issue_date: Date | null;
  due_date: Date;
  status: POStatus;
  blockchain_status: string;
  document_hash?: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface DbPurchaseOrderItem {
  id: string;
  po_id: string;
  description: string;
  quantity: string;
  unit_price: string;
  total_price: string;
  created_at: Date;
}

export interface DbDocument {
  id: string;
  entity_id: string;
  entity_type: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  file_path: string;
  sha256_hash: string;
  uploaded_by: string;
  uploaded_at: Date;
}

export interface DbApplicationEvent {
  id: string;
  event_type: string;
  entity_id: string;
  entity_type: string;
  actor_id: string | null;
  organization_id: string | null;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
  processed_at: Date | null;
}

export interface DbBlockchainTransaction {
  id: string;
  application_event_id: string;
  transaction_id: string;
  event_type: string;
  entity_id: string;
  entity_type: string;
  status: BlockchainTxStatus;
  error_message: string | null;
  submitted_at: Date;
  confirmed_at: Date | null;
}

export type DbPayableStatus = 'PAYABLE' | 'APPROVED' | 'PAYMENT_INITIATED' | 'PAID' | 'SETTLED';

export interface DbPayableApproval {
  step: 'PROCUREMENT_OFFICER' | 'PPK' | 'FINANCE' | 'AUTHORIZED_OFFICER';
  title: string;
  actor_id: string;
  actor_name: string;
  actor_role: Role;
  timestamp: Date;
  notes?: string;
}

export interface DbPayable {
  id: string;
  payable_number: string;
  po_id: string;
  po_number: string;
  vendor_id: string;
  vendor_legal_name: string;
  buyer_organization_id: string;
  amount: string; // decimal e.g. "100000000.00"
  amount_minor: string; // "10000000000"
  currency: string;
  period: string; // "Bulan 1", "Bulan 2", "Bulan 3", "Bulan 4"
  due_date: Date;
  status: DbPayableStatus;
  document_hash: string;
  invoice_number: string;
  invoice_date: Date;
  goods_receipt_number?: string;
  payment_reference?: string | null;
  blockchain_tx_id?: string | null;
  approvals: DbPayableApproval[];
  is_tampered?: boolean;
  tampered_amount?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbGoodsReceipt {
  id: string;
  receipt_number: string;
  po_id: string;
  delivery_note_number: string;
  received_by: string;
  received_date: Date;
  verified_by?: string;
  verified_date?: Date;
  status: 'RECEIVED' | 'VERIFIED' | 'REJECTED';
  notes: string;
  document_hash: string;
  created_at: Date;
}

export interface DbInvoice {
  id: string;
  invoice_number: string;
  po_id: string;
  vendor_id: string;
  amount: string;
  currency: string;
  invoice_date: Date;
  due_date: Date;
  status: 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
  document_hash: string;
  created_at: Date;
}

export class DatabaseService {
  private static instance: DatabaseService;

  /**
   * Persistence adapter Neon Postgres. Bernilai `null` bila `DATABASE_URL` tidak tersedia,
   * sehingga development lokal tetap berjalan sepenuhnya in-memory seperti sebelumnya.
   * Catatan: field ini WAJIB dideklarasikan sebelum koleksi di bawah karena initializer
   * dieksekusi berurutan.
   */
  private store: PostgresStore | null = PostgresStore.fromEnv();

  public organizations: Map<string, DbOrganization> = this.createCollection('organizations');
  public users: Map<string, DbUser> = this.createCollection('users');
  public vendors: Map<string, DbVendor> = this.createCollection('vendors');
  public purchase_orders: Map<string, DbPurchaseOrder> = this.createCollection('purchase_orders');
  public purchase_order_items: Map<string, DbPurchaseOrderItem> = this.createCollection('purchase_order_items');
  public documents: Map<string, DbDocument> = this.createCollection('documents');
  public application_events: Map<string, DbApplicationEvent> = this.createCollection('application_events');
  public blockchain_transactions: Map<string, DbBlockchainTransaction> = this.createCollection('blockchain_transactions');
  public payables: Map<string, DbPayable> = this.createCollection('payables');
  public goods_receipts: Map<string, DbGoodsReceipt> = this.createCollection('goods_receipts');
  public invoices: Map<string, DbInvoice> = this.createCollection('invoices');

  private seedPromise: Promise<void> | null = null;

  private constructor() {
    this.seedPromise = this.internalSeed();
  }

  /**
   * Membuat koleksi: PersistentMap (write-through ke Postgres) bila persistence aktif,
   * atau Map biasa bila tidak. Keduanya punya API sinkron yang identik.
   */
  private createCollection<V extends { id: string }>(name: string): Map<string, V> {
    return this.store ? this.store.createMap<V>(name) : new Map<string, V>();
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  public async seedDefaultData(): Promise<void> {
    if (this.seedPromise) {
      await this.seedPromise;
    }
    // Pastikan data seed benar-benar tersimpan sebelum request pertama dilayani.
    await this.flushPersistence();
  }

  /** True bila data dipersistensikan ke Neon Postgres (bukan hanya in-memory). */
  public isPersistenceEnabled(): boolean {
    return this.store !== null;
  }

  /** Menunggu seluruh penulisan async selesai. Dipanggil sebelum response dikirim. */
  public async flushPersistence(): Promise<void> {
    if (this.store) {
      await this.store.flush();
    }
  }

  /** Memuat hasil query ke Map tanpa memicu tulis balik ke database. */
  private hydrateFromStore(loaded: Map<string, Record<string, unknown>[]>): void {
    const hydrate = <V>(map: Map<string, V>, tableName: string): void => {
      if (!(map instanceof PersistentMap)) return;
      const rows = loaded.get(tableName) ?? [];
      map.hydrate(rows.map((row) => [String(row.id), row as unknown as V] as const));
    };

    hydrate(this.organizations, 'organizations');
    hydrate(this.users, 'users');
    hydrate(this.vendors, 'vendors');
    hydrate(this.purchase_orders, 'purchase_orders');
    hydrate(this.purchase_order_items, 'purchase_order_items');
    hydrate(this.documents, 'documents');
    hydrate(this.application_events, 'application_events');
    hydrate(this.blockchain_transactions, 'blockchain_transactions');
    hydrate(this.payables, 'payables');
    hydrate(this.goods_receipts, 'goods_receipts');
    hydrate(this.invoices, 'invoices');
  }

  /**
   * Menonaktifkan persistence saat koneksi database gagal, lalu beralih ke Map biasa
   * agar tidak terjadi percobaan tulis yang gagal berulang pada setiap request.
   */
  private disablePersistence(): void {
    if (!this.store) return;
    this.store = null;
    for (const table of TABLES) {
      (this as unknown as Record<string, Map<string, unknown>>)[table.name] = new Map();
    }
  }

  private async internalSeed(): Promise<void> {
    if (this.store) {
      try {
        await this.store.bootstrapSchema();
        const loaded = await this.store.loadAll();
        const totalRows = Array.from(loaded.values()).reduce((sum, rows) => sum + rows.length, 0);

        if (totalRows > 0) {
          // Database sudah berisi data → jadikan sumber kebenaran dan lewati seeding.
          this.hydrateFromStore(loaded);
          return;
        }
      } catch (err) {
        console.warn(
          `[DatabaseService] Postgres persistence tidak aktif (${
            err instanceof Error ? err.message : String(err)
          }). Fallback ke in-memory.`,
        );
        this.disablePersistence();
      }
    }

    // 1. Primary Organization
    const defaultOrgId = 'org-001-default-uuid';
    const org: DbOrganization = {
      id: defaultOrgId,
      name: 'Example Procurement Organization',
      code: 'ORG-001',
      address: 'Jl. Merdeka No. 45, Jakarta Pusat, DKI Jakarta',
      contact_email: 'procurement@org001.example.local',
      status: OrganizationStatus.ACTIVE,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    this.organizations.set(org.id, org);

    // 2. Secondary Organization for testing cross-organization boundary security
    const secondOrgId = 'org-002-isolated-uuid';
    const secondOrg: DbOrganization = {
      id: secondOrgId,
      name: 'Secondary Department Organization',
      code: 'ORG-002',
      address: 'Jl. Thamrin No. 12, Surabaya, Jawa Timur',
      contact_email: 'office@org002.example.local',
      status: OrganizationStatus.ACTIVE,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    this.organizations.set(secondOrg.id, secondOrg);

    // Default password: Password123!
    const defaultPasswordHash = await CryptoUtils.hashPassword('Password123!');

    // 3. Seed Users
    const usersToSeed = [
      {
        id: 'usr-admin-001',
        name: 'System Administrator',
        email: 'admin@example.local',
        role: Role.ADMIN,
        organization_id: defaultOrgId,
      },
      {
        id: 'usr-proc-001',
        name: 'Budi Santoso (Procurement Officer)',
        email: 'procurement@example.local',
        role: Role.PROCUREMENT_OFFICER,
        organization_id: defaultOrgId,
      },
      {
        id: 'usr-ppk-001',
        name: 'Dr. Hendra Gunawan (PPK)',
        email: 'ppk@example.local',
        role: Role.PPK,
        organization_id: defaultOrgId,
      },
      {
        id: 'usr-fin-001',
        name: 'Sri Wahyuni (Finance)',
        email: 'finance@example.local',
        role: Role.FINANCE,
        organization_id: defaultOrgId,
      },
      {
        id: 'usr-audit-001',
        name: 'Ahmad Fauzi (Auditor)',
        email: 'auditor@example.local',
        role: Role.AUDITOR,
        organization_id: defaultOrgId,
      },
      {
        id: 'usr-auth-001',
        name: 'Rudi Hartono (Authorized Officer)',
        email: 'authorized@example.local',
        role: Role.AUTHORIZED_OFFICER,
        organization_id: defaultOrgId,
      },
      {
        id: 'usr-vend-001',
        name: 'Vendor Representative',
        email: 'vendor@example.local',
        role: Role.VENDOR,
        organization_id: defaultOrgId,
      },
      // Cross-org user for testing RBAC isolation
      {
        id: 'usr-proc-002',
        name: 'External Officer (Org 2)',
        email: 'procurement.org2@example.local',
        role: Role.PROCUREMENT_OFFICER,
        organization_id: secondOrgId,
      },
    ];

    for (const u of usersToSeed) {
      this.users.set(u.id, {
        id: u.id,
        name: u.name,
        email: u.email,
        password_hash: defaultPasswordHash,
        role: u.role,
        organization_id: u.organization_id,
        status: UserStatus.ACTIVE,
        refresh_token_hash: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      });
    }

    // 4. Seed Vendor
    const vendorId = 'vend-001-default-uuid';
    const vendor: DbVendor = {
      id: vendorId,
      vendor_code: 'VEND-001',
      legal_name: 'PT Solusi Teknologi Nusantara',
      tax_id: '01.234.567.8-012.000',
      address: 'Kawasan Industri Pulogadung, Jakarta Timur',
      contact_email: 'info@solusiteknologi.co.id',
      organization_id: defaultOrgId,
      status: VendorStatus.ACTIVE,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    this.vendors.set(vendor.id, vendor);

    // 5. Seed an Initial Purchase Order (PO-2026-001)
    const poId = 'po-001-default-uuid';
    const po: DbPurchaseOrder = {
      id: poId,
      po_number: 'PO-2026-001',
      vendor_id: vendorId,
      buyer_organization_id: defaultOrgId,
      description: 'Server hardware and high-availability enterprise node procurement',
      total_amount: '100000000.00',
      currency: 'IDR',
      issue_date: new Date('2026-02-01T00:00:00Z'),
      due_date: new Date('2026-05-01T00:00:00Z'),
      status: POStatus.ISSUED,
      blockchain_status: 'CONFIRMED',
      document_hash: '9f833a6a9b40f3b432a6136d8fe8871b69f6e65ad5ad155a019e07507fc36d93',
      created_by: 'usr-proc-001',
      created_at: new Date('2026-02-01T00:00:00Z'),
      updated_at: new Date('2026-02-01T00:00:00Z'),
    };
    this.purchase_orders.set(po.id, po);

    const item1: DbPurchaseOrderItem = {
      id: uuidv4(),
      po_id: poId,
      description: 'Enterprise Rackmount Server Chassis 2U Xeon Scalable',
      quantity: '2.00',
      unit_price: '40000000.00',
      total_price: '80000000.00',
      created_at: new Date('2026-02-01T00:00:00Z'),
    };
    const item2: DbPurchaseOrderItem = {
      id: uuidv4(),
      po_id: poId,
      description: 'High-speed 10GbE SFP+ Fiber Network Transceiver Module Kit',
      quantity: '4.00',
      unit_price: '5000000.00',
      total_price: '20000000.00',
      created_at: new Date('2026-02-01T00:00:00Z'),
    };
    this.purchase_order_items.set(item1.id, item1);
    this.purchase_order_items.set(item2.id, item2);

    // Initial confirmed blockchain transaction
    const initialEventId = uuidv4();
    this.application_events.set(initialEventId, {
      id: initialEventId,
      event_type: 'PO_ISSUED',
      entity_id: poId,
      entity_type: 'PURCHASE_ORDER',
      actor_id: 'usr-proc-001',
      organization_id: defaultOrgId,
      payload: {
        po_number: 'PO-2026-001',
        total_amount: '100000000.00',
        document_hash: '9f833a6a9b40f3b432a6136d8fe8871b69f6e65ad5ad155a019e07507fc36d93',
      },
      status: OutboxStatus.CONFIRMED,
      attempt_count: 1,
      last_error: null,
      created_at: new Date('2026-02-01T00:00:00Z'),
      processed_at: new Date('2026-02-01T00:00:01Z'),
    });

    const txId = 'tx_fabric_seed_po_issued_001';
    this.blockchain_transactions.set(txId, {
      id: uuidv4(),
      application_event_id: initialEventId,
      transaction_id: txId,
      event_type: 'PO_ISSUED',
      entity_id: poId,
      entity_type: 'PURCHASE_ORDER',
      status: BlockchainTxStatus.CONFIRMED,
      error_message: null,
      submitted_at: new Date('2026-02-01T00:00:01Z'),
      confirmed_at: new Date('2026-02-01T00:00:02Z'),
    });

    // 6. Seed Additional Vendors for 4-Month Accounts Payable Cycle
    const vendor2Id = 'vend-002-default-uuid';
    const vendor2: DbVendor = {
      id: vendor2Id,
      vendor_code: 'VND-002',
      legal_name: 'PT Graha Mitra Abadi',
      tax_id: '02.987.654.3-210.000',
      address: 'Jl. Gatot Subroto No. 45, Jakarta Selatan',
      contact_email: 'mitra@grahamitra.co.id',
      organization_id: defaultOrgId,
      status: VendorStatus.ACTIVE,
      created_at: new Date('2026-01-05T00:00:00Z'),
      updated_at: new Date('2026-01-05T00:00:00Z'),
    };
    this.vendors.set(vendor2.id, vendor2);

    const vendor3Id = 'vend-003-default-uuid';
    const vendor3: DbVendor = {
      id: vendor3Id,
      vendor_code: 'VND-003',
      legal_name: 'PT Sentra Logistik Prima',
      tax_id: '03.456.789.0-123.000',
      address: 'Kawasan Industri Pulogadung Blok B, Jakarta Timur',
      contact_email: 'sales@sentralogistik.co.id',
      organization_id: defaultOrgId,
      status: VendorStatus.ACTIVE,
      created_at: new Date('2026-01-10T00:00:00Z'),
      updated_at: new Date('2026-01-10T00:00:00Z'),
    };
    this.vendors.set(vendor3.id, vendor3);

    // 7. Seed 4-Month Procurement & Accounts Payable Ledger Cycle
    // Month 1: PO-001 (Vendor A, 100M) + PO-002 (Vendor B, 50M) => Total 150M
    const po2Id = 'po-002-default-uuid';
    this.purchase_orders.set(po2Id, {
      id: po2Id,
      po_number: 'PO-2026-002',
      vendor_id: vendor2Id,
      buyer_organization_id: defaultOrgId,
      description: 'Pengadaan Infrastruktur Jaringan & Switch Core 48-Port',
      total_amount: '50000000.00',
      currency: 'IDR',
      issue_date: new Date('2026-01-15T00:00:00Z'),
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: POStatus.ISSUED,
      blockchain_status: 'CONFIRMED',
      document_hash: '8ad307dc691e4bbc0bc8272717179a08c1ae562c4e04dcc1ad72ee7df4ce7bd1',
      created_by: 'usr-proc-001',
      created_at: new Date('2026-01-15T00:00:00Z'),
      updated_at: new Date('2026-01-15T00:00:00Z'),
    });

    // Month 2: PO-003 (Vendor C, 75M) + PO-004 (Vendor B, 125M) => Running 350M
    const po3Id = 'po-003-default-uuid';
    this.purchase_orders.set(po3Id, {
      id: po3Id,
      po_number: 'PO-2026-003',
      vendor_id: vendor3Id,
      buyer_organization_id: defaultOrgId,
      description: 'Layanan Distribusi Logistik Perangkat Data Center Multi-Regional',
      total_amount: '75000000.00',
      currency: 'IDR',
      issue_date: new Date('2026-02-10T00:00:00Z'),
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: POStatus.ISSUED,
      blockchain_status: 'CONFIRMED',
      document_hash: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
      created_by: 'usr-proc-001',
      created_at: new Date('2026-02-10T00:00:00Z'),
      updated_at: new Date('2026-02-10T00:00:00Z'),
    });

    const po4Id = 'po-004-default-uuid';
    this.purchase_orders.set(po4Id, {
      id: po4Id,
      po_number: 'PO-2026-004',
      vendor_id: vendor2Id,
      buyer_organization_id: defaultOrgId,
      description: 'Upgrade Lisensi Perangkat Keras Security Appliance Firewall Next-Gen',
      total_amount: '125000000.00',
      currency: 'IDR',
      issue_date: new Date('2026-02-22T00:00:00Z'),
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: POStatus.ISSUED,
      blockchain_status: 'CONFIRMED',
      document_hash: 'fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9',
      created_by: 'usr-proc-001',
      created_at: new Date('2026-02-22T00:00:00Z'),
      updated_at: new Date('2026-02-22T00:00:00Z'),
    });

    // Month 3: PO-005 (Vendor A, 200M) => Running 550M
    const po5Id = 'po-005-default-uuid';
    this.purchase_orders.set(po5Id, {
      id: po5Id,
      po_number: 'PO-2026-005',
      vendor_id: vendorId,
      buyer_organization_id: defaultOrgId,
      description: 'Pengadaan Node Komputasi Tambahan Kluster Fabric 128 Core RAM 512GB',
      total_amount: '200000000.00',
      currency: 'IDR',
      issue_date: new Date('2026-03-05T00:00:00Z'),
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: POStatus.ISSUED,
      blockchain_status: 'CONFIRMED',
      document_hash: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
      created_by: 'usr-proc-001',
      created_at: new Date('2026-03-05T00:00:00Z'),
      updated_at: new Date('2026-03-05T00:00:00Z'),
    });

    // Seed Payables representing the Accounts Payable Ledger (Buku Besar Utang)
    // 1. Month 1 Payable 1: Vendor A (Rp 100M)
    const pay1Id = 'pay-001-default-uuid';
    const pay1Hash = CryptoUtils.sha256Hash('PAY-2026-001|PO-2026-001|INV-2026-001|100000000.00|IDR');
    this.payables.set(pay1Id, {
      id: pay1Id,
      payable_number: 'PAY-2026-001',
      po_id: poId,
      po_number: 'PO-2026-001',
      vendor_id: vendorId,
      vendor_legal_name: 'PT Solusi Teknologi Nusantara',
      buyer_organization_id: defaultOrgId,
      amount: '100000000.00',
      amount_minor: '10000000000',
      currency: 'IDR',
      period: 'Bulan 1',
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: 'PAYABLE',
      document_hash: pay1Hash,
      invoice_number: 'INV-2026-001',
      invoice_date: new Date('2026-01-20T00:00:00Z'),
      goods_receipt_number: 'BAST-2026-001',
      blockchain_tx_id: 'tx_fabric_pay_001_seed',
      approvals: [
        {
          step: 'PROCUREMENT_OFFICER',
          title: 'Verifikasi Barang & Spesifikasi',
          actor_id: 'usr-proc-001',
          actor_name: 'Budi Santoso',
          actor_role: Role.PROCUREMENT_OFFICER,
          timestamp: new Date('2026-01-22T00:00:00Z'),
          notes: 'Fisik rack server telah diperiksa dan sesuai spesifikasi teknis.',
        },
      ],
      created_at: new Date('2026-01-22T00:00:00Z'),
      updated_at: new Date('2026-01-22T00:00:00Z'),
    });

    // 2. Month 1 Payable 2: Vendor B (Rp 50M)
    const pay2Id = 'pay-002-default-uuid';
    const pay2Hash = CryptoUtils.sha256Hash('PAY-2026-002|PO-2026-002|INV-2026-002|50000000.00|IDR');
    this.payables.set(pay2Id, {
      id: pay2Id,
      payable_number: 'PAY-2026-002',
      po_id: po2Id,
      po_number: 'PO-2026-002',
      vendor_id: vendor2Id,
      vendor_legal_name: 'PT Graha Mitra Abadi',
      buyer_organization_id: defaultOrgId,
      amount: '50000000.00',
      amount_minor: '5000000000',
      currency: 'IDR',
      period: 'Bulan 1',
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: 'PAYABLE',
      document_hash: pay2Hash,
      invoice_number: 'INV-2026-002',
      invoice_date: new Date('2026-01-25T00:00:00Z'),
      goods_receipt_number: 'BAST-2026-002',
      blockchain_tx_id: 'tx_fabric_pay_002_seed',
      approvals: [
        {
          step: 'PROCUREMENT_OFFICER',
          title: 'Verifikasi Barang & Spesifikasi',
          actor_id: 'usr-proc-001',
          actor_name: 'Budi Santoso',
          actor_role: Role.PROCUREMENT_OFFICER,
          timestamp: new Date('2026-01-26T00:00:00Z'),
          notes: 'Switch core 48-port telah diterima di ruang server.',
        },
      ],
      created_at: new Date('2026-01-26T00:00:00Z'),
      updated_at: new Date('2026-01-26T00:00:00Z'),
    });

    // 3. Month 2 Payable 3: Vendor C (Rp 75M)
    const pay3Id = 'pay-003-default-uuid';
    const pay3Hash = CryptoUtils.sha256Hash('PAY-2026-003|PO-2026-003|INV-2026-003|75000000.00|IDR');
    this.payables.set(pay3Id, {
      id: pay3Id,
      payable_number: 'PAY-2026-003',
      po_id: po3Id,
      po_number: 'PO-2026-003',
      vendor_id: vendor3Id,
      vendor_legal_name: 'PT Sentra Logistik Prima',
      buyer_organization_id: defaultOrgId,
      amount: '75000000.00',
      amount_minor: '7500000000',
      currency: 'IDR',
      period: 'Bulan 2',
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: 'PAYABLE',
      document_hash: pay3Hash,
      invoice_number: 'INV-2026-003',
      invoice_date: new Date('2026-02-15T00:00:00Z'),
      goods_receipt_number: 'BAST-2026-003',
      blockchain_tx_id: 'tx_fabric_pay_003_seed',
      approvals: [
        {
          step: 'PROCUREMENT_OFFICER',
          title: 'Verifikasi Jasa Logistik',
          actor_id: 'usr-proc-001',
          actor_name: 'Budi Santoso',
          actor_role: Role.PROCUREMENT_OFFICER,
          timestamp: new Date('2026-02-16T00:00:00Z'),
          notes: 'Layanan logistik multi-regional telah diselesaikan.',
        },
      ],
      created_at: new Date('2026-02-16T00:00:00Z'),
      updated_at: new Date('2026-02-16T00:00:00Z'),
    });

    // 4. Month 2 Payable 4: Vendor B (Rp 125M) - already Approved by PPK & Finance
    const pay4Id = 'pay-004-default-uuid';
    const pay4Hash = CryptoUtils.sha256Hash('PAY-2026-004|PO-2026-004|INV-2026-004|125000000.00|IDR');
    this.payables.set(pay4Id, {
      id: pay4Id,
      payable_number: 'PAY-2026-004',
      po_id: po4Id,
      po_number: 'PO-2026-004',
      vendor_id: vendor2Id,
      vendor_legal_name: 'PT Graha Mitra Abadi',
      buyer_organization_id: defaultOrgId,
      amount: '125000000.00',
      amount_minor: '12500000000',
      currency: 'IDR',
      period: 'Bulan 2',
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: 'APPROVED',
      document_hash: pay4Hash,
      invoice_number: 'INV-2026-004',
      invoice_date: new Date('2026-02-25T00:00:00Z'),
      goods_receipt_number: 'BAST-2026-004',
      blockchain_tx_id: 'tx_fabric_pay_004_seed',
      approvals: [
        {
          step: 'PROCUREMENT_OFFICER',
          title: 'Verifikasi Teknis',
          actor_id: 'usr-proc-001',
          actor_name: 'Budi Santoso',
          actor_role: Role.PROCUREMENT_OFFICER,
          timestamp: new Date('2026-02-26T00:00:00Z'),
          notes: 'Lisensi firewall appliance telah aktif valid 3 tahun.',
        },
        {
          step: 'PPK',
          title: 'Persetujuan Pejabat Pembuat Komitmen',
          actor_id: 'usr-ppk-001',
          actor_name: 'Dr. Hendra Gunawan (PPK)',
          actor_role: Role.PPK,
          timestamp: new Date('2026-02-27T00:00:00Z'),
          notes: 'Komitmen anggaran belanja modal disetujui.',
        },
        {
          step: 'FINANCE',
          title: 'Verifikasi Kelengkapan Berkas Tagihan',
          actor_id: 'usr-fin-001',
          actor_name: 'Sri Wahyuni (Finance)',
          actor_role: Role.FINANCE,
          timestamp: new Date('2026-02-28T00:00:00Z'),
          notes: 'Faktur pajak dan kwitansi lengkap.',
        },
      ],
      created_at: new Date('2026-02-26T00:00:00Z'),
      updated_at: new Date('2026-02-28T00:00:00Z'),
    });

    // 5. Month 3 Payable 5: Vendor A (Rp 200M)
    const pay5Id = 'pay-005-default-uuid';
    const pay5Hash = CryptoUtils.sha256Hash('PAY-2026-005|PO-2026-005|INV-2026-005|200000000.00|IDR');
    this.payables.set(pay5Id, {
      id: pay5Id,
      payable_number: 'PAY-2026-005',
      po_id: po5Id,
      po_number: 'PO-2026-005',
      vendor_id: vendorId,
      vendor_legal_name: 'PT Solusi Teknologi Nusantara',
      buyer_organization_id: defaultOrgId,
      amount: '200000000.00',
      amount_minor: '20000000000',
      currency: 'IDR',
      period: 'Bulan 3',
      due_date: new Date('2026-04-30T00:00:00Z'),
      status: 'PAYABLE',
      document_hash: pay5Hash,
      invoice_number: 'INV-2026-005',
      invoice_date: new Date('2026-03-08T00:00:00Z'),
      goods_receipt_number: 'BAST-2026-005',
      blockchain_tx_id: 'tx_fabric_pay_005_seed',
      approvals: [
        {
          step: 'PROCUREMENT_OFFICER',
          title: 'Pemeriksaan Barang Masuk',
          actor_id: 'usr-proc-001',
          actor_name: 'Budi Santoso',
          actor_role: Role.PROCUREMENT_OFFICER,
          timestamp: new Date('2026-03-09T00:00:00Z'),
          notes: 'RAM 512GB & dual CPU cluster lolos uji benchmark.',
        },
      ],
      created_at: new Date('2026-03-09T00:00:00Z'),
      updated_at: new Date('2026-03-09T00:00:00Z'),
    });

    // 6. Historical Settled Payable: Vendor C (Rp 75M) - for demonstrating SETTLED state on ledger
    const paySettledId = 'pay-000-settled-uuid';
    const paySettledHash = CryptoUtils.sha256Hash('PAY-2025-099|PO-2025-099|INV-2025-099|75000000.00|IDR');
    this.payables.set(paySettledId, {
      id: paySettledId,
      payable_number: 'PAY-2025-099',
      po_id: 'po-000-historical',
      po_number: 'PO-2025-099',
      vendor_id: vendor3Id,
      vendor_legal_name: 'PT Sentra Logistik Prima',
      buyer_organization_id: defaultOrgId,
      amount: '75000000.00',
      amount_minor: '7500000000',
      currency: 'IDR',
      period: 'Bulan 4',
      due_date: new Date('2025-12-31T00:00:00Z'),
      status: 'SETTLED',
      document_hash: paySettledHash,
      invoice_number: 'INV-2025-099',
      invoice_date: new Date('2025-12-01T00:00:00Z'),
      goods_receipt_number: 'BAST-2025-099',
      payment_reference: 'SP2D-2025-12-0044 / TX-BANK-7729',
      blockchain_tx_id: 'tx_fabric_settled_0099',
      approvals: [
        {
          step: 'PROCUREMENT_OFFICER',
          title: 'Verifikasi Teknis Selesai',
          actor_id: 'usr-proc-001',
          actor_name: 'Budi Santoso',
          actor_role: Role.PROCUREMENT_OFFICER,
          timestamp: new Date('2025-12-05T00:00:00Z'),
        },
        {
          step: 'PPK',
          title: 'Disetujui PPK',
          actor_id: 'usr-ppk-001',
          actor_name: 'Dr. Hendra Gunawan (PPK)',
          actor_role: Role.PPK,
          timestamp: new Date('2025-12-10T00:00:00Z'),
        },
        {
          step: 'FINANCE',
          title: 'Verifikasi Pajak & Kelayakan',
          actor_id: 'usr-fin-001',
          actor_name: 'Sri Wahyuni (Finance)',
          actor_role: Role.FINANCE,
          timestamp: new Date('2025-12-12T00:00:00Z'),
        },
        {
          step: 'AUTHORIZED_OFFICER',
          title: 'Otorisasi Pencairan Dana SP2D',
          actor_id: 'usr-auth-001',
          actor_name: 'Rudi Hartono (Authorized Officer)',
          actor_role: Role.AUTHORIZED_OFFICER,
          timestamp: new Date('2025-12-15T00:00:00Z'),
        },
      ],
      created_at: new Date('2025-12-05T00:00:00Z'),
      updated_at: new Date('2025-12-20T00:00:00Z'),
    });
  }
}
