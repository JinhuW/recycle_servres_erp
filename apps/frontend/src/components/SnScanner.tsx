import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { createFrameDecoder } from '../lib/qr';

type Props = {
  // Serials already on the line — scanning one of these reads as a duplicate.
  existing: string[];
  // Line qty; > 0 turns the tally into "n / qty" and auto-finishes at qty.
  target: number;
  // Fired with whatever was scanned this session (possibly []). Both Done and
  // ✕ commit — the scanner is live input, not a dialog with cancel semantics,
  // so a mis-tapped close never throws away captured serials.
  onDone: (scanned: string[]) => void;
};

// Batch QR scanner for serial numbers: no shutter — every code that enters the
// frame is decoded, deduped, and tallied until the user taps Done (or the
// tally reaches the line qty, which is completion by the serials-must-equal-qty
// rule, so the scanner finishes itself).
export function SnScanner({ existing, target, onDone }: Props) {
  const { t } = useT();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [torch, setTorch] = useState(false);
  const [scanned, setScanned] = useState<string[]>([]);
  const [lastHit, setLastHit] = useState<{ value: string; dup: boolean; tick: number } | null>(null);
  const [camError, setCamError] = useState(false);
  const [complete, setComplete] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seenRef = useRef<Set<string>>(new Set(existing));
  const scannedRef = useRef<string[]>([]);
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

  // Decode loop. A hit — new or duplicate — pauses decoding for a beat so one
  // physical code isn't re-read ten times while the user moves to the next
  // stick, and so the flash/toast gets its moment.
  useEffect(() => {
    if (!stream) return;
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
            coolUntil = performance.now() + 1100;
            if (seenRef.current.has(value)) {
              setLastHit({ value, dup: true, tick: performance.now() });
            } else {
              seenRef.current.add(value);
              scannedRef.current = [...scannedRef.current, value];
              setScanned(scannedRef.current);
              setLastHit({ value, dup: false, tick: performance.now() });
              navigator.vibrate?.(35);
              if (target > 0 && existing.length + scannedRef.current.length >= target) {
                setComplete(true);
                stop = true;
                window.setTimeout(() => onDoneRef.current(scannedRef.current), 900);
                return;
              }
            }
          }
        }
        timer = window.setTimeout(step, 160);
      };
      step();
    })();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [stream, target, existing.length]);

  const total = existing.length + scanned.length;
  const tally = target > 0 ? `${total} / ${target}` : t('snScanCount', { n: scanned.length });

  return (
    <div className="ph-cam-screen">
      <div className="ph-cam-top">
        <button
          onClick={() => onDone(scanned)}
          className="ph-cam-pill"
          style={{ background: 'rgba(255,255,255,0.12)' }}
          aria-label={t('done')}
        >
          <Icon name="x" size={14} />
        </button>
        <span className="ph-cam-pill">
          <Icon name="hash" size={12} /> {t('snScanTitle')}
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
            {stream && !complete && <div className="scan-line" />}
            {lastHit && !lastHit.dup && <div key={lastHit.tick} className="ph-snscan-flash" />}
          </div>
        )}

        {!camError && (
          <span
            className="ph-cam-pill"
            style={{
              position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
              fontVariantNumeric: 'tabular-nums',
              ...(complete ? { background: 'rgba(22,163,74,0.9)', borderColor: 'transparent' } : {}),
            }}
          >
            {complete ? <><Icon name="check2" size={13} /> {t('snScanAll', { n: total })}</> : tally}
          </span>
        )}

        {camError ? (
          <div className="cam-hint" style={{ top: '46%', whiteSpace: 'normal', maxWidth: '82%', textAlign: 'center', lineHeight: 1.5 }}>
            {t('snScanNoCamera')}
          </div>
        ) : lastHit && !complete ? (
          <div className="ph-snscan-toast" role="status">
            <Icon name={lastHit.dup ? 'info' : 'check2'} size={13} style={{ flexShrink: 0, color: lastHit.dup ? 'rgba(255,255,255,0.7)' : '#4ade80' }} />
            <span className="mono">{lastHit.value}</span>
            {lastHit.dup && <span style={{ color: 'rgba(255,255,255,0.7)', flexShrink: 0 }}>· {t('snScanDup')}</span>}
          </div>
        ) : !complete ? (
          <div className="cam-hint" style={{ bottom: 18 }}>{t('snScanHint')}</div>
        ) : null}
      </div>

      <div className="ph-cam-bottom">
        <button className="ph-snscan-done" onClick={() => onDone(scanned)}>
          <Icon name="check" size={16} /> {t('done')}{scanned.length > 0 ? ` · ${scanned.length}` : ''}
        </button>
      </div>
    </div>
  );
}
