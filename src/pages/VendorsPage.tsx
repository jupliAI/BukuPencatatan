import React, { useEffect, useState } from 'react';
import { Vendor, User } from '../types.ts';
import { ApiClient } from '../api.ts';
import { Users, Search, Mail, MapPin, FileCheck } from 'lucide-react';

interface VendorsPageProps {
  currentUser: User;
}

export const VendorsPage: React.FC<VendorsPageProps> = ({ currentUser }) => {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const loadVendors = async () => {
    setLoading(true);
    try {
      const res = await ApiClient.getVendors({ search });
      setVendors(res.items || []);
    } catch (err) {
      console.error('Failed to load vendors:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadVendors();
  }, [search]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900 p-6 rounded-2xl border border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-teal-400" />
            Vendor Directory & Registry
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Compliant suppliers registered under organization <span className="font-semibold text-slate-300">{currentUser.organization.code}</span>
          </p>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-500" />
          <input
            type="text"
            placeholder="Search by vendor code, legal name, tax ID, or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-500 transition"
          />
        </div>
      </div>

      {/* Vendors Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="py-12 text-center text-xs text-slate-500">Loading verified vendors...</div>
        ) : vendors.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500">No vendors found matching your criteria.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-slate-800/60 border-b border-slate-800 text-slate-400">
                  <th className="py-3 px-4 font-semibold">Vendor Code</th>
                  <th className="py-3 px-4 font-semibold">Legal Name</th>
                  <th className="py-3 px-4 font-semibold">Tax ID (NPWP)</th>
                  <th className="py-3 px-4 font-semibold">Contact Email</th>
                  <th className="py-3 px-4 font-semibold">Address</th>
                  <th className="py-3 px-4 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {vendors.map((v) => (
                  <tr key={v.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4 font-mono font-semibold text-teal-400">{v.vendor_code}</td>
                    <td className="py-3.5 px-4 font-medium text-white">{v.legal_name}</td>
                    <td className="py-3.5 px-4 font-mono text-slate-400">{v.tax_id}</td>
                    <td className="py-3.5 px-4 text-slate-400 flex items-center gap-1.5">
                      <Mail className="w-3 h-3 text-slate-500" />
                      {v.contact_email}
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 max-w-xs truncate">{v.address}</td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          v.status === 'ACTIVE'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        }`}
                      >
                        {v.status}
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
