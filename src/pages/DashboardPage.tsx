import React, { useEffect, useState } from 'react';
import { User, PurchaseOrder, Vendor, ApplicationEvent } from '../types.ts';
import { ApiClient } from '../api.ts';
import {
  FileText,
  Users,
  ShieldCheck,
  RefreshCw,
  Clock,
  CheckCircle,
  Building,
  ArrowUpRight,
} from 'lucide-react';

interface DashboardPageProps {
  currentUser: User;
  onNavigate: (tab: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ currentUser, onNavigate }) => {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [events, setEvents] = useState<ApplicationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [flushing, setFlushing] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [posRes, vendorsRes, eventsRes] = await Promise.all([
        ApiClient.getPurchaseOrders(),
        ApiClient.getVendors(),
        ApiClient.getAuditEvents(),
      ]);
      setPos(posRes.items || []);
      setVendors(vendorsRes.items || []);
      setEvents(eventsRes || []);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleFlushOutbox = async () => {
    setFlushing(true);
    try {
      await ApiClient.triggerProcessOutbox();
      await loadData();
    } catch (err) {
      console.error('Outbox flush error:', err);
    } finally {
      setFlushing(false);
    }
  };

  const pendingEventsCount = events.filter((e) => e.status === 'PENDING').length;
  const confirmedEventsCount = events.filter((e) => e.status === 'CONFIRMED').length;

  return (
    <div className="space-y-6">
      {/* Top Banner / Org Info */}
      <div className="bg-gradient-to-r from-slate-900 to-slate-800 border border-slate-700/60 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-blue-400 uppercase tracking-wider">
              <Building className="w-3.5 h-3.5" />
              {currentUser.organization.name} ({currentUser.organization.code})
            </div>
            <h1 className="text-2xl font-bold text-white mt-1">Procurement & Audit Ledger Desk</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Role: <span className="font-medium text-slate-300">{currentUser.role}</span> &bull; Separation of Concerns: SQL Database + Hyperledger Audit Outbox
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadData}
              disabled={loading}
              className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 text-xs font-medium transition flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {currentUser.role === 'ADMIN' && (
              <button
                onClick={handleFlushOutbox}
                disabled={flushing}
                className="px-3 py-2.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 rounded-xl text-xs font-semibold transition flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${flushing ? 'animate-spin' : ''}`} />
                Flush Outbox
              </button>
            )}
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Purchase Orders</span>
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
              <FileText className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white mt-2">{pos.length}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
            <span>{pos.filter((p) => p.status === 'ISSUED').length} Issued</span> &bull;{' '}
            <span>{pos.filter((p) => p.status === 'DRAFT').length} Draft</span>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Vendors</span>
            <div className="p-2 rounded-lg bg-teal-500/10 text-teal-400">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white mt-2">{vendors.length}</div>
          <div className="text-xs text-slate-400 mt-1">Verified Suppliers in Org</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Blockchain Outbox</span>
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
              <ShieldCheck className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white mt-2">{confirmedEventsCount}</div>
          <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />
            Confirmed on Ledger
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Pending Ingestion</span>
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white mt-2">{pendingEventsCount}</div>
          <div className="text-xs text-slate-400 mt-1">Queued Outbox Events</div>
        </div>
      </div>

      {/* Main Content Grid: Recent POs and Recent Outbox Events */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Recent Purchase Orders */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-400" />
              Recent Purchase Orders
            </h3>
            <button
              onClick={() => onNavigate('purchase-orders')}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 transition flex items-center gap-1"
            >
              View All <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {pos.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm">No purchase orders found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-2.5 font-medium">PO Number</th>
                    <th className="pb-2.5 font-medium">Vendor</th>
                    <th className="pb-2.5 font-medium">Total Amount</th>
                    <th className="pb-2.5 font-medium">Status</th>
                    <th className="pb-2.5 font-medium">Blockchain</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {pos.slice(0, 5).map((po) => (
                    <tr
                      key={po.id}
                      onClick={() => onNavigate(`purchase-orders/${po.id}`)}
                      className="hover:bg-slate-800/40 cursor-pointer transition"
                    >
                      <td className="py-3 font-semibold text-blue-400">{po.po_number}</td>
                      <td className="py-3 text-slate-300">{po.vendor?.legal_name || 'N/A'}</td>
                      <td className="py-3 font-mono font-medium text-white">
                        {po.currency} {Number(po.total_amount).toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                            po.status === 'ISSUED'
                              ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                              : po.status === 'CANCELLED'
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          }`}
                        >
                          {po.status}
                        </span>
                      </td>
                      <td className="py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${
                            po.blockchain_status === 'CONFIRMED'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-amber-500/10 text-amber-400'
                          }`}
                        >
                          {po.blockchain_status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Column: Outbox Audit Stream */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-400" />
              Ledger Outbox Stream
            </h3>
            <button
              onClick={() => onNavigate('blockchain-ledger')}
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition flex items-center gap-1"
            >
              Ledger Explorer <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {events.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm">No outbox events recorded.</div>
          ) : (
            <div className="space-y-3">
              {events.slice(0, 6).map((ev) => (
                <div key={ev.id} className="p-3 bg-slate-800/60 border border-slate-800 rounded-lg text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-200">{ev.event_type}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                        ev.status === 'CONFIRMED' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      {ev.status}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1 font-mono truncate">
                    Entity: {ev.entity_type} #{ev.entity_id.substring(0, 8)}...
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1 flex items-center justify-between">
                    <span>{new Date(ev.created_at).toLocaleTimeString()}</span>
                    <span>Attempts: {ev.attempt_count}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
