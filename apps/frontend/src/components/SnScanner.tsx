import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { api, ApiError } from '../lib/api';
import { captureCropJpeg, createFrameDecoder } from '../lib/qr';

type Props = {
  // Serials already on the line — scanning one of these reads as a duplicate
  // and keeps the scanner open instead of adding it twice.
  existing: string[];
  // Fired with the captured serial ([value]) the moment a new code decodes,
  // or [] when the user closes without a capture.
  onDone: (scanned: string[]) => void;
  // The chrome defaults to serial-number wording; the shipping scan overrides
  // it — "fit the QR code in the box" is the wrong aim hint for a 1D barcode.
  title?: string;
  hint?: string;
  // Offers the QR ↔ AI switch: a vision model reads the printed serial when
  // the code itself is too damaged to decode. Serial scans only — a tracking
  // label has no printed S/N to fall back on.
  aiRead?: boolean;
};

type Mode = 'qr' | 'ai';

// Single-shot QR scanner for serial numbers: no shutter — the first code that
// decodes flashes a confirmation and closes itself, handing the serial back
// to the form. Scanning the next stick is one tap on the field button again.
export function SnScanner({ existing, onDone, title, hint, aiRead = false }: Props) {
  const { t } = useT();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [torch, setTorch] = useState(false);
  const [lastHit, setLastHit] = useState<{ value: string; dup: boolean; tick: number } | null>(null);
  const [camError, setCamError] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);
  // Opens on QR every time: a damaged code is the exception, not the habit.
  const [mode, setMode] = useState<Mode>('qr');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  // A read that lands after the scanner closed must not touch its state.
  // Re-armed on mount: StrictMode's mount→unmount→mount would otherwise
  // leave it false for the scanner's whole life.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const existingRef = useRef<Set<string>>(new Set(existing));
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Rear camera only — that's where the labels are. Same acquire/attach split
  // as Camera.tsx: state so the <video> swaps in when the stream lands.
  useEffect(() => {
    let cancelled = false;
    let acquired: MediaStream | null = null;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCamError(true); return; }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          // Full sensor resolution, same as the label Camera — the QR on a
          // module is ~10 mm and needs every pixel it can get.
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            advanced: [{ focusMode: 'continuous' } as any],
          },
          audio: false,
        });
        if (cancelled) { s.getTracks().forEach(tr => tr.stop()); return; }
        acquired = s;
        setStream(s);
      } catch {
        if (!cancelled) setCamError(true);
      }
    })();
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach(tr => tr.stop());
      setStream(null);
    };
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
  }, [stream]);

  useEffect(() => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track.applyConstraints({ advanced: [{ torch } as any] }).catch(() => {});
  }, [torch, stream]);

  // Mild optical/digital zoom where the hardware offers it: the main lens
  // can't focus close enough to fill the frame with a 10 mm code, so 2×
  // roughly doubles the pixels on the code at the same working distance.
  useEffect(() => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (track.getCapabilities?.() ?? {}) as any;
    if (!caps.zoom?.max || caps.zoom.max <= 1) return;
    const zoom = Math.min(2, caps.zoom.max);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track.applyConstraints({ advanced: [{ zoom } as any] }).catch(() => {});
  }, [stream]);

  // Decode loop. A duplicate pauses decoding for a beat (so one physical code
  // isn't re-flagged ten times); a fresh serial stops the loop for good —
  // green flash, then the scanner closes itself with the value.
  useEffect(() => {
    if (!stream || mode !== 'qr') return;
    let stop = false;
    let timer = 0;
    let coolUntil = 0;
    (async () => {
      const decode = await createFrameDecoder();
      const step = async () => {
        if (stop) return;
        const v = videoRef.current;
        if (v && v.videoWidth && performance.now() >= coolUntil) {
          const value = await decode(v);
          if (stop) return;
          if (value) {
            if (existingRef.current.has(value)) {
              coolUntil = performance.now() + 1100;
              setLastHit({ value, dup: true, tick: performance.now() });
            } else {
              stop = true;
              finish(value);
              return;
            }
          }
        }
        timer = window.setTimeout(step, 160);
      };
      step();
    })();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [stream, mode]);

  const finish = (value: string) => {
    setCaptured(value);
    setLastHit({ value, dup: false, tick: performance.now() });
    navigator.vibrate?.(35);
    window.setTimeout(() => onDoneRef.current([value]), 650);
  };

  const switchMode = (next: Mode) => {
    if (aiBusy || captured) return;
    setMode(next);
    setAiResult(null);
    setAiNote(null);
    setLastHit(null);
  };

  const shoot = async () => {
    const v = videoRef.current;
    if (!v || aiBusy) return;
    setAiNote(null);
    setAiResult(null);
    setAiBusy(true);
    try {
      const blob = await captureCropJpeg(v);
      if (!blob) throw new Error('no frame');
      const form = new FormData();
      form.append('file', blob, 'serial.jpg');
      const r = await api.upload<{ serial: string | null }>('/api/scan/serial', form);
      if (!aliveRef.current) return;
      if (r.serial) setAiResult(r.serial);
      else setAiNote(t('snScanAiNone'));
    } catch (e) {
      if (!aliveRef.current) return;
      // The rate-limit message tells the user what to do; anything else is
      // "retake", whatever failed underneath.
      setAiNote(e instanceof ApiError && e.status === 429 ? e.message : t('snScanAiFailed'));
    } finally {
      if (aliveRef.current) setAiBusy(false);
    }
  };

  const shutterOff = aiBusy || !stream || !!aiResult || !!captured;

  // A model read is printed text, so case can differ from the QR payload of
  // a serial already on the line.
  const acceptAiResult = () => {
    if (!aiResult) return;
    const lower = aiResult.toLowerCase();
    if ([...existingRef.current].some(s => s.toLowerCase() === lower)) {
      setAiResult(null);
      setLastHit({ value: aiResult, dup: true, tick: performance.now() });
      return;
    }
    setAiResult(null);
    finish(aiResult);
  };

  return (
    <div className="ph-cam-screen">
      <div className="ph-cam-top">
        <button
          onClick={() => { if (!captured && !aiBusy) onDone([]); }}
          disabled={aiBusy}
          className="ph-cam-pill"
          style={{ background: 'rgba(255,255,255,0.12)' }}
          aria-label={t('cancel')}
        >
          <Icon name="x" size={14} />
        </button>
        <span className="ph-cam-pill">
          <Icon name="hash" size={12} /> {title ?? t('snScanTitle')}
        </span>
        <button
          className="ph-cam-pill"
          style={{ background: torch ? 'rgba(255,220,80,0.85)' : 'rgba(255,255,255,0.12)', width: 36, padding: 0, height: 30, justifyContent: 'center', color: torch ? '#1a1300' : 'white' }}
          onClick={() => setTorch(f => !f)}
          title={t('cameraFlash')}
        >
          <Icon name="flash" size={14} />
        </button>
      </div>

      <div className="ph-cam-stage">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%', objectFit: 'cover',
            opacity: stream ? 1 : 0,
            transition: 'opacity 0.15s ease-out',
          }}
        />
        {!camError && (
          <div className="ph-snscan-frame">
            {stream && !captured && mode === 'qr' && <div className="scan-line" />}
            {captured && <div className="ph-snscan-flash" />}
          </div>
        )}

        {camError ? (
          <div className="cam-hint" style={{ top: '46%', whiteSpace: 'normal', maxWidth: '82%', textAlign: 'center', lineHeight: 1.5 }}>
            {t('snScanNoCamera')}
          </div>
        ) : captured ? (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center' }}>
            <div style={{ background: 'white', color: 'var(--accent-strong)', padding: '12px 18px', borderRadius: 999, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, maxWidth: '84%' }}>
              <Icon name="check2" size={16} style={{ flexShrink: 0 }} />
              <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{captured}</span>
            </div>
          </div>
        ) : aiBusy ? (
          <div className="ph-snscan-toast" role="status">
            <span>{t('snScanAiReading')}</span>
          </div>
        ) : aiResult ? (
          <div className="ph-snscan-result" role="dialog" aria-label={t('snScanModeAi')}>
            <span className="mono">{aiResult}</span>
            <div className="ph-snscan-result-actions">
              <button className="ph-snscan-result-btn" onClick={() => setAiResult(null)}>{t('snScanAiRetake')}</button>
              <button className="ph-snscan-result-btn primary" onClick={acceptAiResult}>
                <Icon name="check2" size={14} /> {t('snScanAiUse')}
              </button>
            </div>
          </div>
        ) : aiNote ? (
          <div className="ph-snscan-toast" role="status">
            <Icon name="info" size={13} style={{ flexShrink: 0, color: 'rgba(255,255,255,0.7)' }} />
            <span>{aiNote}</span>
          </div>
        ) : lastHit?.dup ? (
          <div className="ph-snscan-toast" role="status">
            <Icon name="info" size={13} style={{ flexShrink: 0, color: 'rgba(255,255,255,0.7)' }} />
            <span className="mono">{lastHit.value}</span>
            <span style={{ color: 'rgba(255,255,255,0.7)', flexShrink: 0 }}>· {t('snScanDup')}</span>
          </div>
        ) : (
          <div className="cam-hint" style={{ bottom: 18 }}>
            {mode === 'ai' ? t('snScanAiHint') : hint ?? t('snScanHint')}
          </div>
        )}
      </div>

      {aiRead && !camError && (
        <div className="ph-snscan-mode" role="group">
          {(['qr', 'ai'] as const).map(m => (
            <button
              key={m}
              className={mode === m ? 'active' : undefined}
              aria-pressed={mode === m}
              disabled={aiBusy || !!captured}
              onClick={() => switchMode(m)}
            >
              {t(m === 'qr' ? 'snScanModeQr' : 'snScanModeAi')}
            </button>
          ))}
        </div>
      )}

      <div className="ph-cam-bottom">
        <button className="ph-snscan-done" disabled={aiBusy} onClick={() => { if (!captured && !aiBusy) onDone([]); }}>
          {t('cancel')}
        </button>
        {mode === 'ai' && (
          <button
            className="ph-cam-shutter"
            style={{ marginLeft: 16, flexShrink: 0, opacity: shutterOff ? 0.5 : 1 }}
            aria-label={t('snScanModeAi')}
            disabled={shutterOff}
            onClick={() => void shoot()}
          />
        )}
      </div>
    </div>
  );
}
