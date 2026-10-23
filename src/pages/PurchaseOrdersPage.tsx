import React, { useEffect, useState } from 'react';
import { PurchaseOrder, User } from '../types.ts';
import { ApiClient } from '../api.ts';
import { FileText, Search, Filter, ShieldCheck, Clock, Building, Calendar, ArrowRight } from 'lucide-react';

interface PurchaseOrdersPageProps {
  currentUser: User;
  onNavigate: (tab: string) => void;
}

export const PurchaseOrdersPage: React.FC<PurchaseOrdersPageProps> = ({ currentUser, onNavigate }) => {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const loadPOs = async () => {
    setLoading(true);
    try {
      const res = await ApiClient.getPurchaseOrders({
        status: statusFilter || undefined,
        search: search || undefined,
      });
      setPos(res.items || []);
    } catch (err) {
      console.error('Failed to load purchase orders:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPOs();
  }, [statusFilter, search]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900 p-6 rounded-2xl border border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-400" />
            Purchase Orders (Obligations Ledger)
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Tracking lifecycle obligations for organization <span className="font-semibold text-slate-300">{currentUser.organization.code}</span>
          </p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-500" />
          <input
            type="text"
            placeholder="Search by PO number or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter className="w-4 h-4 text-slate-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-900 border border-slate-800 text-xs text-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Statuses</option>
            <option value="DRAFT">DRAFT</option>
            <option value="ISSUED">ISSUED</option>
            <option value="CANCELLED">CANCELLED</option>
          </select>
        </div>
      </div>

      {/* PO Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="py-12 text-center text-xs text-slate-500">Loading purchase orders...</div>
        ) : pos.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500">No purchase orders found matching criteria.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-slate-800/60 border-b border-slate-800 text-slate-400">
                  <th className="py-3 px-4 font-semibold">PO Number</th>
                  <th className="py-3 px-4 font-semibold">Vendor</th>
                  <th className="py-3 px-4 font-semibold">Description</th>
                  <th className="py-3 px-4 font-semibold">Total Amount</th>
                  <th className="py-3 px-4 font-semibold">Due Date</th>
                  <th className="py-3 px-4 font-semibold">Status</th>
                  <th className="py-3 px-4 font-semibold">Blockchain</th>
                  <th className="py-3 px-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {pos.map((po) => (
                  <tr
                    key={po.id}
                    onClick={() => onNavigate(`purchase-orders/${po.id}`)}
                    className="hover:bg-slate-800/30 cursor-pointer transition"
                  >
                    <td className="py-3.5 px-4 font-mono font-bold text-blue-400">{po.po_number}</td>
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-white">{po.vendor?.legal_name || 'N/A'}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{po.vendor?.vendor_code}</div>
                    </td>
                    <td className="py-3.5 px-4 max-w-xs truncate text-slate-300">{po.description}</td>
                    <td className="py-3.5 px-4 font-mono font-semibold text-white">
                      {po.currency} {Number(po.total_amount).toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3.5 px-4 text-slate-400">
                      {new Date(po.due_date).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
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
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium ${
                          po.blockchain_status === 'CONFIRMED'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-amber-500/10 text-amber-400'
                        }`}
                      >
                        {po.blockchain_status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <span className="text-blue-400 hover:text-blue-300 font-medium inline-flex items-center gap-1">
                        View <ArrowRight className="w-3 h-3" />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
