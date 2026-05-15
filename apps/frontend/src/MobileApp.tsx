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
import { api } from './lib/api';
import {
  navigate, useRoute,
  MOBILE_VIEW_TO_PATH, pathToMobileView,
} from './lib/route';
import type { Category, DraftLine, Notification, Order, ScanResponse } from './lib/types';

type ReturnTo = 'idle' | 'review';

type CaptureState =
  | { phase: 'idle' }
  | { phase: 'category' }
  | { phase: 'camera';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; editingLineIdx?: number | null; returnTo: ReturnTo }
  | { phase: 'form';    category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; editingLineIdx?: number | null; returnTo: ReturnTo }
  | { phase: 'review';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null };

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
    setCapture({ phase: 'idle' });
    if (window.location.hash.startsWith('#/purchase-orders/')) {
      navigate('/purchase-orders');
    }
  };

  const pickCategory = (cat: Category) => {
    if (cat === 'RAM') {
      setCapture({ phase: 'camera', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
    } else {
      setCapture({ phase: 'form', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
    }
  };

  const onDetected = (s: ScanResponse) => {
    setCapture(c => c.phase === 'camera' ? { ...c, phase: 'form', detected: s } : c);
  };

  const onSaveLine = (line: DraftLine) => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      const lines = (c.editingLineIdx != null)
        ? c.lines.map((l, i) => i === c.editingLineIdx ? line : l)
        : [...c.lines, line];
      return {
        phase: 'review',
        category: c.category,
        detected: null,
        lines,
        editingId: c.editingId,
      };
    });
  };

  const addAnotherItem = () => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return c.category === 'RAM'
        ? { phase: 'camera', category: c.category, detected: null, lines: c.lines, editingId: c.editingId, editingLineIdx: null, returnTo: 'review' }
        : { phase: 'form',   category: c.category, detected: null, lines: c.lines, editingId: c.editingId, editingLineIdx: null, returnTo: 'review' };
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
        editingLineIdx: idx,
        returnTo: 'review',
      };
    });
  };

  const goBack = () => {
    setCapture(c => {
      if (c.phase !== 'camera' && c.phase !== 'form') return c;
      if (c.returnTo === 'review') {
        return { phase: 'review', category: c.category, detected: null, lines: c.lines, editingId: c.editingId };
      }
      return { phase: 'idle' };
    });
  };

  const rescanRam = () => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      return {
        phase: 'camera', category: c.category, detected: null, lines: c.lines,
        editingId: c.editingId, editingLineIdx: c.editingLineIdx ?? null, returnTo: c.returnTo,
      };
    });
  };

  const removeLine = (idx: number) => {
    setCapture(c => c.phase === 'review' ? { ...c, lines: c.lines.filter((_, i) => i !== idx) } : c);
  };

  const submitOrder = async (meta: { warehouseId: string; payment: 'company' | 'self'; notes: string; totalCost: number }) => {
    if (capture.phase !== 'review') return;
    try {
      await api.post('/api/orders', {
        category: capture.category,
        warehouseId: meta.warehouseId,
        payment: meta.payment,
        notes: meta.notes,
        totalCost: meta.totalCost,
        lines: capture.lines.map(l => ({
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
          condition: l.condition ?? 'Pulled — Tested',
          qty: l.qty,
          unitCost: l.unitCost,
          sellPrice: l.sellPrice ?? null,
          scanImageId: l.scanImageId ?? null,
          scanConfidence: l.scanConfidence ?? null,
        })),
      });
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
