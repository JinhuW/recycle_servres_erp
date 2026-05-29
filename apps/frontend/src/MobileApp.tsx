import { useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { PhTabBar, type View } from './components/PhTabBar';
import { PhCategorySheet } from './components/PhCategorySheet';
import { PhDraftPickerSheet } from './components/PhDraftPickerSheet';
import { PhLanguageSheet } from './components/PhLanguageSheet';
import { PhNotificationsSheet } from './components/PhNotificationsSheet';
import { PhAboutSheet } from './components/PhAboutSheet';

import { Login } from './pages/Login';
import { RolePicker } from './pages/RolePicker';
import { Dashboard } from './pages/Dashboard';
import { Camera } from './pages/Camera';
import { SubmitForm } from './pages/SubmitForm';
import { OrderReview } from './pages/OrderReview';
import { Orders } from './pages/Orders';
import { OrderDetail } from './pages/OrderDetail';
import { Market } from './pages/Market';
import { Inventory } from './pages/Inventory';
import { Profile } from './pages/Profile';

import { useAuth } from './lib/auth';
import { useT, I18N } from './lib/i18n';
import { api, ApiError, createDraftOrder, deleteOrder } from './lib/api';
import { handleFetchError, showErrorToast } from './lib/errorToast';
import {
  navigate, useRoute, match,
  MOBILE_VIEW_TO_PATH, pathToMobileView,
} from './lib/route';
import type { Category, DraftLine, Notification, Order, OrderSummary, ScanResponse } from './lib/types';
import { buildOrderSubmit } from './lib/orderSubmit';
import { findDuplicateLine } from './lib/dupParts';

type ReturnTo = 'idle' | 'review';

type CaptureState =
  | { phase: 'idle' }
  | { phase: 'category' }
  | { phase: 'draftPicker'; category: Category; drafts: OrderSummary[] }
  | { phase: 'camera';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; editingLineIdx?: number | null; returnTo: ReturnTo; draftId?: string; rescanDraft?: DraftLine | null }
  | { phase: 'form';    category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; editingLineIdx?: number | null; returnTo: ReturnTo; draftId?: string; rescanDraft?: DraftLine | null }
  | { phase: 'review';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; draftId?: string };

type Toast = { msg: string; kind: 'success' | 'error' };

function Shell() {
  const { user, loading, logout, pendingRoleChoice } = useAuth();
  const { t } = useT();
  const { path } = useRoute();
  const view: View = pathToMobileView(path);
  // The 'submit' tab triggers the capture flow (onCenterPress) and has no
  // URL of its own, so we ignore it here.
  const setView = (v: View) => {
    if (v === 'submit') return;
    navigate(MOBILE_VIEW_TO_PATH[v]);
  };
  // Lock body overflow on mobile so the phone shell behaves like a native screen.
  useEffect(() => {
    document.body.classList.add('phone-mode');
    document.body.classList.remove('desktop');
    return () => { document.body.classList.remove('phone-mode'); };
  }, []);
  const [capture, setCapture] = useState<CaptureState>({ phase: 'idle' });
  // The draft order is created asynchronously when the flow starts, so the form
  // is shown before its id lands in `capture`. Hold the in-flight creation here
  // so a fast Save can await the id instead of silently dropping the line to
  // local-only (it would then only reach the DB on final submit).
  const draftIdPromise = useRef<Promise<string | null> | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [langSheet, setLangSheet] = useState(false);
  const [notifSheet, setNotifSheet] = useState(false);
  const [aboutSheet, setAboutSheet] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);
  const orderDetailMatch = match('/purchase-orders/:id', path);

  // Load notifications when the user is signed in.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api.get<{ items: Notification[] }>('/api/notifications')
      .then(r => { if (alive) setNotifs(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [user?.id]);

  // Drive the order-detail screen from the URL. Suspended while a capture
  // flow is active so the camera/form/review screens take over the shell.
  useEffect(() => {
    if (!orderDetailMatch || capture.phase !== 'idle') {
      if (detailOrder) setDetailOrder(null);
      return;
    }
    if (detailOrder?.id === orderDetailMatch.id) return;
    let alive = true;
    api.get<{ order: Order }>(`/api/orders/${orderDetailMatch.id}`)
      .then(r => { if (alive) setDetailOrder(r.order); })
      .catch((err) => {
        if (!alive) return;
        // Clear the unreachable URL so the failing fetch doesn't re-fire on
        // every re-render, and tell the user why nothing opened. Common case:
        // a manager in role-preview mode follows a link to a PO they don't own.
        navigate('/purchase-orders');
        const status = err instanceof ApiError ? err.status : 0;
        showErrorToast(
          status === 403 ? "You don't have access to this purchase order."
          : status === 404 ? 'That purchase order no longer exists.'
          : 'Could not open that purchase order.',
        );
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, capture.phase]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const showToast = (msg: string, kind: Toast['kind'] = 'success') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  // Register the global toast hook so `handleFetchError` / `showErrorToast` in
  // lib/errorToast.ts can surface errors from anywhere without prop-drilling.
  useEffect(() => {
    window.__showToast = (msg, kind) => {
      setToast({ msg, kind: kind === 'error' ? 'error' : 'success' });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 2600);
    };
    return () => { delete window.__showToast; };
  }, []);

  // ── Capture flow handlers ────────────────────────────────────────────────
  const startSubmit = () => setCapture({ phase: 'category' });
  const cancelCapture = () => {
    // Best-effort delete an abandoned empty draft (nothing confirmed = no real
    // inventory rows were written). Safe: backend 409s if lifecycle != 'draft'.
    if (
      capture.phase === 'camera' ||
      capture.phase === 'form' ||
      capture.phase === 'review'
    ) {
      const { draftId, lines } = capture;
      if (draftId && !lines.some(l => l._confirmed)) {
        deleteOrder(draftId).catch(() => {/* best-effort */});
      }
    }
    setCapture({ phase: 'idle' });
    if (window.location.hash.startsWith('#/purchase-orders/')) {
      navigate('/purchase-orders');
    }
  };

  // Probe for in-progress drafts in this category before silently spawning a
  // fresh one. Without this gate every scan session piles up another empty
  // draft on the server.
  const pickCategory = async (cat: Category) => {
    try {
      const r = await api.get<{ orders: OrderSummary[] }>(
        `/api/orders?category=${encodeURIComponent(cat)}&status=Draft&limit=20`,
      );
      if (r.orders.length > 0) {
        setCapture({ phase: 'draftPicker', category: cat, drafts: r.orders });
        return;
      }
    } catch {
      // Fall through to a new draft — better to let them work than block on a
      // probe failure.
    }
    startNewDraft(cat);
  };

  const startNewDraft = (cat: Category) => {
    setCapture({ phase: 'form', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
    draftIdPromise.current = createDraftOrder(cat)
      .then(r => {
        setCapture(c => c.phase === 'idle' ? c : { ...c, draftId: r.id });
        return r.id;
      })
      .catch(() => {
        showToast('Could not start a draft order — retry.', 'error');
        return null;
      });
  };

  // Reopen an existing draft on the review screen so the user sees the lines
  // they've already accumulated; "Add another item" then routes them back into
  // the scan/form path with the draft id carried through, so new lines merge
  // into the same PO instead of a fresh one.
  const resumeDraft = async (summary: OrderSummary) => {
    try {
      const r = await api.get<{ order: Order }>(`/api/orders/${summary.id}`);
      startEdit(r.order);
    } catch {
      showToast('Could not open draft — retry.', 'error');
    }
  };

  const onDetected = (s: ScanResponse) => {
    if (capture.phase === 'camera') {
      const pn = (s.extracted?.partNumber as string | undefined) ?? '';
      const dupLine = findDuplicateLine(capture.lines, pn);
      if (dupLine != null && pn) {
        // Surface the alert immediately. The form still opens so the user
        // can compare against the existing line and decide whether to save.
        showToast(t('dupPartScanWarn', { pn, line: dupLine }), 'error');
      }
    }
    setCapture(c => c.phase === 'camera' ? { ...c, phase: 'form', detected: s } : c);
  };

  // Maps a DraftLine to the wire shape for PATCH /api/orders/:id addLines.
  const toWireLine = (l: DraftLine) => ({
    category: l.category,
    brand: l.brand ?? null,
    capacity: l.capacity ?? null,
    type: l.type ?? null,
    generation: l.generation ?? null,
    classification: l.classification ?? null,
    rank: l.rank ?? null,
    speed: l.speed ?? null,
    interface: l.interface ?? null,
    formFactor: l.formFactor ?? null,
    description: l.description ?? null,
    partNumber: l.partNumber ?? null,
    condition: l.condition ?? 'Pulled — Tested',
    qty: Number(l.qty) || 1,
    unitCost: Number(l.unitCost) || 0,
    health: l.health ?? null,
    rpm: l.rpm ?? null,
    status: 'In Transit' as const,
    scanImageId: l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  });

  // Returns the reason a line can't be auto-saved to the server yet, or null
  // when it's ready (identity — brand, or description for Other — a positive
  // qty, and a non-negative unit cost). Surfaced to the user so a line never
  // fails to sync silently.
  const lineSyncBlock = (l: DraftLine): string | null => {
    const hasIdentity = l.category === 'Other' ? !!l.description : !!l.brand;
    if (!hasIdentity) return l.category === 'Other' ? t('syncNeedDescription') : t('syncNeedBrand');
    if (!((Number(l.qty) || 0) > 0)) return t('syncNeedQty');
    if (!(Number(l.unitCost) >= 0)) return t('syncNeedCost');
    return null;
  };

  const onSaveLine = async (line: DraftLine) => {
    // Capture current state synchronously so we can read draftId and compute
    // the new lines array before the async PATCH.
    if (capture.phase !== 'form') return;
    const { draftId, editingLineIdx, category, editingId, originalLineIds } = capture;

    // Build the updated lines array.
    const newLines = (editingLineIdx != null)
      ? capture.lines.map((l, i) => i === editingLineIdx ? line : l)
      : [...capture.lines, line];

    // Move to review immediately (optimistic UI).
    setCapture({
      phase: 'review',
      category,
      detected: null,
      lines: newLines,
      editingId,
      originalLineIds,
      draftId,
    });

    // If the line was already confirmed (re-edit), nothing to persist again.
    if (line._confirmed) return;

    // Editing an existing order appends new lines on final submit (they carry
    // no draft id), so there's nothing to autosave per-line in that flow.
    if (editingId) return;

    // Never skip silently: if the line isn't complete enough to persist, tell
    // the user exactly which field is missing.
    const blocked = lineSyncBlock(line);
    if (blocked) {
      showToast(blocked, 'error');
      return;
    }

    // The draft is created asynchronously when the flow starts, so on a fast
    // Save draftId may not be in state yet — await the in-flight creation
    // instead of dropping the line to local-only.
    const did = draftId ?? (draftIdPromise.current ? await draftIdPromise.current : null);
    if (!did) {
      showToast(t('syncNoDraft'), 'error');
      return;
    }

    try {
      await api.patch('/api/orders/' + did, { addLines: [toWireLine(line)] });
      // Match by stable client id, not array index: the user may have added,
      // removed, or navigated past this line before the PATCH resolved.
      setCapture(c => {
        if (c.phase === 'idle' || c.phase === 'category' || c.phase === 'draftPicker') return c;
        const updated = c.lines.map(l => l._cid === line._cid ? { ...l, _confirmed: true } : l);
        return { ...c, lines: updated };
      });
    } catch {
      // Keep the line locally unconfirmed; it will be sent on final submit.
      showToast(t('syncFailed'), 'error');
    }
  };

  const addAnotherItem = () => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return { phase: 'form', category: c.category, detected: null, lines: c.lines, editingId: c.editingId, originalLineIds: c.originalLineIds, editingLineIdx: null, returnTo: 'review', draftId: c.draftId };
    });
  };

  const editLine = (idx: number) => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return {
        phase: 'form',
        category: c.category,
        detected: null,
        lines: c.lines,
        editingId: c.editingId,
        originalLineIds: c.originalLineIds,
        editingLineIdx: idx,
        returnTo: 'review',
        draftId: c.draftId,
      };
    });
  };

  const goBack = () => {
    setCapture(c => {
      if (c.phase !== 'camera' && c.phase !== 'form') return c;
      if (c.returnTo === 'review') {
        return { phase: 'review', category: c.category, detected: null, lines: c.lines, editingId: c.editingId, originalLineIds: c.originalLineIds, draftId: c.draftId };
      }
      return { phase: 'idle' };
    });
  };

  // Re-open the Camera page from the RAM form. The in-progress draft is
  // carried through so the new scan merges into it (auto-fill semantics)
  // rather than rebuilding the line from scratch.
  const rescanRam = (draft: DraftLine) => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      return {
        phase: 'camera', category: c.category, detected: null, lines: c.lines,
        editingId: c.editingId, originalLineIds: c.originalLineIds, editingLineIdx: c.editingLineIdx ?? null,
        returnTo: c.returnTo, draftId: c.draftId, rescanDraft: draft,
      };
    });
  };

  const removeLine = (idx: number) => {
    setCapture(c => c.phase === 'review' ? { ...c, lines: c.lines.filter((_, i) => i !== idx) } : c);
  };

  const submitOrder = async (meta: { warehouseId: string; payment: 'company' | 'self'; notes: string; totalCost: number }) => {
    if (capture.phase !== 'review') return;

    // Editing an existing order PATCHes that order; finalizing a new draft
    // PATCHes the draft. Submitting from review never creates a new order.
    const req = buildOrderSubmit(
      {
        editingId: capture.editingId,
        draftId: capture.draftId,
        category: capture.category,
        lines: capture.lines,
        originalLineIds: capture.originalLineIds,
      },
      meta,
    );
    if (req.kind === 'error') {
      showToast(req.message, 'error');
      return;
    }
    try {
      await api.patch(req.url, req.body);
      const editingId = capture.editingId;
      setCapture({ phase: 'idle' });
      if (editingId) {
        // Editing an existing order — return to its detail screen so the user
        // sees their updated line items in context with the lifecycle/log.
        navigate('/purchase-orders/' + editingId);
      } else {
        setView('history');
      }
      showToast(t('orderSubmitted'));
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Submit failed', 'error');
    }
  };

  const startEdit = (o: Order) => {
    setCapture({
      phase: 'review',
      category: o.category,
      detected: null,
      editingId: o.id,
      originalLineIds: o.lines.map(l => l.id),
      lines: o.lines.map(l => ({
        id: l.id,
        category: l.category,
        brand: l.brand,
        capacity: l.capacity,
        type: l.type,
        generation: l.generation,
        classification: l.classification,
        rank: l.rank,
        speed: l.speed,
        interface: l.interface,
        formFactor: l.formFactor,
        description: l.description,
        partNumber: l.partNumber,
        condition: l.condition,
        qty: l.qty,
        unitCost: l.unitCost,
        sellPrice: l.sellPrice ?? null,
        scanImageId: l.scanImageId,
        scanConfidence: l.scanConfidence,
        scanImageUrl: l.scanImageUrl,
        health: l.health,
        rpm: l.rpm,
        label: l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()
              : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
              : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
              : (l.description ?? 'Item'),
      })),
    });
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="phone-app" style={{ display: 'grid', placeItems: 'center', color: 'var(--fg-subtle)' }}>{t('loadingApp')}</div>;
  }

  if (!user) return <Login />;
  // Fresh manager login: gate the app until they pick a role to enter as.
  if (pendingRoleChoice && user.role === 'manager') return <RolePicker variant="mobile" />;

  // Full-screen camera/form/review intercept the normal tab UI
  // The capture-flow screens (camera/form/review) are early returns, so the
  // toast block in the main shell below never mounts while they're on screen —
  // every error raised during scan / line-save / submit was set into state but
  // rendered nowhere, leaving buttons that look like they did nothing. Render
  // the toast alongside each of these screens too. Fixed positioning anchors
  // it to the viewport regardless of which screen's root is mounted.
  const toastEl = toast && (
    <div className="ph-toast-wrap" style={{ position: 'fixed', left: 16, right: 16, bottom: 96, display: 'flex', justifyContent: 'center', zIndex: 50 }}>
      <div className={'ph-toast ' + (toast.kind || '')}>
        <Icon name="check2" size={14} /><span>{toast.msg}</span>
      </div>
    </div>
  );

  if (capture.phase === 'camera') {
    return (
      <>
        <Camera
          category={capture.category}
          onDetected={onDetected}
          onClose={cancelCapture}
          onBack={goBack}
        />
        {toastEl}
      </>
    );
  }
  if (capture.phase === 'form') {
    const existing = capture.editingLineIdx != null ? capture.lines[capture.editingLineIdx] : undefined;
    return (
      <>
        <SubmitForm
          category={capture.category}
          detected={capture.detected}
          lineCount={capture.lines.length}
          editingLineIdx={capture.editingLineIdx ?? null}
          existingLine={existing}
          onSaveLine={onSaveLine}
          onCancel={cancelCapture}
          onBack={goBack}
          onRescan={rescanRam}
          rescanDraft={capture.rescanDraft ?? null}
        />
        {toastEl}
      </>
    );
  }
  if (capture.phase === 'review') {
    return (
      <>
        <OrderReview
          category={capture.category}
          lines={capture.lines}
          editingId={capture.editingId}
          onAddItem={addAnotherItem}
          onEditLine={editLine}
          onRemoveLine={removeLine}
          onSubmit={submitOrder}
          onCancel={cancelCapture}
        />
        {toastEl}
      </>
    );
  }

  const unreadCount = notifs.filter(n => n.unread).length;

  return (
    <div className="phone-app">
      {view === 'dashboard' && (
        <Dashboard
          goSubmit={startSubmit}
          goHistory={() => setView('history')}
          onOpenNotifications={() => setNotifSheet(true)}
          unreadCount={unreadCount}
        />
      )}
      {view === 'history' && orderDetailMatch && detailOrder && (
        <OrderDetail
          order={detailOrder}
          onCancel={() => navigate('/purchase-orders')}
          onSaved={(msg) => showToast(msg)}
          onDeleted={() => navigate('/purchase-orders')}
          onEditItems={(o) => startEdit(o)}
        />
      )}
      {view === 'history' && (!orderDetailMatch || !detailOrder) && (
        <Orders onEdit={(o) => navigate('/purchase-orders/' + o.id)} onToast={showToast} />
      )}
      {view === 'market' && <Market />}
      {view === 'inventory' && <Inventory onNewEntry={startSubmit} />}
      {view === 'me' && (
        <Profile
          onOpenLanguage={() => setLangSheet(true)}
          onOpenNotifications={() => setNotifSheet(true)}
          onOpenAbout={() => setAboutSheet(true)}
          onOpenSecurity={() => showToast(t('securityNoticeBody'))}
        />
      )}

      {capture.phase === 'category' && (
        <PhCategorySheet onPick={pickCategory} onClose={cancelCapture} />
      )}

      {capture.phase === 'draftPicker' && (
        <PhDraftPickerSheet
          category={capture.category}
          drafts={capture.drafts}
          onResume={resumeDraft}
          onStartNew={() => startNewDraft(capture.category)}
          onClose={cancelCapture}
        />
      )}

      {notifSheet && (
        <PhNotificationsSheet
          items={notifs}
          onClose={() => setNotifSheet(false)}
          onMarkAllRead={async () => {
            setNotifs(ns => ns.map(n => ({ ...n, unread: false })));
            try { await api.post('/api/notifications/mark-read', {}); } catch {}
          }}
        />
      )}

      {aboutSheet && <PhAboutSheet onClose={() => setAboutSheet(false)} />}

      {langSheet && (
        <PhLanguageSheet onClose={(picked) => {
          setLangSheet(false);
          if (picked) showToast(I18N[picked].saved);
        }} />
      )}

      <PhTabBar view={view} setView={setView} onCenterPress={startSubmit} role={user.role} />

      {toast && (
        <div className="ph-toast-wrap" style={{ position: 'absolute', left: 16, right: 16, bottom: 96, display: 'flex', justifyContent: 'center', zIndex: 50 }}>
          <div className={'ph-toast ' + (toast.kind || '')}>
            <Icon name="check2" size={14} /><span>{toast.msg}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// MobileApp is mounted by App.tsx when the viewport is phone-sized.
// LangProvider is set up at the top of App.tsx so both shells share state.
export function MobileApp() {
  return <Shell />;
}
