import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { Sidebar, type DesktopView } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { RolePreviewBanner } from './components/RolePreviewBanner';
import { TweaksPanel } from './components/TweaksPanel';
import { useAuth } from './lib/auth';
import { useEffectiveUser } from './lib/tweaks';
import {
  useRoute, match, navigate,
  DESKTOP_VIEW_TO_PATH, pathToDesktopView,
} from './lib/route';
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
import { FormSkeleton } from './components/Skeleton';

import type { Order } from './lib/types';

type Toast = { msg: string; kind: 'success' | 'error' };

export function DesktopApp() {
  const { loading } = useAuth();
  const user = useEffectiveUser();
  const [toast, setToast] = useState<Toast | null>(null);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [loadingOrderId, setLoadingOrderId] = useState<string | null>(null);

  const { path } = useRoute();
  const view: DesktopView = pathToDesktopView(path);
  const setView = (v: DesktopView) => navigate(DESKTOP_VIEW_TO_PATH[v]);
  // /inventory/:id opens the edit page; otherwise no item is being edited.
  const editingItemId = match('/inventory/:id', path)?.id ?? null;

  // Sync editingOrder with the URL hash. Loading the app at
  // `#/purchase-orders/<id>` opens that order's edit page; clearing the hash
  // closes it.
  useEffect(() => {
    const m = match('/purchase-orders/:id', path);
    if (!m) {
      // No id in URL → ensure no order is open.
      if (editingOrder) setEditingOrder(null);
      return;
    }
    if (editingOrder?.id === m.id) return; // already showing the right one
    setLoadingOrderId(m.id);
    api.get<{ order: Order }>(`/api/orders/${m.id}`)
      .then(r => setEditingOrder(r.order))
      .catch(() => {/* ignore — order may have been deleted */})
      .finally(() => setLoadingOrderId(null));
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
        onCancel={() => navigate('/inventory')}
        onSaved={() => { navigate('/inventory'); showToast('Saved'); }}
      />
    : <DesktopInventory onEditItem={(id) => navigate('/inventory/' + id)} showToast={showToast} />;

  // When the user opens an order's edit page we replace the orders list with
  // it. Cancel / save returns to the list.
  const ordersOrEdit = editingOrder
    ? <DesktopEditOrder
        order={editingOrder}
        onCancel={() => { navigate('/purchase-orders'); setEditingOrder(null); }}
        onSaved={(msg) => { navigate('/purchase-orders'); setEditingOrder(null); showToast(msg); }}
      />
    : loadingOrderId
      ? <FormSkeleton fields={8} />
      : <DesktopOrders onEdit={(o) => { navigate('/purchase-orders/' + o.id); setEditingOrder(o); }} onToast={(m) => showToast(m)} />;

  return (
    <div className="app">
      <Sidebar view={view2} setView={setView} />
      <main className="main">
        <Topbar />
        <RolePreviewBanner />
        <div className={'page'
          + (view2 === 'history' && !editingOrder ? ' page-history' : '')
          + (view2 === 'market' ? ' page-market' : '')
          + (view2 === 'inventory' && !editingItemId ? ' page-inventory' : '')
          + (view2 === 'dashboard' ? ' page-dashboard' : '')}>
          {view2 === 'dashboard'  && <DesktopDashboard />}
          {view2 === 'submit'     && (
            <DesktopSubmit
              onDone={(toast) => {
                if (toast) showToast(toast.msg, toast.kind ?? 'success');
                navigate('/purchase-orders');
              }}
            />
          )}
          {view2 === 'history'    && ordersOrEdit}
          {view2 === 'market'     && <DesktopMarket />}
          {view2 === 'inventory'  && inventoryOrEdit}
          {view2 === 'sellorders' && (
            <DesktopSellOrders onNewFromInventory={() => navigate('/inventory')} onToast={showToast} />
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

      <TweaksPanel />
    </div>
  );
}

