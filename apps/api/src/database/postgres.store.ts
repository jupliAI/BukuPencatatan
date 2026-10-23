/**
 * Persistence adapter untuk Neon Postgres (serverless Postgres, dipakai oleh Vercel).
 *
 * Kenapa adapter terpisah & tidak langsung mengganti seluruh service?
 * - Seluruh business service (vendors, purchase-orders, dst) masih memakai
 *   Map in-memory secara sinkron.
 * - Adapter ini menjadi jembatan: Map tetap sinkron, tetapi setiap mutasi ditulis ke
 *   Postgres sebagai operasi async (write-through) yang di-flush sebelum response dikirim.
 *
 * Skema tabel di bawah didefinisikan mengikuti interface `Db*` pada `db.service.ts`
 * sehingga mapping kolom ↔ field TypeScript bersifat 1:1 (tanpa layer translasi tambahan).
 *
 * Driver: `@neondatabase/serverless` (HTTP-based, cocok untuk serverless/edge).
 * Bila paket belum terpasang atau koneksi gagal, adapter ini non-aktif dan aplikasi
 * otomatis kembali ke mode in-memory (tidak crash).
 */

import { PersistentMap } from './persistent-map.ts';

type ColumnKind = 'text' | 'decimal' | 'int' | 'boolean' | 'json' | 'timestamp';

interface ColumnDef {
  name: string;
  type: string;
  kind: ColumnKind;
}

interface TableDef {
  name: string;
  columns: ColumnDef[];
}

const text = (name: string): ColumnDef => ({ name, type: 'TEXT', kind: 'text' });
const dec = (name: string, precision = '20,2'): ColumnDef => ({
  name,
  type: `NUMERIC(${precision})`,
  kind: 'decimal',
});
const int = (name: string): ColumnDef => ({ name, type: 'INTEGER', kind: 'int' });
const json = (name: string): ColumnDef => ({ name, type: 'JSONB', kind: 'json' });
const ts = (name: string): ColumnDef => ({ name, type: 'TIMESTAMPTZ', kind: 'timestamp' });

/**
 * Definisi tabel persistence. Nama tabel SAMA PERSIS dengan nama properti di DatabaseService,
 * sehingga `store.createMap('purchase_orders')` langsung terhubung ke `db.purchase_orders`.
 */
export const TABLES: TableDef[] = [
  {
    name: 'organizations',
    columns: [text('id'), text('name'), text('code'), text('address'), text('contact_email'), text('status'), ts('created_at'), ts('updated_at')],
  },
  {
    name: 'users',
    columns: [text('id'), text('name'), text('email'), text('password_hash'), text('role'), text('organization_id'), text('status'), text('refresh_token_hash'), ts('created_at'), ts('updated_at')],
  },
  {
    name: 'vendors',
    columns: [text('id'), text('vendor_code'), text('legal_name'), text('tax_id'), text('address'), text('contact_email'), text('organization_id'), text('status'), ts('created_at'), ts('updated_at')],
  },
  {
    name: 'purchase_orders',
    columns: [text('id'), text('po_number'), text('vendor_id'), text('buyer_organization_id'), text('description'), dec('total_amount'), text('currency'), ts('issue_date'), ts('due_date'), text('status'), text('blockchain_status'), text('document_hash'), text('created_by'), ts('created_at'), ts('updated_at')],
  },
  {
    name: 'purchase_order_items',
    columns: [text('id'), text('po_id'), text('description'), dec('quantity', '20,4'), dec('unit_price'), dec('total_price'), ts('created_at')],
  },
  {
    name: 'documents',
    columns: [text('id'), text('entity_id'), text('entity_type'), text('filename'), text('original_filename'), text('mime_type'), text('file_path'), text('sha256_hash'), text('uploaded_by'), ts('uploaded_at')],
  },
  {
    name: 'application_events',
    columns: [text('id'), text('event_type'), text('entity_id'), text('entity_type'), text('actor_id'), text('organization_id'), json('payload'), text('status'), int('attempt_count'), text('last_error'), ts('created_at'), ts('processed_at')],
  },
  {
    name: 'blockchain_transactions',
    columns: [text('id'), text('application_event_id'), text('transaction_id'), text('event_type'), text('entity_id'), text('entity_type'), text('status'), text('error_message'), ts('submitted_at'), ts('confirmed_at')],
  },
];

interface NeonQueryFn {
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}

export class PostgresStore {
  private readonly connectionString: string;
  private sql: NeonQueryFn | null = null;
  private schemaReady = false;

  /** Operasi tulis yang belum selesai — di-flush sebelum response dikirim. */
  private readonly pending = new Set<Promise<void>>();

