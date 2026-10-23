import {
  User,
  Vendor,
  PurchaseOrder,
  ApplicationEvent,
  BlockchainTransaction,
  LedgerHistoryResponse,
  VerifyHashResponse,
  BlockchainStatusResponse,
  Payable,
  PayableSummary,
  TamperAuditResponse,
} from './types.ts';

const TOKEN_KEY = 'ap_ledger_access_token';
const REFRESH_TOKEN_KEY = 'ap_ledger_refresh_token';

export const ApiClient = {
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  setTokens(accessToken: string, refreshToken: string) {
    localStorage.setItem(TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },

  clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`/api${endpoint}`, {
      ...options,
      headers,
    });

    const json = await res.json();
    if (!res.ok || !json.success) {
      const err = new Error(json.error?.message || 'API request failed');
      (err as any).code = json.error?.code;
      (err as any).details = json.error?.details;
      (err as any).statusCode = res.status;
      throw err;
    }

    return json.data as T;
  },

  // Auth
  async login(email: string, password: string) {
    const data = await this.request<{
      access_token: string;
      refresh_token: string;
      user: User;
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.setTokens(data.access_token, data.refresh_token);
    return data.user;
  },

  async logout() {
    try {
      await this.request('/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    this.clearTokens();
  },

  async getMe(): Promise<User> {
    return this.request<User>('/auth/me');
  },

  // Vendors
  async getVendors(params: { search?: string; status?: string } = {}): Promise<{ items: Vendor[]; pagination: any }> {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.status) query.set('status', params.status);
    return this.request(`/vendors?${query.toString()}`);
  },

  // Purchase Orders
  async getPurchaseOrders(params: { status?: string; search?: string } = {}): Promise<{ items: PurchaseOrder[]; pagination: any }> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.search) query.set('search', params.search);
    return this.request(`/purchase-orders?${query.toString()}`);
  },

  async getPurchaseOrder(id: string): Promise<PurchaseOrder> {
    return this.request<PurchaseOrder>(`/purchase-orders/${id}`);
  },

  // Audit Outbox
  async getAuditEvents(): Promise<ApplicationEvent[]> {
    return this.request<ApplicationEvent[]>('/audit/events');
  },

  async getBlockchainTransactions(): Promise<BlockchainTransaction[]> {
    return this.request<BlockchainTransaction[]>('/audit/blockchain-transactions');
  },

  async triggerProcessOutbox() {
    return this.request('/audit/outbox/process', { method: 'POST' });
  },

  // Hyperledger Fabric & Blockchain Ledger Direct APIs
  async getBlockchainStatus(): Promise<BlockchainStatusResponse> {
    return this.request<BlockchainStatusResponse>('/blockchain/status');
  },

  async switchBlockchainProvider(provider: 'fabric' | 'mock'): Promise<BlockchainStatusResponse> {
    return this.request<BlockchainStatusResponse>('/blockchain/provider', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
  },

  async getLedgerHistory(entityId: string): Promise<LedgerHistoryResponse> {
    return this.request<LedgerHistoryResponse>(`/ledger/${entityId}/history`);
  },

  async verifyDocumentHash(entityId: string, documentHash: string): Promise<VerifyHashResponse> {
    const query = new URLSearchParams({ document_hash: documentHash });
    return this.request<VerifyHashResponse>(`/ledger/${entityId}/verify?${query.toString()}`);
  },

  // Accounts Payable Ledger & Procurement Lifecycle
  async getPayables(params: {
    period?: string;
    status?: string;
    vendor_id?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}): Promise<{ items: Payable[]; total: number; page: number; limit: number; total_pages: number }> {
    const query = new URLSearchParams();
    if (params.period) query.set('period', params.period);
    if (params.status) query.set('status', params.status);
    if (params.vendor_id) query.set('vendor_id', params.vendor_id);
    if (params.search) query.set('search', params.search);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    return this.request(`/payables?${query.toString()}`);
  },

  async getPayablesSummary(): Promise<PayableSummary> {
    return this.request<PayableSummary>('/payables/summary');
  },

  async getPayable(id: string): Promise<Payable> {
    return this.request<Payable>(`/payables/${id}`);
  },

  // Tamper-Evident Lab & Audit Integrity
  async auditPayableIntegrity(id: string): Promise<TamperAuditResponse> {
    return this.request<TamperAuditResponse>(`/payables/${id}/audit-integrity`);
  },

  async tamperPayableSimulate(id: string, tampered_amount: string): Promise<Payable> {
    return this.request<Payable>(`/payables/${id}/tamper-simulate`, {
      method: 'POST',
      body: JSON.stringify({ tampered_amount }),
    });
  },

  async restorePayable(id: string): Promise<Payable> {
    return this.request<Payable>(`/payables/${id}/tamper-restore`, {
      method: 'POST',
    });
  },
};
