import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { Sidebar, type DesktopView } from './components/Sidebar';
import { useAuth } from './lib/auth';
import { useRoute, match, navigate } from './lib/route';
import { api } from './lib/api';

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

  const { path } = useRoute();

  // Sync editingOrder with the URL hash. Loading the app at
  // `#/orders/<id>` opens that order's edit page; clearing the hash
  // closes it.
  useEffect(() => {
    const m = match('/orders/:id', path);
    if (!m) {
      // If we're already on /orders (no id) and an editingOrder is open, close it.
      if (path === '/orders' && editingOrder) setEditingOrder(null);
      return;
    }
    if (editingOrder?.id === m.id) return; // already showing the right one
    // Force the orders view, then load the order.
    setView('history');
    api.get<{ order: Order }>(`/api/orders/${m.id}`)
      .then(r => setEditingOrder(r.order))
      .catch(() => {/* ignore — order may have been deleted */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

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
        onCancel={() => { navigate('/orders'); setEditingOrder(null); }}
        onSaved={(msg) => { navigate('/orders'); setEditingOrder(null); showToast(msg); }}
      />
    : <DesktopOrders onEdit={(o) => { navigate('/orders/' + o.id); setEditingOrder(o); }} onToast={(m) => showToast(m)} />;

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

