import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Sidebar, type DesktopView } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { RolePreviewBanner } from './components/RolePreviewBanner';
import { TweaksPanel } from './components/TweaksPanel';
import { useAuth } from './lib/auth';
import { useT } from './lib/i18n';
import { usePreference } from './lib/preferences';
import { useEffectiveUser } from './lib/tweaks';
import {
  useRoute, match, matchPurchaseOrder, matchPoCheck, navigate, parseShippingRoute,
  pathToDesktopView, isAuthorizePath, readSafeNext, hrefFor, onLinkClick, replaceRoute,
} from './lib/route';
import { api, ApiError } from './lib/api';
import { showErrorDialog } from './lib/errorToast';
import { ErrorDialog, useErrorDialogQueue } from './components/ErrorDialog';

// Eager: the landing view, and the two gates a logged-out or freshly-logged-in
// user hits before anything else. Making these lazy would only buy a spinner.
import { DesktopDashboard } from './pages/desktop/DesktopDashboard';
import { Login } from './pages/Login';
import { RolePicker } from './pages/RolePicker';
import { FormSkeleton } from './components/Skeleton';

// Every other view is its own chunk — they were ~14k lines of eager imports
// that a user who only opened the dashboard still paid for.
const DesktopOrders = lazy(() => import('./pages/desktop/DesktopOrders').then(m => ({ default: m.DesktopOrders })));
const DesktopEditOrder = lazy(() => import('./pages/desktop/DesktopEditOrder').then(m => ({ default: m.DesktopEditOrder })));
const DesktopInventory = lazy(() => import('./pages/desktop/DesktopInventory').then(m => ({ default: m.DesktopInventory })));
const DesktopInventoryEdit = lazy(() => import('./pages/desktop/DesktopInventoryEdit').then(m => ({ default: m.DesktopInventoryEdit })));
const DesktopAnalysis = lazy(() => import('./pages/desktop/DesktopAnalysis').then(m => ({ default: m.DesktopAnalysis })));
const DesktopMarket = lazy(() => import('./pages/desktop/DesktopMarket').then(m => ({ default: m.DesktopMarket })));
const DesktopSellOrders = lazy(() => import('./pages/desktop/DesktopSellOrders').then(m => ({ default: m.DesktopSellOrders })));
const DesktopTransfers = lazy(() => import('./pages/desktop/DesktopTransfers').then(m => ({ default: m.DesktopTransfers })));
const DesktopWebSubmissions = lazy(() => import('./pages/desktop/DesktopWebSubmissions').then(m => ({ default: m.DesktopWebSubmissions })));
const DesktopActivity = lazy(() => import('./pages/desktop/DesktopActivity').then(m => ({ default: m.DesktopActivity })));
const DesktopPayments = lazy(() => import('./pages/desktop/DesktopPayments').then(m => ({ default: m.DesktopPayments })));
const DesktopInternalTxns = lazy(() => import('./pages/desktop/DesktopInternalTxns').then(m => ({ default: m.DesktopInternalTxns })));
const DesktopSettings = lazy(() => import('./pages/desktop/DesktopSettings').then(m => ({ default: m.DesktopSettings })));
const DesktopTracker = lazy(() => import('./pages/desktop/DesktopTracker').then(m => ({ default: m.DesktopTracker })));
const DesktopCoordinator = lazy(() => import('./pages/desktop/DesktopCoordinator').then(m => ({ default: m.DesktopCoordinator })));
const DesktopAccountPool = lazy(() => import('./pages/desktop/DesktopAccountPool').then(m => ({ default: m.DesktopAccountPool })));
const DesktopSubmit = lazy(() => import('./pages/desktop/DesktopSubmit').then(m => ({ default: m.DesktopSubmit })));
const DesktopShipping = lazy(() => import('./pages/desktop/DesktopShipping').then(m => ({ default: m.DesktopShipping })));
const DesktopClients = lazy(() => import('./pages/desktop/DesktopClients').then(m => ({ default: m.DesktopClients })));
const DesktopBoxCheck = lazy(() => import('./pages/desktop/DesktopBoxCheck').then(m => ({ default: m.DesktopBoxCheck })));
const Authorize = lazy(() => import('./pages/Authorize').then(m => ({ default: m.Authorize })));

import type { Order } from './lib/types';

type Toast = { msg: string; kind: 'success' | 'error' | 'warn' };

