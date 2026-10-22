/**
 * Map subclass yang mem-forward setiap mutasi ke persistence adapter (Neon Postgres).
 *
 * Tujuan desain: seluruh service (`vendors.service.ts`, `po.service.ts`, dst) memakai
 * `this.db.purchase_orders.set(...)` secara SINKRON. Agar tidak perlu refactor besar
 * di 7 service, Map ini mempertahankan API sinkron yang sama, sementara penulisan ke
 * database dikirim sebagai operasi async (write-through) yang di-flush sebelum response.
 */

export interface PersistentMapHooks {
  onSet: (key: string, value: unknown) => void;
  onDelete: (key: string) => void;
  onClear: () => void;
}

export class PersistentMap<V> extends Map<string, V> {
  private readonly hooks: PersistentMapHooks;

  constructor(hooks: PersistentMapHooks) {
    super();
    this.hooks = hooks;
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    this.hooks.onSet(key, value);
    return this;
  }

  override delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) {
      this.hooks.onDelete(key);
    }
    return existed;
  }

  override clear(): void {
    super.clear();
    this.hooks.onClear();
  }

  /**
   * Mengisi Map dari hasil query database TANPA memicu write-back,
   * supaya proses hydrate saat cold start tidak menulis ulang data yang baru dibaca.
   */
  hydrate(entries: Iterable<readonly [string, V]>): void {
    for (const [key, value] of entries) {
      super.set(key, value);
    }
  }
}
