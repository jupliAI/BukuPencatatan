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

    // 6. Seed Additional Vendors for the 4-Month Procurement Cycle
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

    // 7. Seed 4-Month Procurement Cycle
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

  }
}