  private constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  /**
   * Membuat store bila `DATABASE_URL` tersedia dan berbentuk connection string Postgres.
   * Mengembalikan `null` → aplikasi berjalan mode in-memory (perilaku lama).
   */
  public static fromEnv(): PostgresStore | null {
    const url = (process.env.DATABASE_URL || '').trim();
    if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
      return null;
    }
    return new PostgresStore(url);
  }

  /** Koneksi (lazy) ke Neon. Melempar error bila paket driver tidak terpasang. */
  private async getSql(): Promise<NeonQueryFn> {
    if (this.sql) return this.sql;
    const mod = (await import('@neondatabase/serverless')) as unknown as {
      neon: (connectionString: string) => NeonQueryFn;
    };
    this.sql = mod.neon(this.connectionString);
    return this.sql;
  }

  private table(name: string): TableDef {
    const found = TABLES.find((t) => t.name === name);
    if (!found) throw new Error(`PostgresStore: unknown table '${name}'`);
    return found;
  }

  /** Menjalankan DDL `CREATE TABLE IF NOT EXISTS` untuk seluruh tabel (idempoten). */
  public async bootstrapSchema(): Promise<void> {
    if (this.schemaReady) return;
    const sql = await this.getSql();
    for (const t of TABLES) {
      const columns = t.columns.map((c) => `  ${c.name} ${c.type}`).join(',\n');
      await sql.query(`CREATE TABLE IF NOT EXISTS ${t.name} (\n${columns},\n  PRIMARY KEY (id)\n)`);
    }
    this.schemaReady = true;
  }

  /** Membaca seluruh baris dari seluruh tabel untuk hydrate Map saat cold start. */
  public async loadAll(): Promise<Map<string, Record<string, unknown>[]>> {
    const sql = await this.getSql();
    const result = new Map<string, Record<string, unknown>[]>();
    for (const t of TABLES) {
      const rows = await sql.query(`SELECT * FROM ${t.name}`);
      result.set(t.name, rows.map((row) => this.fromRow(t, row)));
    }
    return result;
  }

  /** Membuat Map yang otomatis menulis setiap mutasi ke tabel terkait. */
  public createMap<V extends { id: string }>(tableName: string): PersistentMap<V> {
    const table = this.table(tableName);
    return new PersistentMap<V>({
      onSet: (_key, value) => this.enqueue(this.upsertRow(table, value as Record<string, unknown>)),
      onDelete: (_key) => this.enqueue(this.deleteRow(table, _key)),
      onClear: () => this.enqueue(this.clearTable(table)),
    });
  }

  /** Menunggu seluruh penulisan yang masih berjalan selesai. */
  public async flush(): Promise<void> {
    let rounds = 0;
    while (this.pending.size > 0 && rounds < 10) {
      rounds++;
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  public get isEnabled(): boolean {
    return this.sql !== null || this.pending.size > 0;
  }

  private enqueue(operation: Promise<void>): void {
    const tracked = operation.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[PostgresStore] write failed: ${message}`);
    });
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  private async upsertRow(t: TableDef, entity: Record<string, unknown>): Promise<void> {
    const sql = await this.getSql();
    const names = t.columns.map((c) => c.name);
    const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
    const updates = names
      .filter((n) => n !== 'id')
      .map((n) => `${n} = EXCLUDED.${n}`)
      .join(', ');
    const values = t.columns.map((c) => this.toParam(c, entity[c.name]));

    await sql.query(
      `INSERT INTO ${t.name} (${names.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updates}`,
      values,
    );
  }

  private async deleteRow(t: TableDef, id: string): Promise<void> {
    const sql = await this.getSql();
    await sql.query(`DELETE FROM ${t.name} WHERE id = $1`, [id]);
  }

  private async clearTable(t: TableDef): Promise<void> {
    const sql = await this.getSql();
    await sql.query(`DELETE FROM ${t.name}`);
  }

  private toParam(column: ColumnDef, value: unknown): unknown {
    if (value === undefined || value === null) return null;
    switch (column.kind) {
      case 'boolean':
        return Boolean(value);
      case 'int':
        return Number(value);
      case 'json':
        return JSON.stringify(value);
      case 'timestamp':
        return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
      case 'decimal':
      case 'text':
      default:
        return String(value);
    }
  }

  private fromRow(t: TableDef, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const column of t.columns) {
      const raw = row[column.name];
      if (raw === null || raw === undefined) {
        out[column.name] = null;
        continue;
      }
      switch (column.kind) {
        case 'json':
          out[column.name] = typeof raw === 'string' ? JSON.parse(raw) : raw;
          break;
        case 'timestamp':
          out[column.name] = raw instanceof Date ? raw : new Date(String(raw));
          break;
        case 'decimal':
          // Driver mengembalikan NUMERIC sebagai string — cocok dengan tipe `string` di interface Db*.
          out[column.name] = String(raw);
          break;
        case 'int':
          out[column.name] = Number(raw);
          break;
        case 'boolean':
          out[column.name] = Boolean(raw);
          break;
        default:
          out[column.name] = String(raw);
      }
    }
    return out;
  }
}
