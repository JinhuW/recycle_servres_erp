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

// Phases:
//   framing   — viewfinder open, waiting for shutter tap
//   capturing — starting the live camera (or simulated capture)
//   scanning  — image uploaded, OCR in flight
//   done      — got a result, showing the green pill briefly
type Phase = 'framing' | 'capturing' | 'scanning' | 'done';

export function Camera({ category, onDetected, onClose, onBack: _onBack }: Props) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('framing');
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Try to start the back camera. If it fails (desktop, no permission), we
  // fall back to a synthetic still that mimics the prototype's RAM-stick
  // illustration — the OCR call still runs against the stub so the flow is
  // demoable everywhere.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch {
        // Fine — we'll show the illustrated viewfinder instead.
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, []);

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
    }
  };

  const onShoot = async () => {
    setPhase('capturing');
    const blob = await captureFrame();
    if (!blob) { setPhase('framing'); setError('Camera unavailable'); return; }
    await runScan(blob);
  };

  const onUpload = () => fileInputRef.current?.click();
  const onFileChosen: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) runScan(f, f.name);
  };

  const liveCamera = !!streamRef.current;

  return (
    <div className="phone-app">
    <div className="ph-cam-screen">
      <div className="ph-cam-top">
        <button onClick={onClose} className="ph-cam-pill" style={{ background: 'rgba(255,255,255,0.12)' }}>
          <Icon name="x" size={14} />
        </button>
        <span className="ph-cam-pill">
          <span className="ai-dot" /> {t('aiScan')} · {category}
        </span>
        <button className="ph-cam-pill" style={{ background: 'rgba(255,255,255,0.12)', width: 36, padding: 0, height: 30, justifyContent: 'center' }}>
          <Icon name="flash" size={14} />
        </button>
      </div>

      <div className="ph-cam-stage">
        {liveCamera ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
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
        <button className="ph-cam-thumbsq" onClick={onUpload} title="Upload from library">
          <Icon name="upload" size={16} />
        </button>
        <button
          className="ph-cam-shutter"
          onClick={onShoot}
          disabled={phase !== 'framing'}
        />
        <button className="ph-cam-thumbsq" title="Switch camera">
          <Icon name="rotate" size={16} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onFileChosen}
      />
    </div>
    </div>
  );
}
