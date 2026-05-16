import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import type { Category, ScanResponse } from '../lib/types';

type Props = {
  category: Category;
  onDetected: (s: ScanResponse) => void;
  onClose: () => void;
  onBack?: () => void;
};

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

// Phases:
//   framing   — viewfinder open, waiting for shutter tap
//   capturing — starting the live camera (or simulated capture)
//   scanning  — image uploaded, OCR in flight
//   done      — got a result, showing the green pill briefly
type Phase = 'framing' | 'capturing' | 'scanning' | 'done';

export function Camera({ category, onDetected, onClose, onBack }: Props) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('framing');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  // Stream is state (not a ref) so acquiring it triggers a re-render and the
  // <video> swaps in over the illustrated placeholder.
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Data: URL of the just-captured/uploaded photo, frozen over the viewfinder
  // while we scan so the user sees the shot they took (not the live feed).
  const [captured, setCaptured] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Acquire the camera stream whenever facingMode changes. We only set state
  // here; attaching the stream to the <video> element happens in the effect
  // below, after the element is mounted.
  useEffect(() => {
    let cancelled = false;
    let acquired: MediaStream | null = null;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } },
          audio: false,
        });
        if (cancelled) { s.getTracks().forEach(t => t.stop()); return; }
        acquired = s;
        setStream(s);
      } catch {
        // Fine — we'll show the illustrated viewfinder instead.
      }
    })();
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach(t => t.stop());
      setStream(null);
    };
  }, [facingMode]);

  // Attach the stream to the <video> element once both exist. The element is
  // always mounted now, so videoRef.current is stable.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
  }, [stream]);

  // Apply the torch constraint when flash toggles or the stream changes. Most
  // desktop browsers and some mobile front-cameras don't support torch — we
  // swallow the rejection.
  useEffect(() => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track.applyConstraints({ advanced: [{ torch: flash === 'on' } as any] }).catch(() => {});
  }, [flash, stream]);

  const captureFrame = async (): Promise<Blob | null> => {
    const v = videoRef.current;
    if (v && v.videoWidth) {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0);
      return await new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', 0.85));
    }
    // No live camera — synthesize a tiny placeholder PNG so the upload still
    // succeeds. The stub OCR ignores the bytes anyway.
    const placeholder = new Blob([new Uint8Array([137,80,78,71,13,10,26,10])], { type: 'image/png' });
    return placeholder;
  };

  const runScan = async (file: File | Blob, filename = 'label.jpg') => {
    setPhase('scanning');
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file, filename);
      form.append('category', category);
      const res = await api.upload<ScanResponse>('/api/scan/label', form);
      setPhase('done');
      // brief celebratory pause before handing off to the form
      setTimeout(() => onDetected(res), 450);
    } catch (e) {
      setPhase('framing');
      setError(e instanceof Error ? e.message : 'Scan failed');
      setCaptured(null);
    }
  };

  const onShoot = async () => {
    setPhase('capturing');
    // Real frame only when the live camera produced pixels; otherwise
    // captureFrame returns a tiny placeholder we don't want to preview.
    const live = !!videoRef.current?.videoWidth;
    const blob = await captureFrame();
    if (!blob) { setPhase('framing'); setError('Camera unavailable'); return; }
    setCaptured(live ? await blobToDataUrl(blob) : null);
    await runScan(blob);
  };

  const onUpload = () => fileInputRef.current?.click();
  const onFileChosen: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setCaptured(await blobToDataUrl(f));
    runScan(f, f.name);
  };

  const liveCamera = !!stream;

  return (
    <div className="phone-app">
    <div className="ph-cam-screen">
      <div className="ph-cam-top">
        <button
          onClick={onBack ?? onClose}
          className="ph-cam-pill"
          style={{ background: 'rgba(255,255,255,0.12)' }}
          title={onBack ? t('signInBack') : t('cancel')}
        >
          <Icon name="x" size={14} />
        </button>
        <span className="ph-cam-pill">
          <span className="ai-dot" /> {t('aiScan')} · {category}
        </span>
        <button
          className="ph-cam-pill"
          style={{ background: flash === 'on' ? 'rgba(255,220,80,0.85)' : 'rgba(255,255,255,0.12)', width: 36, padding: 0, height: 30, justifyContent: 'center', color: flash === 'on' ? '#1a1300' : 'white' }}
          onClick={() => setFlash(f => f === 'on' ? 'off' : 'on')}
          title={t('cameraFlash')}
        >
          <Icon name="flash" size={14} />
        </button>
      </div>

      <div className="ph-cam-stage">
        {/* Video is always mounted so its ref is stable when we attach
            srcObject; the placeholder behind it only shows until the live
            stream resolves (or stays visible if the camera is unavailable). */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%', objectFit: 'cover',
            opacity: liveCamera ? 1 : 0,
            transition: 'opacity 0.15s ease-out',
          }}
        />
        {captured && (
          <img
            src={captured}
            alt="Captured label"
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%', objectFit: 'cover',
            }}
          />
        )}
        {!liveCamera && !captured && (
          <>
            <div className="cam-viewfinder" style={{ position: 'absolute', inset: 0 }} />
            {category === 'RAM' && (
              <div className="ram-stick">
                <div className="ram-label">
                  <div style={{ fontWeight: 600 }}>SAMSUNG</div>
                  <div>M393A4K40DB3-CWE</div>
                  <div>32GB 2Rx4 PC4-3200AA-RC3</div>
                  <div style={{ opacity: 0.7 }}>K4A8G045WC-BCWE</div>
                </div>
                <div className="ram-pins" />
              </div>
            )}
            {category === 'SSD' && (
              <div className="ram-stick" style={{ width: '70%', height: '32%', borderRadius: 8 }}>
                <div className="ram-label">
                  <div style={{ fontWeight: 600 }}>SAMSUNG SSD</div>
                  <div>MZ1L21T9HCLS-00A07</div>
                  <div>1.92TB NVMe PCIe 4.0</div>
                </div>
              </div>
            )}
            {category === 'HDD' && (
              <div className="ram-stick" style={{ width: '70%', height: '32%', borderRadius: 8 }}>
                <div className="ram-label">
                  <div style={{ fontWeight: 600 }}>SEAGATE HDD</div>
                  <div>ST4000NM0023</div>
                  <div>4TB SAS 7200rpm</div>
                </div>
              </div>
            )}
            {category === 'Other' && (
              <div className="ram-stick" style={{ width: '50%', height: '40%', borderRadius: 10 }}>
                <div className="ram-label" style={{ fontSize: 9 }}>
                  <div style={{ fontWeight: 600 }}>INTEL</div>
                  <div>XEON GOLD 6248</div>
                  <div>SRF90 · 2.5GHz</div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="cam-corners" style={{ position: 'absolute', inset: 24 }} />

        {phase === 'scanning' && <div className="scan-line" />}
        {phase === 'framing' && (
          <div className="cam-hint" style={{ bottom: 22 }}>{t('alignLabel')}</div>
        )}
        {phase === 'scanning' && (
          <div style={{ position: 'absolute', left: 16, top: 16, color: 'white', fontSize: 11, background: 'rgba(0,0,0,0.55)', padding: '6px 10px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ai-dot" /> {t('readingLabel')}
          </div>
        )}
        {phase === 'done' && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center' }}>
            <div style={{ background: 'white', color: 'var(--accent-strong)', padding: '12px 18px', borderRadius: 999, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="check2" size={16} /> {t('gotIt')}
            </div>
          </div>
        )}
        {error && (
          <div style={{ position: 'absolute', left: 16, right: 16, bottom: 70, color: 'white', fontSize: 12, background: 'rgba(180,40,40,0.85)', padding: '10px 12px', borderRadius: 10 }}>
            {error}
          </div>
        )}
      </div>

      <div className="ph-cam-bottom">
        <button className="ph-cam-thumbsq" onClick={onUpload} title={t('cameraUpload')}>
          <Icon name="upload" size={16} />
        </button>
        <button
          className="ph-cam-shutter"
          onClick={onShoot}
          disabled={phase !== 'framing'}
        />
        <button
          className="ph-cam-thumbsq"
          onClick={() => setFacingMode(m => m === 'environment' ? 'user' : 'environment')}
          title={t('cameraSwitch')}
        >
          <Icon name="rotate" size={16} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onFileChosen}
      />
    </div>
    </div>
  );
}
