import React, { useState, useEffect } from 'react';
import { User } from './types.ts';
import { ApiClient } from './api.ts';
import { Navbar } from './components/Navbar.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { VendorsPage } from './pages/VendorsPage.tsx';
import { PurchaseOrdersPage } from './pages/PurchaseOrdersPage.tsx';
import { PurchaseOrderDetailPage } from './pages/PurchaseOrderDetailPage.tsx';
import { BlockchainLedgerPage } from './pages/BlockchainLedgerPage.tsx';

export function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [ledgerEntityId, setLedgerEntityId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const initAuth = async () => {
      const token = ApiClient.getToken();
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const user = await ApiClient.getMe();
        setCurrentUser(user);
      } catch {
        ApiClient.clearTokens();
        setCurrentUser(null);
      } finally {
        setLoading(false);
      }
    };

    initAuth();
  }, []);

  const handleLoginSuccess = (user: User) => {
    setCurrentUser(user);
    setActiveTab('dashboard');
  };

  const handleLogout = async () => {
    await ApiClient.logout();
    setCurrentUser(null);
  };

  const handleSwitchUser = async (email: string) => {
    try {
      const user = await ApiClient.login(email, 'Password123!');
      setCurrentUser(user);
    } catch (err) {
      console.error('Failed to switch user:', err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-xs">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          Initializing Blockchain Transaction Ledger Portal...
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Navbar
        currentUser={currentUser}
        onLogout={handleLogout}
        onSwitchUser={handleSwitchUser}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'dashboard' && (
          <DashboardPage currentUser={currentUser} onNavigate={setActiveTab} />
        )}

        {activeTab === 'vendors' && <VendorsPage currentUser={currentUser} />}

        {activeTab === 'purchase-orders' && (
          <PurchaseOrdersPage currentUser={currentUser} onNavigate={setActiveTab} />
        )}

        {activeTab === 'blockchain-ledger' && (
          <BlockchainLedgerPage
            currentUser={currentUser}
            onNavigate={setActiveTab}
            initialEntityId={ledgerEntityId}
          />
        )}

        {activeTab.startsWith('purchase-orders/') && (
          <PurchaseOrderDetailPage
            poId={activeTab.replace('purchase-orders/', '')}
            currentUser={currentUser}
            onNavigate={setActiveTab}
          />
        )}
      </main>

      <footer className="border-t border-slate-800/80 bg-slate-900/60 py-4 text-center text-[11px] text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>
            Blockchain Transaction Ledger &bull; Hyperledger Fabric Gateway & Outbox Architecture
          </div>
          <div className="text-slate-400 font-mono text-[10px]">
            Node.js / Express &bull; Decimal.js Minor Units &bull; Hyperledger Fabric 2.5+
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
