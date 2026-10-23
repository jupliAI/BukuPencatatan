import { WebhookCrypto } from './crypto-utils.ts';

/**
 * Client wrapper for the Switching integration hub partner API. Matches the contract
 * implemented in switching-main backend (ApiKeyAuthGuard + TransactionsController +
 * Idempotency-Key dedupe).
 *
 * Authentication (matches switching-main/.../api-key-auth.guard.ts):
 *   1) X-Api-Key    — lookup ApiCredential record in Switching
 *   2) X-Api-Secret — verified against the bcrypt hash (credential.apiSecretHash)
 *   3) Idempotency-Key — dedupe partnerId + idempotencyKey (unique DB constraint)
 *   4) [optional] X-Switching-Signature / X-Gateway-Signature — layer-3 HMAC
 *      signing if both sides agree and SHARED_SECRET is configured.
 */

export interface SwitchingTransactionRequest {
  businessTransactionId: string;
  transactionType: string;
  payload: Record<string, unknown>;
}

export interface SwitchingCreatedTransaction {
  id: string;
  switchingTransactionId: string;
  businessTransactionId: string;
  partnerId: string;
  transactionType: string;
  correlationId: string;
  idempotencyKey: string;
  status:
    | 'RECEIVED'
    | 'VALIDATING'
    | 'ROUTING'
    | 'PROCESSING'
    | 'PENDING'
    | 'CONFIRMED'
    | 'FAILED'
    | 'SETTLED';
  payload: Record<string, unknown>;
  transformedPayload?: Record<string, unknown>;
  routingRuleId?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  blockchainTxHash?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SwitchingSubmitResult<T = SwitchingCreatedTransaction> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface CallSwitchingOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Optional — additional layer of per-request HMAC signing. Leave empty to disable */
  sharedSecret?: string;
  timeoutMs?: number;
  headerConvention?: 'gateway-prefixed' | 'switching-prefixed';
  idempotencyKey: string;
}

interface RawFetchResult<TResp> {
  ok: boolean;
  status: number;
  parsed?: TResp;
  error?: { code: string; message: string; details?: unknown };
}

async function requestSwitchingRaw<TResp = unknown>(opts: {
  method: 'POST' | 'GET' | 'PATCH';
  path: string;
  req?: unknown;
  call: CallSwitchingOptions;
}): Promise<RawFetchResult<TResp>> {
  const {
    baseUrl,
    apiKey,
    apiSecret,
    sharedSecret = '',
    timeoutMs,
    headerConvention = 'switching-prefixed',
    idempotencyKey,
  } = opts.call;

  const effectiveTimeout = timeoutMs ?? (Number(process.env.GATEWAY_TIMEOUT_MS) || 10000);

  if (!apiKey) throw new Error('callSwitching: apiKey is required');
  if (!apiSecret) throw new Error('callSwitching: apiSecret is required');
  if (!idempotencyKey) throw new Error('callSwitching: idempotencyKey is required');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  let rawBody = '';
  if (opts.req !== undefined && opts.method !== 'GET') {
    rawBody = JSON.stringify(opts.req);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Api-Secret': apiSecret,
    'Idempotency-Key': idempotencyKey,
  };

  if (sharedSecret && rawBody.length > 0) {
    const { signature, timestamp } = WebhookCrypto.signOutgoingRequest(sharedSecret, rawBody);
    const sigHdr =
      headerConvention === 'gateway-prefixed' ? 'x-gateway-signature' : 'x-switching-signature';
    const tsHdr =
      headerConvention === 'gateway-prefixed' ? 'x-gateway-timestamp' : 'x-switching-timestamp';
    headers[sigHdr] = signature;
    headers[tsHdr] = timestamp;
  }

  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.method !== 'GET' && rawBody.length > 0 ? rawBody : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const text = await resp.text();
    let parsed: TResp | undefined;
    try {
      parsed = text ? (JSON.parse(text) as TResp) : undefined;
    } catch {
      parsed = undefined;
    }

    const ok = resp.status >= 200 && resp.status < 300;
    const asRec = parsed as unknown as Record<string, unknown> | undefined;
    const errObj =
      asRec && typeof asRec.error === 'object'
        ? (asRec.error as Record<string, unknown>)
        : undefined;
    const dataObj = asRec?.data as unknown as TResp | undefined;

    if (ok) {
      return { ok: true, status: resp.status, parsed: dataObj ?? parsed };
    }
    return {
      ok: false,
      status: resp.status,
      error: {
        code: (errObj?.code as string) || `SWITCHING_HTTP_${resp.status}`,
        message: (errObj?.message as string) || `Switching returned HTTP ${resp.status}`,
        details: errObj?.details ?? parsed,
      },
    };
  } catch (rawErr: unknown) {
    clearTimeout(timeoutId);
    const msg = rawErr instanceof Error ? rawErr.message : String(rawErr);
    const isAbort =
      (rawErr instanceof Error && rawErr.name === 'AbortError') || /abort|timeout/i.test(msg);
    return {
      ok: false,
      status: 0,
      error: {
        code: isAbort ? 'SWITCHING_TIMEOUT' : 'SWITCHING_NETWORK_ERROR',
        message: isAbort
          ? `Switching call timed out after ${effectiveTimeout}ms (${opts.method} ${opts.path})`
          : `Failed to reach Switching at ${baseUrl}: ${msg}`,
        details: { path: opts.path, method: opts.method },
      },
    };
  }
}

export async function createSwitchingTransaction(
  transaction: SwitchingTransactionRequest,
  opts: CallSwitchingOptions,
): Promise<SwitchingSubmitResult<SwitchingCreatedTransaction>> {
  const result = await requestSwitchingRaw<SwitchingCreatedTransaction>({
    method: 'POST',
    path: '/api/v1/partner/transactions',
    req: transaction,
    call: opts,
  });
  if (result.ok) {
    return { ok: true, status: result.status, data: result.parsed };
  }
  return { ok: false, status: result.status, error: result.error };
}

export async function getSwitchingTransactionStatus(
  switchingTransactionId: string,
  opts: CallSwitchingOptions,
): Promise<
  SwitchingSubmitResult<{
    switchingTransactionId: string;
    status: string;
    blockchainTxHash: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: string;
  }>
> {
  const result = await requestSwitchingRaw({
    method: 'GET',
    path: `/api/v1/partner/transactions/${encodeURIComponent(switchingTransactionId)}/status`,
    call: {
      ...opts,
      idempotencyKey: opts.idempotencyKey ?? `status-${switchingTransactionId}-${Date.now()}`,
    },
  });
  if (result.ok) {
    return { ok: true, status: result.status, data: result.parsed };
  }
  return { ok: false, status: result.status, error: result.error };
}
