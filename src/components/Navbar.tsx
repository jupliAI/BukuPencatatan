import React, { useState } from 'react';
import { User, Role } from '../types.ts';
import { ApiClient } from '../api.ts';
import { ShieldCheck, Building2, UserCircle, LogOut, FileText, Users, LayoutDashboard, RefreshCw, Cpu, Menu, X } from 'lucide-react';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
  onSwitchUser: (email: string) => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  activeClass: string;
  isActive: (tab: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    icon: <LayoutDashboard className="w-4 h-4" />,
    activeClass: 'bg-slate-800 text-white',
    isActive: (tab) => tab === 'dashboard',
  },
  {
    key: 'accounts-payable',
    label: 'Buku Besar Utang',
    icon: <FileText className="w-4 h-4 text-amber-400" />,
    activeClass: 'bg-indigo-600 text-white shadow-sm font-semibold',
    isActive: (tab) => tab === 'accounts-payable',
  },
  {
    key: 'purchase-orders',
    label: 'Purchase Orders',
    icon: <Building2 className="w-4 h-4" />,
    activeClass: 'bg-slate-800 text-white',
    isActive: (tab) => tab.startsWith('purchase-orders'),
  },
  {
    key: 'blockchain-ledger',
    label: 'Fabric Ledger',
    icon: <Cpu className="w-4 h-4 text-indigo-400" />,
    activeClass: 'bg-slate-800 text-white',
    isActive: (tab) => tab === 'blockchain-ledger',
  },
  {
    key: 'tamper-lab',
    label: 'Tamper Lab',
    icon: <ShieldCheck className="w-4 h-4 text-amber-300" />,
    activeClass: 'bg-amber-600 text-white shadow-sm',
    isActive: (tab) => tab === 'tamper-lab',
  },
  {
    key: 'vendors',
    label: 'Vendors',
    icon: <Users className="w-4 h-4" />,
    activeClass: 'bg-slate-800 text-white',
    isActive: (tab) => tab === 'vendors',
  },
];

export const Navbar: React.FC<NavbarProps> = ({
  currentUser,
  onLogout,
  onSwitchUser,
  activeTab,
  setActiveTab,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (!currentUser) return null;

  const roleColors: Record<Role, string> = {
    ADMIN: 'bg-purple-100 text-purple-800 border-purple-200',
    PROCUREMENT_OFFICER: 'bg-blue-100 text-blue-800 border-blue-200',
    PPK: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    FINANCE: 'bg-amber-100 text-amber-800 border-amber-200',
    AUTHORIZED_OFFICER: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    PAYMENT_SYSTEM: 'bg-slate-100 text-slate-800 border-slate-200',
    AUDITOR: 'bg-rose-100 text-rose-800 border-rose-200',
    VENDOR: 'bg-teal-100 text-teal-800 border-teal-200',
  };

  const handleNavigate = (tab: string) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  return (
    <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-2 h-16">
          {/* Brand */}
          <div
            className="flex items-center space-x-3 cursor-pointer min-w-0 shrink"
            onClick={() => handleNavigate('dashboard')}
          >
            <div className="w-10 h-10 shrink-0 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-md">
              <ShieldCheck className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0">
              <div className="font-bold text-base tracking-tight leading-tight flex items-center gap-2 min-w-0">
                <span className="truncate">AP Ledger</span>
                <span className="hidden sm:inline text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shrink-0">
                  Phase 3 Fabric
                </span>
              </div>
              <div className="hidden sm:block text-xs text-slate-400 truncate">
                Blockchain Audit Ledger &amp; Outbox
              </div>
            </div>
          </div>

          {/* Navigation Links — label disembunyikan di bawah lg agar tidak memicu overflow,
              seluruh nav disembunyikan di bawah md dan digantikan menu mobile. */}
          <nav className="hidden md:flex items-center space-x-1 min-w-0">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => handleNavigate(item.key)}
                className={`shrink-0 px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  item.isActive(activeTab) ? item.activeClass : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                {item.icon}
                <span className="hidden lg:inline">{item.label}</span>
              </button>
            ))}
          </nav>

          {/* User Profile & Role Switcher */}
          <div className="flex items-center space-x-3 shrink-0">
            {/* Quick Dev Role Switcher */}
            <div className="hidden xl:flex items-center text-xs bg-slate-800 rounded-lg p-1 border border-slate-700">
              <span className="text-slate-400 px-2 font-medium">Role:</span>
              <button
                onClick={() => onSwitchUser('procurement@example.local')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                  currentUser.role === 'PROCUREMENT_OFFICER' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
                title="Pejabat Pengadaan"
              >
                Pengadaan
              </button>
              <button
                onClick={() => onSwitchUser('ppk@example.local')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                  currentUser.role === 'PPK' ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
                title="Pejabat Pembuat Komitmen"
              >
                PPK
              </button>
              <button
                onClick={() => onSwitchUser('finance@example.local')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                  currentUser.role === 'FINANCE' ? 'bg-amber-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
                title="Bendahara / Keuangan"
              >
                Finance
              </button>
              <button
                onClick={() => onSwitchUser('authorized@example.local')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                  currentUser.role === 'AUTHORIZED_OFFICER' ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
                title="Pejabat Berwenang"
              >
                Berwenang
              </button>
              <button
                onClick={() => onSwitchUser('admin@example.local')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                  currentUser.role === 'ADMIN' ? 'bg-purple-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
                title="Administrator"
              >
                Admin
              </button>
              <button
                onClick={() => onSwitchUser('auditor@example.local')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                  currentUser.role === 'AUDITOR' ? 'bg-rose-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
                title="Auditor Eksternal"
              >
                Auditor
              </button>
            </div>

            {/* Current User Badge */}
            <div className="flex items-center space-x-2 pl-2 border-l border-slate-800 shrink-0">
              <div className="text-right hidden sm:block">
                <div className="text-xs font-semibold text-slate-200">{currentUser.name}</div>
                <div className="flex items-center justify-end gap-1.5">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.2 rounded border ${roleColors[currentUser.role] || 'bg-slate-700 text-white'}`}>
                    {currentUser.role}
                  </span>
                  <span className="text-[10px] text-slate-400 flex items-center gap-0.5">
                    <Building2 className="w-2.5 h-2.5" />
                    {currentUser.organization.code}
                  </span>
                </div>
              </div>
              <button
                onClick={onLogout}
                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded-lg transition"
                title="Sign Out"
                aria-label="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
              {/* Toggle menu mobile */}
              <button
                onClick={() => setMobileMenuOpen((open) => !open)}
                className="md:hidden p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition"
                title="Menu"
                aria-label="Menu"
                aria-expanded={mobileMenuOpen}
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Menu mobile */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-slate-800 bg-slate-900 px-4 sm:px-6 pb-3 pt-2">
          <nav className="flex flex-col space-y-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => handleNavigate(item.key)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                  item.isActive(activeTab) ? item.activeClass : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          <div className="mt-2 pt-2 border-t border-slate-800 flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {currentUser.name} &bull; {currentUser.role}
            </span>
            <button
              onClick={onLogout}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-rose-300 bg-slate-800 hover:bg-slate-700 transition flex items-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
