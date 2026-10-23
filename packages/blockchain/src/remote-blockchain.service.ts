/**
 * Implementasi `BlockchainService` yang meneruskan setiap operasi ke **Fabric Bridge
 * Service** — sebuah proses Node.js terpisah yang memegang koneksi gRPC persisten ke
 * peer Hyperledger Fabric.
 *
 * Kenapa harus dipisah?
 * - Fabric Gateway SDK butuh (1) akses filesystem untuk certificate/private key,
 *   (2) koneksi gRPC persisten, dan (3) proses yang hidup terus.
 * - Runtime serverless (Vercel/Cloudflare Workers) tidak menyediakan ketiganya.
 *
 * Dengan pola ini, aplikasi yang berjalan di serverless tetap bisa menulis ke ledger
 * Fabric hanya dengan memanggil HTTP ke bridge yang di-host di VPS/Docker.
 *
 * Konfigurasi:
 * - FABRIC_BRIDGE_URL        : base URL bridge, mis. https://fabric-bridge.example.com
 * - FABRIC_BRIDGE_TOKEN      : bearer token untuk autentikasi ke bridge
 * - FABRIC_BRIDGE_TIMEOUT_MS : timeout per request (default 15000)
 */

import {
  BlockchainService,
  BlockchainResult,
  LedgerEvent,
  VerifyHashResult,
  BlockchainHealth,
} from './types.ts';

export interface RemoteBlockchainConfig {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export class RemoteBlockchainService implements BlockchainService {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(config?: Partial<RemoteBlockchainConfig>) {
    const baseUrl = config?.baseUrl || process.env.FABRIC_BRIDGE_URL || '';
    if (!baseUrl) {
      throw new Error('RemoteBlockchainService: FABRIC_BRIDGE_URL belum dikonfigurasi');
    }
    // Trailing slash dibuang agar penggabungan path selalu konsisten.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = config?.token ?? process.env.FABRIC_BRIDGE_TOKEN;
    this.timeoutMs = config?.timeoutMs ?? (Number(process.env.FABRIC_BRIDGE_TIMEOUT_MS) || 15000);
  }

  public getProviderName(): string {
    return 'HYPERLEDGER_FABRIC_REMOTE';
  }

  async recordEvent(event: LedgerEvent): Promise<BlockchainResult> {
    try {
      const result = await this.request<{ transactionId: string; duplicate?: boolean }>(
        'POST',
        '/v1/events',
        event,
      );
      return {
        success: true,
        transactionId: result.transactionId,
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      return {
        success: false,
        transactionId: '',
        timestamp: new Date().toISOString(),
        errorMessage: this.describe(err),
      };
    }
  }

  async verifyTransaction(transactionId: string): Promise<boolean> {
    try {
      const result = await this.request<{ exists: boolean }>(
        'GET',
        `/v1/events/${encodeURIComponent(transactionId)}/exists`,
      );
      return result.exists === true;
    } catch {
      return false;
    }
  }

  async getTransactionHistory(
    entityId: string,
    entityType: string = 'PURCHASE_ORDER',
  ): Promise<LedgerEvent[]> {
    try {
      const result = await this.request<{ events: LedgerEvent[] }>(
        'GET',
        `/v1/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/history`,
      );
      return result.events ?? [];
    } catch (err: unknown) {
      console.error(`[RemoteBlockchainService] getTransactionHistory gagal: ${this.describe(err)}`);
      return [];
    }
  }

  async verifyDocumentHash(entityId: string, documentHash: string): Promise<VerifyHashResult> {
    try {
      const result = await this.request<VerifyHashResult>('POST', '/v1/verify-document-hash', {
        entityId,
        documentHash,
      });
      return {
        match: result.match === true,
        storedHash: result.storedHash,
        matchingEvents: result.matchingEvents ?? [],
      };
    } catch {
      return { match: false, matchingEvents: [] };
    }
  }

  async isHealthy(): Promise<BlockchainHealth> {
    try {
      return await this.request<BlockchainHealth>('GET', '/v1/health');
    } catch (err: unknown) {
      return {
        provider: 'fabric-remote',
        status: 'disconnected',
        error: this.describe(err),
      };
    }
  }

  /**
   * HTTP helper dengan timeout eksplisit. `AbortController` wajib dipakai karena
   * runtime serverless akan menghentikan function sebelum timeout default TCP tercapai.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Bridge mengembalikan respons bukan-JSON (HTTP ${response.status})`);
      }

      if (!response.ok) {
        const message =
          typeof payload === 'object' && payload !== null && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }

      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private describe(err: unknown): string {
    if (err instanceof Error) {
      return err.name === 'AbortError' ? `Timeout setelah ${this.timeoutMs}ms` : err.message;
    }
    return String(err);
  }
}