export function DesktopApp() {
  const { loading, user: realUser, pendingRoleChoice } = useAuth();
  const user = useEffectiveUser();
  const { t } = useT();
  const [toast, setToast] = useState<Toast | null>(null);
  const { current: errorDialog, push: pushErrorDialog, dismiss: dismissErrorDialog } = useErrorDialogQueue();
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [loadingOrderId, setLoadingOrderId] = useState<string | null>(null);
  const [sidebarFolded, setSidebarFolded] = usePreference('sidebar.folded', false);
  // Bumped when the edit page asks to be re-read in place (after a stage
  // move). It keys the page, so the fresh order reseeds every field instead
  // of the page reconciling itself against props it never watched.
  const [orderReloads, setOrderReloads] = useState(0);

  const { path } = useRoute();
  const view: DesktopView = pathToDesktopView(path);
  // /inventory/:id opens the edit page; otherwise no item is being edited.
  // /inventory/analysis is the Analysis tab, not an item id — exclude it.
  const editingItemId = path === '/inventory/analysis' ? null : (match('/inventory/:id', path)?.id ?? null);
  // Dashboard / add-label — the parser owns the shapes.
  const shippingRoute = parseShippingRoute(path);
  // Box check takes over the whole window — no sidebar, no top bar — and
  // shares the loaded order with the PO page it opens from.
  const boxCheck = matchPoCheck(path);

  // Sync editingOrder with the URL hash. Loading the app at
  // `#/purchase-orders/<id>` opens that order's edit page; clearing the hash
  // closes it.
  // Moving between the PO page and its box check re-reads the order: each
  // writes lines the other's copy doesn't know about (Confirm line, a count),
  // and the PO page re-sends every line on a stage save.
  const orderRouteKind = useRef<'page' | 'check' | null>(null);
  useEffect(() => {
    const m = matchPurchaseOrder(path) ?? boxCheck;
    const kind = boxCheck ? 'check' : 'page';
    const kindChanged = orderRouteKind.current !== null && orderRouteKind.current !== kind;
    orderRouteKind.current = m ? kind : null;
    if (!m) {
      // No id in URL → ensure no order is open, and nothing is still loading:
      // leaving mid-fetch skips the `finally` below, which would otherwise
      // leave the list's row spinner on for good.
      if (editingOrder) setEditingOrder(null);
      setLoadingOrderId(null);
      return;
    }
    if (editingOrder?.id === m.id && !kindChanged) return; // already showing the right one
    if (kindChanged) setEditingOrder(null);
    let alive = true;
    setLoadingOrderId(m.id);
    api.get<{ order: Order }>(`/api/orders/${m.id}`)
      .then(r => { if (alive) setEditingOrder(r.order); })
      .catch((err) => {
        if (!alive) return;
        // Clear the unreachable URL so the failing fetch doesn't re-fire on
        // every re-render, and tell the user why nothing opened. Common case:
        // a manager in role-preview mode follows a link to a PO they don't own.
        navigate('/purchase-orders');
        const status = err instanceof ApiError ? err.status : 0;
        showErrorDialog(t(
          status === 403 ? 'poNoAccess'
          : status === 404 ? 'poNotFound'
          : 'poOpenFailed',
        ));
      })
      .finally(() => { if (alive) setLoadingOrderId(null); });
    return () => {
      alive = false;
      // Superseded mid-fetch: the `finally` above is now a no-op, so the flag
      // is cleared here, unless a newer fetch has already claimed it.
      setLoadingOrderId(cur => (cur === m.id ? null : cur));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Box check is a manager's page; anyone else (a manager previewing as a
  // purchaser included) lands on the PO itself — in place of the bounced
  // entry, so Back doesn't return to it.
  const boxCheckId = boxCheck?.id ?? null;
  useEffect(() => {
    if (boxCheckId && user && user.role !== 'manager') replaceRoute('/purchase-orders/' + boxCheckId);
  }, [boxCheckId, user]);

  // Apply 'desktop' class to <html> so the desktop CSS overrides take effect
  // and undo the mobile shell's overflow lock.
  useEffect(() => {
    document.body.classList.remove('phone-mode');
    document.body.classList.add('desktop');
    return () => { document.body.classList.remove('desktop'); };
  }, []);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  // Stable identity: children put this in effect dep arrays (DesktopTransfers
  // keys its reload on it). A fresh function each render makes any such effect
  // re-run on every toast — and an error toast raised BY that effect then loops.
  // Errors never become toasts: they go to the blocking dialog so the user can
  // read and act on them.
  // 'warn' is the exception: a nudge for something not yet attempted (a line
  // still missing fields), so it clears itself and reads longer than a
  // confirmation does.
  const showToast = useCallback((msg: string, kind: Toast['kind'] = 'success') => {
    if (kind === 'error') { pushErrorDialog({ msg }); return; }
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), kind === 'warn' ? 4500 : 2600);
  }, [pushErrorDialog]);

  // Register the global hooks so `handleFetchError` / `showErrorDialog` in
  // lib/errorToast.ts can surface errors from anywhere without prop-drilling.
  useEffect(() => {
    window.__showErrorDialog = (msg, details, title) => pushErrorDialog({ msg, details, title });
    window.__showToast = (msg, kind) => showToast(msg, kind ?? 'success');
    return () => { delete window.__showToast; delete window.__showErrorDialog; };
  }, [pushErrorDialog, showToast]);

  // Resume an OAuth authorize that bounced through the login screen. Must be a
  // real navigation, not navigate(), because the target is a backend route.
  // Lives up here with the other effects (hook order) and fires ahead of the
  // RolePicker gate below, which would otherwise strand a manager mid-connect.
  useEffect(() => {
    if (!user) return;
    const next = readSafeNext(window.location.search);
    if (next) window.location.replace(next);
  }, [user]);

  if (loading) {
    return <div style={{ padding: 60, color: 'var(--fg-subtle)' }}>{t('loadingApp')}</div>;
  }
  if (!user) return <Login variant="desktop" />;
  // Fresh manager login: gate the app until they pick a role to enter as.
  // Tested on realUser so the rolePreview transformation in useEffectiveUser
  // doesn't accidentally close the gate.
  if (pendingRoleChoice && realUser?.role === 'manager') return <RolePicker variant="desktop" />;
  // OAuth consent screen — render standalone (no sidebar/topbar). Reached via
  // the backend's `/oauth/authorize` 302 to `/authorize?req=…`.
  if (isAuthorizePath(path)) {
    return <Suspense fallback={<FormSkeleton fields={4} />}><Authorize /></Suspense>;
  }

  // Default to dashboard if a purchaser tried to navigate to a manager-only view.
  const view2: DesktopView = user.role === 'purchaser' && (view === 'inventory' || view === 'analysis' || view === 'sellorders' || view === 'transfers' || view === 'websubmissions' || view === 'activity' || view === 'payments' || view === 'internaltx' || view === 'tracker' || view === 'coordinator' || view === 'accountPool')
    ? 'dashboard'
    : view;

  // Edit page is rendered in place of the inventory list when an item is open.
  const inventoryOrEdit = editingItemId
    ? <DesktopInventoryEdit
        itemId={editingItemId}
        onCancel={() => navigate('/inventory')}
        onSaved={() => { navigate('/inventory'); showToast(t('savedShort')); }}
      />
    : <DesktopInventory onEditItem={(id) => navigate('/inventory/' + id)} showToast={showToast} />;

  // When the user opens an order's edit page we replace the orders list with
  // it. Cancel / save returns to the list.
  const reloadOrder = async () => {
    if (!editingOrder) return;
    const r = await api.get<{ order: Order }>(`/api/orders/${editingOrder.id}`);
    setEditingOrder(r.order);
    setOrderReloads(n => n + 1);
  };
  const ordersOrEdit = boxCheck
    ? (editingOrder?.id === boxCheck.id && user.role === 'manager'
      ? <DesktopBoxCheck
          key={editingOrder.id + ':' + orderReloads}
          order={editingOrder}
          onExit={() => navigate('/purchase-orders/' + editingOrder.id)}
          onReload={reloadOrder}
          onApproved={() => {
            // Leaving the check re-reads the order, so it opens at its new stage.
            navigate('/purchase-orders/' + editingOrder.id);
            showToast(t('bcApprovedToast', { id: editingOrder.id }));
          }}
          showToast={showToast}
        />
      : <FormSkeleton fields={8} />)
    : editingOrder
    ? <DesktopEditOrder
        key={editingOrder.id + ':' + orderReloads}
        order={editingOrder}
        onCancel={() => { navigate('/purchase-orders'); setEditingOrder(null); }}
        onSaved={(msg) => { navigate('/purchase-orders'); setEditingOrder(null); showToast(msg); }}
        onReload={reloadOrder}
      />
    : loadingOrderId
      ? <FormSkeleton fields={8} />
      : <DesktopOrders onToast={(m) => showToast(m)} />;

  return (
    <div className={'app' + (boxCheck ? ' app-focus' : sidebarFolded ? ' sidebar-folded' : '')}>
      {!boxCheck && (
        <Sidebar view={view2} folded={sidebarFolded} onToggleFold={() => setSidebarFolded(!sidebarFolded)} />
      )}
      <main className="main">
        {!boxCheck && <Topbar />}
        {!boxCheck && <RolePreviewBanner />}
        <div className={'page'
          + (view2 === 'history' && boxCheck ? ' page-box-check' : '')
          + (view2 === 'history' && !editingOrder && !boxCheck ? ' page-history' : '')
          + (view2 === 'history' && editingOrder && !boxCheck ? ' page-order-edit' : '')
          + (view2 === 'market' ? ' page-market' : '')
          + (view2 === 'inventory' && !editingItemId ? ' page-inventory' : '')
          + (view2 === 'analysis' ? ' page-analysis' : '')
          + (view2 === 'dashboard' ? ' page-dashboard' : '')
          + (view2 === 'shipping' && shippingRoute?.kind === 'dashboard' ? ' page-shipping' : '')
          + (view2 === 'activity' ? ' page-activity' : '')}>
          {/* Inventory ▸ Analysis tab strip — shown on the list and the
              analysis tab, but not while editing a single item. */}
          {((view2 === 'inventory' && !editingItemId) || view2 === 'analysis') && (
            <div className="seg inv-tabs" role="tablist" aria-label={t('nav_inventory')}>
              <a
                role="tab" aria-selected={view2 === 'inventory'}
                className={view2 === 'inventory' ? 'active' : ''}
                href={hrefFor('/inventory')} onClick={onLinkClick('/inventory')}
              >{t('nav_inventory')}</a>
              <a
                role="tab" aria-selected={view2 === 'analysis'}
                className={view2 === 'analysis' ? 'active' : ''}
                href={hrefFor('/inventory/analysis')} onClick={onLinkClick('/inventory/analysis')}
              >{t('nav_analysis')}</a>
            </div>
          )}
          {/* One boundary for the whole page area: every view below except the
              dashboard is a lazy chunk, and they are mutually exclusive. */}
          <Suspense fallback={<FormSkeleton fields={8} />}>
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
            {view2 === 'shipping'   && shippingRoute && <DesktopShipping route={shippingRoute} showToast={showToast} />}
            {view2 === 'clients'    && <DesktopClients showToast={showToast} />}
            {view2 === 'market'     && <DesktopMarket />}
            {view2 === 'inventory'  && inventoryOrEdit}
            {view2 === 'analysis'   && <DesktopAnalysis />}
            {view2 === 'sellorders' && (
              <DesktopSellOrders onNewFromInventory={() => navigate('/inventory')} onToast={showToast} />
            )}
            {view2 === 'transfers' && <DesktopTransfers onToast={showToast} />}
            {view2 === 'websubmissions' && <DesktopWebSubmissions onToast={showToast} />}
            {view2 === 'activity'  && <DesktopActivity />}
            {view2 === 'payments'  && <DesktopPayments onToast={showToast} />}
            {view2 === 'internaltx' && <DesktopInternalTxns onToast={showToast} />}
            {view2 === 'tracker'   && <DesktopTracker showToast={showToast} />}
            {view2 === 'coordinator' && <DesktopCoordinator showToast={showToast} />}
            {view2 === 'accountPool' && <DesktopAccountPool />}
            {view2 === 'settings'   && <DesktopSettings showToast={showToast} />}
          </Suspense>
        </div>
      </main>

      {toast && (
        <div className="toast-wrap">
          <div className={'toast ' + toast.kind}>
            <Icon name={toast.kind === 'warn' ? 'alert' : 'check2'} size={16} />
            <span>{toast.msg}</span>
          </div>
        </div>
      )}

      {/* Keyed on the entry so the next problem in the queue mounts its own
          dialog — focus and the OK button belong to one message at a time. */}
      {errorDialog && (
        <ErrorDialog key={errorDialog.seq} content={errorDialog} onClose={dismissErrorDialog} />
      )}

      <TweaksPanel />
    </div>
  );
}

