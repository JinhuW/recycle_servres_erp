import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { PhTabBar, type View } from './components/PhTabBar';
import { PhCategorySheet } from './components/PhCategorySheet';
import { PhLanguageSheet } from './components/PhLanguageSheet';
import { PhNotificationsSheet } from './components/PhNotificationsSheet';
import { PhAboutSheet } from './components/PhAboutSheet';

import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Camera } from './pages/Camera';
import { SubmitForm } from './pages/SubmitForm';
import { OrderReview } from './pages/OrderReview';
import { Orders } from './pages/Orders';
import { Market } from './pages/Market';
import { Inventory } from './pages/Inventory';
import { Profile } from './pages/Profile';

import { useAuth } from './lib/auth';
import { useT, I18N } from './lib/i18n';
import { api, createDraftOrder, deleteOrder } from './lib/api';
import {
  navigate, useRoute,
  MOBILE_VIEW_TO_PATH, pathToMobileView,
} from './lib/route';
import type { Category, DraftLine, Notification, Order, ScanResponse } from './lib/types';
import { buildOrderSubmit } from './lib/orderSubmit';

type ReturnTo = 'idle' | 'review';

type CaptureState =
  | { phase: 'idle' }
  | { phase: 'category' }
  | { phase: 'camera';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; editingLineIdx?: number | null; returnTo: ReturnTo; draftId?: string }
  | { phase: 'form';    category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; editingLineIdx?: number | null; returnTo: ReturnTo; draftId?: string }
  | { phase: 'review';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; draftId?: string };

type Toast = { msg: string; kind: 'success' | 'error' };

function Shell() {
  const { user, loading, logout } = useAuth();
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
  const [toast, setToast] = useState<Toast | null>(null);
  const [langSheet, setLangSheet] = useState(false);
  const [notifSheet, setNotifSheet] = useState(false);
  const [aboutSheet, setAboutSheet] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);

  // Load notifications when the user is signed in.
  useEffect(() => {
    if (!user) return;
    api.get<{ items: Notification[] }>('/api/notifications')
      .then(r => setNotifs(r.items))
      .catch(console.error);
  }, [user?.id]);

  const showToast = (msg: string, kind: Toast['kind'] = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  };

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

  const pickCategory = (cat: Category) => {
    setCapture({ phase: 'form', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
    createDraftOrder(cat)
      .then(r => setCapture(c => c.phase === 'idle' ? c : { ...c, draftId: r.id }))
      .catch(() => showToast('Could not start a draft order — retry.', 'error'));
  };

  const onDetected = (s: ScanResponse) => {
    setCapture(c => c.phase === 'camera' ? { ...c, phase: 'form', detected: s } : c);
  };

  // Maps a DraftLine to the wire shape for PATCH /api/orders/:id addLines.
  const toWireLine = (l: DraftLine) => ({
    category: l.category,
    brand: l.brand ?? null,
    capacity: l.capacity ?? null,
    type: l.type ?? null,
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

  // A line is ready to persist once it has identity (brand or description for
  // Other), a positive qty, and a non-negative unit cost.
  const lineReady = (l: DraftLine) => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost);
    const hasIdentity = l.category === 'Other' ? !!l.description : !!l.brand;
    return qty > 0 && cost >= 0 && hasIdentity;
  };

  const onSaveLine = (line: DraftLine) => {
    // Capture current state synchronously so we can read draftId and compute
    // the new lines array before the async PATCH.
    if (capture.phase !== 'form') return;
    const { draftId, editingLineIdx, category, editingId, originalLineIds } = capture;

    // Build the updated lines array.
    const newLines = (editingLineIdx != null)
      ? capture.lines.map((l, i) => i === editingLineIdx ? line : l)
      : [...capture.lines, line];

    // Index of the newly saved line in the newLines array.
    const savedIdx = editingLineIdx != null ? editingLineIdx : newLines.length - 1;

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

    // If the line was already confirmed (re-edit), skip re-persisting.
    if (line._confirmed) return;

    // Only persist valid lines; silently skip invalid ones (they stay locally
    // unconfirmed and will be sent on final submit).
    if (!lineReady(line) || !draftId) return;

    api.patch('/api/orders/' + draftId, { addLines: [toWireLine(line)] })
      .then(() => {
        setCapture(c => {
          if (c.phase !== 'review') return c;
          const updated = c.lines.map((l, i) =>
            i === savedIdx ? { ...l, _confirmed: true } : l,
          );
          return { ...c, lines: updated };
        });
      })
      .catch(() => {
        // Keep the line locally unconfirmed; it will be sent on final submit.
        showToast('Line saved locally — could not sync to server.', 'error');
      });
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

  const rescanRam = () => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      return {
        phase: 'camera', category: c.category, detected: null, lines: c.lines,
        editingId: c.editingId, originalLineIds: c.originalLineIds, editingLineIdx: c.editingLineIdx ?? null, returnTo: c.returnTo,
        draftId: c.draftId,
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
      setCapture({ phase: 'idle' });
      // setView('history') navigates to /purchase-orders; if the user arrived
      // via a /purchase-orders/:id deep link, this also clears the id.
      setView('history');
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
        label: l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}`.trim()
              : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
              : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
              : (l.description ?? 'Item'),
      })),
    });
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="phone-app" style={{ display: 'grid', placeItems: 'center', color: 'var(--fg-subtle)' }}>Loading…</div>;
  }

  if (!user) return <Login />;

  // Full-screen camera/form/review intercept the normal tab UI
  if (capture.phase === 'camera') {
    return (
      <Camera
        category={capture.category}
        onDetected={onDetected}
        onClose={cancelCapture}
        onBack={goBack}
      />
    );
  }
  if (capture.phase === 'form') {
    const existing = capture.editingLineIdx != null ? capture.lines[capture.editingLineIdx] : undefined;
    return (
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
      />
    );
  }
  if (capture.phase === 'review') {
    return (
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
      {view === 'history' && <Orders onEdit={startEdit} onToast={showToast} />}
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
