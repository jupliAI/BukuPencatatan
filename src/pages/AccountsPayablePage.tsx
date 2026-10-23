import React, { useState, useEffect } from 'react';
import {
  Payable,
  PayableSummary,
  User,
  TamperAuditResponse,
} from '../types.ts';
import { ApiClient } from '../api.ts';
import {
  BookOpen,
  DollarSign,
  ShieldCheck,
  Calendar,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ArrowRight,
  RefreshCw,
  Search,
  Filter,
  Eye,
  CheckSquare,
  CreditCard,
  Building2,
  ShieldAlert,
  Hash,
  ExternalLink,
  ChevronRight,
  Layers,
  Sparkles,
} from 'lucide-react';

interface AccountsPayablePageProps {
  currentUser: User | null;
  onNavigateToLedger: (entityId?: string) => void;
  onNavigateToTamperLab: (payableId?: string) => void;
}

export const AccountsPayablePage: React.FC<AccountsPayablePageProps> = ({
  currentUser,
  onNavigateToLedger,
  onNavigateToTamperLab,
}) => {
  const [payables, setPayables] = useState<Payable[]>([]);
  const [summary, setSummary] = useState<PayableSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [periodFilter, setPeriodFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals state
  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [auditResult, setAuditResult] = useState<TamperAuditResponse | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchPayables = async () => {
    try {
      setRefreshing(true);
      const [listRes, summaryRes] = await Promise.all([
        ApiClient.getPayables({
          period: periodFilter !== 'ALL' ? periodFilter : undefined,
          status: statusFilter !== 'ALL' ? statusFilter : undefined,
          search: searchQuery || undefined,
        }),
        ApiClient.getPayablesSummary(),
      ]);
      setPayables(listRes.items);
      setSummary(summaryRes);
    } catch (err: any) {
      console.error('Failed to load payables data', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchPayables();
  }, [periodFilter, statusFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchPayables();
  };

  const showFeedback = (type: 'success' | 'error', text: string) => {
    setFeedbackMessage({ type, text });
    setTimeout(() => setFeedbackMessage(null), 5000);
  };

  // Action: Audit Integrity
  const handleAudit = async (payable: Payable) => {
    try {
      const res = await ApiClient.auditPayableIntegrity(payable.id);
      setAuditResult(res);
      setIsAuditOpen(true);
    } catch (err: any) {
      showFeedback('error', err.message || 'Gagal mengaudit integritas');
    }
  };

  const formatRupiah = (val: string | number) => {
    const num = Number(val);
    if (isNaN(num)) return 'Rp 0';
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(num);
  };

  const getStatusBadge = (status: string, isTampered?: boolean) => {
    if (isTampered) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-300 animate-pulse">
          <AlertTriangle className="w-3 h-3 text-rose-600" />
          TAMPER DETECTED
        </span>
      );
    }
    switch (status) {
      case 'PAYABLE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
            <Clock className="w-3 h-3 text-amber-600" />
            PAYABLE (Utang)
          </span>
        );
      case 'APPROVED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
            <CheckSquare className="w-3 h-3 text-blue-600" />
            APPROVED
          </span>
        );
      case 'PAYMENT_INITIATED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200">
            <CreditCard className="w-3 h-3 text-indigo-600" />
            SP2D INITIATED
          </span>
        );
      case 'SETTLED':
      case 'PAID':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            SETTLED (Lunas)
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-800">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Page Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 rounded-2xl p-6 sm:p-8 text-white shadow-xl relative overflow-hidden border border-slate-700">
        <div className="absolute top-0 right-0 -mr-16 -mt-16 w-80 h-80 rounded-full bg-blue-500/10 blur-3xl pointer-events-none"></div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              <BookOpen className="w-3.5 h-3.5" />
              Decentralized Procurement Ledger
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Buku Besar Utang & Pengadaan (Accounts Payable)
            </h1>
            <p className="text-slate-300 text-sm max-w-2xl leading-relaxed">
              Sistem buku besar digital berbasis blockchain Hyperledger Fabric yang mencatat perjalanan kewajiban pembayaran dari pengadaan barang/jasa, verifikasi Berita Acara, persetujuan bertingkat, hingga pelunasan permanen yang tahan manipulasi.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => onNavigateToTamperLab()}
              className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold text-sm flex items-center gap-2 shadow-lg shadow-amber-500/20 transition-all cursor-pointer"
            >
              <ShieldAlert className="w-4 h-4 text-slate-950" />
              Tamper-Evident Lab
            </button>
            <button
              onClick={() => onNavigateToLedger()}
              className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm flex items-center gap-2 shadow-md transition-all cursor-pointer"
            >
              <ExternalLink className="w-4 h-4" />
              Ledger Explorer
            </button>
            <button
              onClick={fetchPayables}
              disabled={refreshing}
              className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition cursor-pointer"
              title="Refresh Data"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Feedback Toast */}
      {feedbackMessage && (
        <div
          className={`p-4 rounded-xl border flex items-center gap-3 transition-all ${
            feedbackMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          {feedbackMessage.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
          )}
          <span className="text-sm font-medium">{feedbackMessage.text}</span>
        </div>
      )}

      {/* KPI Cards: The Big Picture */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Active Payables */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Total Utang Aktif</span>
            <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-700">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-slate-900">
            {formatRupiah(summary?.total_active_payable || 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1 flex items-center gap-1">
            <span className="font-semibold text-amber-600">{summary?.total_active_count || 0}</span> kewajiban menunggu penyelesaian
          </div>
        </div>

        {/* Total Settled */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Total Dilunasi (Settled)</span>
            <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-700">
              <CheckCircle2 className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-slate-900">
            {formatRupiah(summary?.total_settled_amount || 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1 flex items-center gap-1">
            <span className="font-semibold text-emerald-600">{summary?.total_settled_count || 0}</span> transaksi lunas di blockchain
          </div>
        </div>

        {/* Total All Obligations */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Akumulasi Total Kewajiban</span>
            <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-700">
              <Layers className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-slate-900">
            {formatRupiah(summary?.total_obligations_all || 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1">Audit trail permanen Hyperledger</div>
        </div>

        {/* Next Due Date */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Jatuh Tempo Periode</span>
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700">
              <Calendar className="w-4 h-4" />
            </div>
          </div>
          <div className="text-xl font-bold text-slate-900">30 April 2026</div>
          <div className="text-xs text-slate-500 mt-1">Siklus Pembayaran 4 Bulan</div>
        </div>
      </div>

      {/* 4-Month Cycle Visualizer (Architecture Point 3) */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-900">
                Siklus Pembayaran & Akumulasi Kewajiban 4 Bulan
              </h2>
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                Januari → April
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Setiap kewajiban yang timbul dicatat secara inkremental pada ledger acara, lalu diselesaikan pada periode settlement.
            </p>
          </div>
        </div>

        {/* 4 Steps Timeline */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 relative">
          {summary?.period_breakdown.map((p, idx) => {
            const isSettled = p.status === 'SETTLED';
            const isBulan4 = p.period === 'Bulan 4';
            return (
              <div
                key={p.period}
                onClick={() => setPeriodFilter(periodFilter === p.period ? 'ALL' : p.period)}
                className={`p-4 rounded-xl border transition-all cursor-pointer relative ${
                  periodFilter === p.period
                    ? 'border-indigo-600 bg-indigo-50/50 shadow-md ring-2 ring-indigo-500/20'
                    : 'border-slate-200 bg-slate-50/50 hover:bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                    {p.period}
                  </span>
                  {isSettled ? (
                    <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5" /> SETTLED
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                      {p.payable_count} Tagihan
                    </span>
                  )}
                </div>

                <div className="text-lg font-bold text-slate-900">
                  {formatRupiah(p.total_amount)}
                </div>

                <div className="text-xs text-slate-500 mt-2 space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span>Utang Aktif:</span>
                    <span className="font-semibold text-slate-800">{p.active_count}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span>Terlunasi:</span>
                    <span className="font-semibold text-emerald-600">{p.settled_count}</span>
                  </div>
                </div>

                <div className="mt-3 pt-2 border-t border-slate-200/60 flex items-center justify-between text-[11px] text-indigo-600 font-medium">
                  <span>{periodFilter === p.period ? 'Sedang Difilter' : 'Klik untuk filter'}</span>
                  <ChevronRight className="w-3 h-3" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Ledger Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Table Filters & Search */}
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col md:flex-row items-center justify-between gap-4">
          {/* Status Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
            {[
              { id: 'ALL', label: 'Semua Status' },
              { id: 'PAYABLE', label: 'PAYABLE (Utang)' },
              { id: 'APPROVED', label: 'APPROVED' },
              { id: 'PAYMENT_INITIATED', label: 'SP2D INITIATED' },
              { id: 'SETTLED', label: 'SETTLED (Lunas)' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
                  statusFilter === tab.id
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2 w-full md:w-auto">
            <div className="relative w-full md:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Cari PO, Vendor, Faktur..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            {periodFilter !== 'ALL' && (
              <button
                type="button"
                onClick={() => setPeriodFilter('ALL')}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200"
              >
                Reset Periode
              </button>
            )}
          </form>
        </div>

        {/* Payables Records Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3.5 px-4">No. PO & Payable</th>
                <th className="py-3.5 px-4">Vendor & Faktur</th>
                <th className="py-3.5 px-4 text-right">Nilai Kewajiban</th>
                <th className="py-3.5 px-4">Jatuh Tempo</th>
                <th className="py-3.5 px-4">Status Ledger</th>
                <th className="py-3.5 px-4">Rantai Persetujuan (Chain of Approval)</th>
                <th className="py-3.5 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-500" />
                    Memuat data buku besar utang...
                  </td>
                </tr>
              ) : payables.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    <BookOpen className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                    Tidak ada kewajiban pembayaran yang cocok dengan kriteria filter.
                  </td>
                </tr>
              ) : (
                payables.map((item) => {
                  const isTampered = item.is_tampered;
                  return (
                    <tr
                      key={item.id}
                      className={`hover:bg-slate-50/80 transition ${
                        isTampered ? 'bg-rose-50/50' : ''
                      }`}
                    >
                      {/* PO & Payable */}
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-slate-900 flex items-center gap-1.5">
                          {item.payable_number}
                          <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-slate-200 text-slate-700">
                            {item.period}
                          </span>
                        </div>
                        <div className="text-slate-500 font-mono text-[11px] mt-0.5">
                          PO: {item.po_number}
                        </div>
                        <button
                          onClick={() => onNavigateToLedger(item.id)}
                          className="text-[10px] text-indigo-600 hover:text-indigo-800 flex items-center gap-0.5 mt-1"
                        >
                          <Hash className="w-2.5 h-2.5" />
                          {item.document_hash.substring(0, 10)}... (Fabric)
                        </button>
                      </td>

                      {/* Vendor & Invoice */}
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                          <Building2 className="w-3.5 h-3.5 text-slate-400" />
                          {item.vendor_legal_name}
                        </div>
                        <div className="text-slate-500 text-[11px] mt-0.5">
                          Inv: {item.invoice_number}
                        </div>
                        {item.goods_receipt_number && (
                          <div className="text-[10px] text-slate-400">
                            BAST: {item.goods_receipt_number}
                          </div>
                        )}
                      </td>

                      {/* Amount */}
                      <td className="py-3.5 px-4 text-right">
                        <div
                          className={`font-bold text-sm ${
                            isTampered ? 'text-rose-600 line-through' : 'text-slate-900'
                          }`}
                        >
                          {formatRupiah(item.amount)}
                        </div>
                        {isTampered && (
                          <div className="text-[10px] font-bold text-rose-700 animate-pulse">
                            Tampered in DB!
                          </div>
                        )}
                        <div className="text-[10px] text-slate-400 font-mono">
                          IDR (minor: {item.amount_minor})
                        </div>
                      </td>

                      {/* Due Date */}
                      <td className="py-3.5 px-4">
                        <div className="text-slate-800 font-medium">
                          {new Date(item.due_date).toLocaleDateString('id-ID', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {item.status === 'SETTLED' ? 'Lunas' : 'Menunggu Pelunasan'}
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3.5 px-4">
                        {getStatusBadge(item.status, item.is_tampered)}
                        {item.payment_reference && (
                          <div className="text-[10px] text-slate-600 font-mono mt-1">
                            Ref: {item.payment_reference}
                          </div>
                        )}
                      </td>

                      {/* Chain of Approval */}
                      <td className="py-3.5 px-4">
                        <div className="flex flex-col gap-1 max-w-[200px]">
                          <div className="flex items-center gap-1 text-[11px]">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                item.approvals.some((a) => a.step === 'PROCUREMENT_OFFICER')
                                  ? 'bg-emerald-500'
                                  : 'bg-slate-300'
                              }`}
                            />
                            <span className="text-slate-700">1. Pejabat Pengadaan</span>
                          </div>
                          <div className="flex items-center gap-1 text-[11px]">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                item.approvals.some((a) => a.step === 'PPK')
                                  ? 'bg-emerald-500'
                                  : 'bg-slate-300'
                              }`}
                            />
                            <span className="text-slate-700">2. PPK (Komitmen)</span>
                          </div>
                          <div className="flex items-center gap-1 text-[11px]">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                item.approvals.some((a) => a.step === 'FINANCE')
                                  ? 'bg-emerald-500'
                                  : 'bg-slate-300'
                              }`}
                            />
                            <span className="text-slate-700">3. Bendahara / Finance</span>
                          </div>
                          <div className="flex items-center gap-1 text-[11px]">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                item.approvals.some((a) => a.step === 'AUTHORIZED_OFFICER')
                                  ? 'bg-emerald-500'
                                  : 'bg-slate-300'
                              }`}
                            />
                            <span className="text-slate-700">4. Pejabat Berwenang</span>
                          </div>
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Audit Integrity button */}
                          <button
                            onClick={() => handleAudit(item)}
                            className="p-1 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition cursor-pointer"
                            title="Audit Integritas Kriptografis (DB vs Fabric)"
                          >
                            <ShieldCheck className="w-4 h-4 text-indigo-600" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* AUDIT INTEGRITY MODAL */}
      {isAuditOpen && auditResult && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-6 h-6 text-indigo-600" />
                <h3 className="text-base font-bold text-slate-900">
                  Hasil Audit Integritas Kriptografis
                </h3>
              </div>
              <button
                onClick={() => setIsAuditOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div
              className={`p-4 rounded-xl border mb-4 ${
                auditResult.is_match
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                  : 'bg-rose-50 border-rose-300 text-rose-950'
              }`}
            >
              <div className="flex items-center gap-2 font-bold text-sm mb-1">
                {auditResult.is_match ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    INTEGRITAS RELASIONAL & BLOCKCHAIN VALID
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-5 h-5 text-rose-600" />
                    PERINGATAN: DATA TELAH DIMANIPULASI!
                  </>
                )}
              </div>
              <p className="text-xs leading-relaxed">{auditResult.message}</p>
            </div>

            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs space-y-2 mb-4 font-mono">
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Nilai Database Saat Ini:</span>
                <span className="font-bold text-slate-900">{formatRupiah(auditResult.database_amount)}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Hash Dokumen Database Lokal (SHA-256):</span>
                <span className="text-[11px] text-slate-800 break-all">{auditResult.database_hash}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Hash Tercatat di Hyperledger Fabric:</span>
                <span className="text-[11px] text-indigo-700 break-all">{auditResult.ledger_hash}</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setIsAuditOpen(false);
                  onNavigateToTamperLab(auditResult.payable_id);
                }}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
              >
                Buka di Tamper-Evident Lab <ArrowRight className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() => setIsAuditOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
