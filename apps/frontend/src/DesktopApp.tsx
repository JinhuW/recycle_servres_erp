import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { Sidebar, type DesktopView } from './components/Sidebar';
import { useAuth } from './lib/auth';

import { DesktopDashboard } from './pages/desktop/DesktopDashboard';
import { DesktopOrders } from './pages/desktop/DesktopOrders';
import { DesktopEditOrder } from './pages/desktop/DesktopEditOrder';
import { DesktopInventory } from './pages/desktop/DesktopInventory';
import { DesktopInventoryEdit } from './pages/desktop/DesktopInventoryEdit';
import { DesktopMarket } from './pages/desktop/DesktopMarket';
import { DesktopSellOrders } from './pages/desktop/DesktopSellOrders';
import { DesktopSettings } from './pages/desktop/DesktopSettings';
import { DesktopSubmit } from './pages/desktop/DesktopSubmit';
import { Login } from './pages/Login';

import type { Order } from './lib/types';

type Toast = { msg: string; kind: 'success' | 'error' };

export function DesktopApp() {
  const { user, loading } = useAuth();
  const [view, setView] = useState<DesktopView>('dashboard');
  const [toast, setToast] = useState<Toast | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);

  // Apply 'desktop' class to <html> so the desktop CSS overrides take effect
  // and undo the mobile shell's overflow lock.
  useEffect(() => {
    document.body.classList.remove('phone-mode');
    document.body.classList.add('desktop');
    return () => { document.body.classList.remove('desktop'); };
  }, []);

  const showToast = (msg: string, kind: Toast['kind'] = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  };

  if (loading) {
    return <div style={{ padding: 60, color: 'var(--fg-subtle)' }}>Loading…</div>;
  }
  if (!user) return <Login variant="desktop" />;

  // Default to dashboard if a purchaser tried to navigate to a manager-only view.
  const view2: DesktopView = user.role === 'purchaser' && (view === 'inventory' || view === 'sellorders' || view === 'settings')
    ? 'dashboard'
    : view;

  // Edit page is rendered in place of the inventory list when an item is open.
  const inventoryOrEdit = editingItemId
    ? <DesktopInventoryEdit
        itemId={editingItemId}
        onCancel={() => setEditingItemId(null)}
        onSaved={() => { setEditingItemId(null); showToast('Saved'); }}
      />
    : <DesktopInventory onEditItem={(id) => setEditingItemId(id)} showToast={showToast} />;

  // When the user opens an order's edit page we replace the orders list with
  // it. Cancel / save returns to the list.
  const ordersOrEdit = editingOrder
    ? <DesktopEditOrder
        order={editingOrder}
        onCancel={() => setEditingOrder(null)}
        onSaved={(msg) => { setEditingOrder(null); showToast(msg); }}
      />
    : <DesktopOrders onEdit={(o) => setEditingOrder(o)} />;

  return (
    <div className="app">
      <Sidebar view={view2} setView={setView} />
      <main className="main">
        <div className="page">
          {view2 === 'dashboard'  && <DesktopDashboard />}
          {view2 === 'submit'     && (
            <DesktopSubmit
              onDone={(toast) => {
                if (toast) showToast(toast.msg, toast.kind ?? 'success');
                setView('history');
              }}
            />
          )}
          {view2 === 'history'    && ordersOrEdit}
          {view2 === 'market'     && <DesktopMarket />}
          {view2 === 'inventory'  && inventoryOrEdit}
          {view2 === 'sellorders' && (
            <DesktopSellOrders onNewFromInventory={() => setView('inventory')} />
          )}
          {view2 === 'settings'   && <DesktopSettings showToast={showToast} />}
        </div>
      </main>

      {toast && (
        <div className="toast-wrap">
          <div className={'toast ' + toast.kind}>
            <Icon name="check2" size={16} />
            <span>{toast.msg}</span>
          </div>
        </div>
      )}
    </div>
  );
}

