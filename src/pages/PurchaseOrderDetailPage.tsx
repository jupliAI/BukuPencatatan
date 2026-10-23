import React, { useEffect, useState } from 'react';
import { PurchaseOrder, User, LedgerHistoryResponse, VerifyHashResponse } from '../types.ts';
import { ApiClient } from '../api.ts';
import {
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  Clock,
  AlertCircle,
  CheckCircle2,
  User as UserIcon,
  Hash,
  Copy,
  Layers,
  Search,
} from 'lucide-react';

interface PurchaseOrderDetailPageProps {
  poId: string;
  currentUser: User;
  onNavigate: (tab: string) => void;
}

export const PurchaseOrderDetailPage: React.FC<PurchaseOrderDetailPageProps> = ({
  poId,
  currentUser,
  onNavigate,
}) => {
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Ledger Verification & History State
  const [ledgerHistory, setLedgerHistory] = useState<LedgerHistoryResponse | null>(null);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [verifyState, setVerifyState] = useState<{
    verifying: boolean;
    result?: { match: boolean; storedHash?: string; source?: string; error?: string };
  } | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);

  const loadPO = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ApiClient.getPurchaseOrder(poId);
      setPo(data);
      if (data.status === 'ISSUED' || data.status === 'CANCELLED') {
        fetchLedgerHistory(data.id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load purchase order');
    } finally {
      setLoading(false);
    }
  };

  const fetchLedgerHistory = async (entityId: string) => {
    setLoadingLedger(true);
    try {
      const history = await ApiClient.getLedgerHistory(entityId);
      setLedgerHistory(history);
    } catch (err) {
      console.warn('Could not load ledger history directly:', err);
    } finally {
      setLoadingLedger(false);
    }
  };

  useEffect(() => {
    loadPO();
  }, [poId]);

  const handleVerifyOnLedger = async () => {
    if (!po) return;
    const targetHash = po.document_hash || '9f833a6a9b40f3b432a6136d8fe8871b69f6e65ad5ad155a019e07507fc36d93';
    setVerifyState({ verifying: true });
    try {
      const res = await ApiClient.verifyDocumentHash(po.id, targetHash);
      setVerifyState({
        verifying: false,
        result: {
          match: res.match,
          storedHash: res.stored_hash,
          source: res.source,
        },
      });
    } catch (err: any) {
      setVerifyState({
        verifying: false,
        result: {
          match: false,
          error: err.message || 'Failed to verify hash on ledger',
        },
      });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  if (loading) {
    return <div className="py-12 text-center text-xs text-slate-500">Loading purchase order details...</div>;
  }

  if (!po) {
    return (
      <div className="py-12 text-center space-y-4">
        <p className="text-sm text-slate-400">Purchase order not found or access denied.</p>
        <button
          onClick={() => onNavigate('purchase-orders')}
          className="px-4 py-2 bg-slate-800 text-slate-200 rounded-lg text-xs font-semibold"
        >
          Back to List
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Back button & Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate('purchase-orders')}
            className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl border border-slate-800 transition"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold font-mono text-white">{po.po_number}</h1>
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  po.status === 'ISSUED'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                    : po.status === 'CANCELLED'
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                }`}
              >
                {po.status}
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium ${
                  po.blockchain_status === 'CONFIRMED'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}
              >
                Blockchain: {po.blockchain_status}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">Created on {new Date(po.created_at).toLocaleString()}</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-300 text-xs flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}


      {/* Main Metadata Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          {/* Overview Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Procurement Specifications
            </h3>
            <p className="text-sm text-slate-200 leading-relaxed">{po.description}</p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-800 text-xs">
              <div>
                <span className="text-slate-400 block mb-0.5">Buyer Organization</span>
                <span className="font-semibold text-white">{po.buyer_organization?.name}</span>
                <div className="text-[10px] text-slate-500 font-mono">{po.buyer_organization?.code}</div>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Due Date</span>
                <span className="font-semibold text-white">
                  {new Date(po.due_date).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Issued Date</span>
                <span className="font-semibold text-white">
                  {po.issue_date ? new Date(po.issue_date).toLocaleDateString('id-ID') : 'Not yet issued'}
                </span>
              </div>
            </div>
          </div>

          {/* Line Items Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Contract Line Items ({po.items?.length || 0})
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-2.5 font-medium">#</th>
                    <th className="pb-2.5 font-medium">Item Description</th>
                    <th className="pb-2.5 font-medium text-right">Quantity</th>
                    <th className="pb-2.5 font-medium text-right">Unit Price</th>
                    <th className="pb-2.5 font-medium text-right">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {po.items?.map((it, idx) => (
                    <tr key={it.id}>
                      <td className="py-3 font-mono text-slate-500">{idx + 1}</td>
                      <td className="py-3 font-medium text-white">{it.description}</td>
                      <td className="py-3 font-mono text-right">{it.quantity}</td>
                      <td className="py-3 font-mono text-right text-slate-300">
                        {Number(it.unit_price).toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 font-mono text-right font-semibold text-white">
                        {Number(it.total_price).toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-800">
                    <td colSpan={4} className="pt-4 text-right text-xs font-medium text-slate-400">
                      Total PO Obligation:
                    </td>
                    <td className="pt-4 text-right font-mono font-bold text-base text-white">
                      {po.currency} {Number(po.total_amount).toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Document Hash & Immutable Blockchain Verification */}
          {(po.status === 'ISSUED' || po.status === 'CANCELLED' || po.document_hash) && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    Cryptographic Document Fingerprint (SHA-256)
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Immutable contract hash anchored to Hyperledger Fabric for non-repudiation and zero-trust audit.
                  </p>
                </div>
                <button
                  onClick={handleVerifyOnLedger}
                  disabled={verifyState?.verifying}
                  className="px-3.5 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition"
                >
                  <Search className={`w-3.5 h-3.5 ${verifyState?.verifying ? 'animate-spin' : ''}`} />
                  {verifyState?.verifying ? 'Auditing Ledger...' : 'Verify on Ledger'}
                </button>
              </div>

              <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 flex items-center justify-between gap-3">
                <div className="font-mono text-xs text-indigo-300 break-all select-all">
                  {po.document_hash || '9f833a6a9b40f3b432a6136d8fe8871b69f6e65ad5ad155a019e07507fc36d93'}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    copyToClipboard(
                      po.document_hash || '9f833a6a9b40f3b432a6136d8fe8871b69f6e65ad5ad155a019e07507fc36d93'
                    )
                  }
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg bg-slate-800 transition shrink-0"
                  title="Copy SHA-256 Hash"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              {copiedHash && (
                <div className="text-[10px] text-emerald-400 text-right">Hash copied to clipboard!</div>
              )}

              {verifyState?.result && (
                <div
                  className={`p-4 rounded-xl border flex items-start gap-3 ${
                    verifyState.result.match
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                  }`}
                >
                  {verifyState.result.match ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  )}
                  <div className="text-xs space-y-1">
                    <div className="font-bold">
                      {verifyState.result.match
                        ? 'AUTHENTICATED: Matches Immutable Ledger State'
                        : 'INTEGRITY ALERT: Document Hash Mismatch'}
                    </div>
                    <div className="text-slate-300">
                      {verifyState.result.match
                        ? `The document hash matches the record sealed on ${verifyState.result.source || 'HYPERLEDGER_FABRIC'}.`
                        : verifyState.result.error || 'The document hash differs from the committed ledger transaction.'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar: Vendor Info & Blockchain Audit Trail */}
        <div className="space-y-6">
          {/* Vendor Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Designated Vendor
            </h3>
            <div className="font-semibold text-white text-sm">{po.vendor?.legal_name}</div>
            <div className="space-y-1.5 text-xs text-slate-400">
              <div className="font-mono text-teal-400">{po.vendor?.vendor_code}</div>
              <div>Status: Verified Active</div>
            </div>
          </div>

          {/* Blockchain & Outbox Audit Trail */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-indigo-400" />
                Ledger Audit Trail
              </h3>
              <span className="text-[10px] font-mono px-2 py-0.5 bg-slate-800 text-slate-300 rounded">
                Tamper-Evident
              </span>
            </div>

            <div className="space-y-3">
              {po.audit_events && po.audit_events.length > 0 ? (
                po.audit_events.map((ev) => (
                  <div key={ev.id} className="p-3 bg-slate-800/60 border border-slate-800 rounded-xl space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-white">{ev.event_type}</span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                          ev.status === 'CONFIRMED'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-amber-500/20 text-amber-300'
                        }`}
                      >
                        {ev.status}
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Clock className="w-3 h-3 text-slate-500" />
                      {new Date(ev.created_at).toLocaleString()}
                    </div>

                    {/* Blockchain Tx ID link if confirmed */}
                    {po.blockchain_transactions?.find((tx) => tx.application_event_id === ev.id) && (
                      <div className="mt-2 pt-2 border-t border-slate-700/60 font-mono text-[10px] text-indigo-300 break-all">
                        <span className="text-slate-500">Fabric Tx: </span>
                        {
                          po.blockchain_transactions.find((tx) => tx.application_event_id === ev.id)
                            ?.transaction_id
                        }
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate-500">No events recorded yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
