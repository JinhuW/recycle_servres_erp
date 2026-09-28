import { useCallback, useEffect, useRef, useState } from 'react';
import {
  findRamStickInPhoto, padStickBox, SEGMENT_TARGET_LONG_SIDE, type SheetBox,
} from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { compressForUpload } from '../../../lib/image-compress';
import { cropToBox } from '../../../lib/sheetImage';
import {
  SAMPLE_INTERVAL_MS, analyzeFrame, initialAutoCapture, initialBoxTrack, pickCamera, sampleRect,
  stepAutoCapture, trackBox,
  type AutoCaptureState, type BoxTrack, type CameraDevice, type FrameBox,
} from '../../../lib/deskScan';
import { useT } from '../../../lib/i18n';
import { usePreference } from '../../../lib/preferences';

// The preference validator caps strings at 64; a longer label would 400 the
// whole preferences batch, so such a camera just isn't remembered.
const MAX_LABEL = 64;

// The green-PCB stick in a w×h source, padded so the gold fingers survive, or
// null. Detection runs on an ~800-px copy drawn into `scratch`.
function detectStick(
  src: CanvasImageSource, w: number, h: number, scratch: HTMLCanvasElement,
): SheetBox | null {
  const k = Math.min(1, SEGMENT_TARGET_LONG_SIDE / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * k));
  const dh = Math.max(1, Math.round(h * k));
  if (scratch.width !== dw || scratch.height !== dh) {
    scratch.width = dw;
    scratch.height = dh;
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, dw, dh);
  const img = ctx.getImageData(0, 0, dw, dh);
  const stick = findRamStickInPhoto({ data: img.data, width: dw, height: dh });
  return stick ? padStickBox(stick, w, h) : null;
}

// Live camera for the line drawer's label scan — meant for an iPhone mounted
// over the desk as the Mac's Continuity Camera. Watches the feed and, once a
// label is in view, still and in focus, captures one full-resolution frame
// and hands it to `onCapture` without a click.
export function DeskCamera({ busy, onCapture, onClose }: {
  busy: boolean;
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [savedLabel, setSavedLabel] = usePreference('scan.cameraLabel', '');
  const [autoOpen, setAutoOpen] = usePreference('scan.deskCamera', false);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [progress, setProgress] = useState(0);
  const [flash, setFlash] = useState(false);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  // The box on screen: the tracked stick, or the default when none is found.
  const [shown, setShown] = useState<{ box: FrameBox; locked: boolean }>(() => {
    const t = initialBoxTrack();
    return { box: t.box, locked: t.locked };
  });
  const trackRef = useRef<BoxTrack>(initialBoxTrack());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const savedLabelRef = useRef(savedLabel);
  savedLabelRef.current = savedLabel;
  // Once someone picks from the list, a device plugging in mustn't override it.
  const chosenByHandRef = useRef(false);
  const autoRef = useRef<AutoCaptureState>(initialAutoCapture());
  const audioRef = useRef<AudioContext | null>(null);

  // Labels are blank until camera permission is granted, so ask once with any
  // camera before listing. Continuity Camera can connect late, hence the
  // devicechange re-list.
  useEffect(() => {
    let cancelled = false;
    const list = async () => {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      const cams = all
        .filter(d => d.kind === 'videoinput')
        .map(d => ({ deviceId: d.deviceId, label: d.label }));
      setDevices(cams);
      setDeviceId(cur => {
        const stillThere = cur != null && cams.some(c => c.deviceId === cur);
        if (stillThere && chosenByHandRef.current) return cur;
        return pickCamera(cams, savedLabelRef.current || null);
      });
      if (!cams.length) setUnavailable(true);
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setUnavailable(true); return; }
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        probe.getTracks().forEach(tr => tr.stop());
        await list();
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    const onChange = () => { void list().catch(() => {}); };
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
    };
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          // Full sensor resolution, as in the phone Camera: small label text
          // needs every pixel, and `ideal` settles for what the device has.
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
        if (cancelled) { s.getTracks().forEach(tr => tr.stop()); return; }
        acquired = s;
        setUnavailable(false);
        setStream(s);
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach(tr => tr.stop());
      setStream(null);
    };
  }, [deviceId]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
  }, [stream]);

  useEffect(() => () => { void audioRef.current?.close().catch(() => {}); }, []);

  const beep = useCallback(() => {
    try {
      const ctx = audioRef.current ?? (audioRef.current = new AudioContext());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
    } catch {
      // No audio is fine — the flash is the primary cue.
    }
  }, []);

  const capture = useCallback(async (v: HTMLVideoElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 180);
    beep();
    // Send just the stick. Detect afresh on this exact frame — the tracked box
    // can trail a stick that just settled by up to BOX_JITTER, enough to clip
    // the gold fingers — then fall back to the tracked box, then the whole
    // frame (a non-green PCB, a steep tilt).
    const w = canvas.width;
    const h = canvas.height;
    const held = trackRef.current;
    const stick = detectStick(canvas, w, h, document.createElement('canvas'))
      ?? (held.locked
        ? { ...held.box, rotate: held.box.h * h > held.box.w * w ? 90 : 0, maybeMerged: false } as SheetBox
        : null);
    const out = stick ? cropToBox(canvas, w, h, stick) : canvas;
    const raw = await new Promise<Blob | null>(res => out.toBlob(b => res(b), 'image/jpeg', 0.92));
    if (!raw) return;
    const blob = await compressForUpload(raw);
    onCaptureRef.current(new File([blob], 'desk-scan.jpg', { type: blob.type || 'image/jpeg' }));
  }, [beep]);

  // Sampling pauses while a scan is in flight but keeps its state machine, so
  // a still frame that already fired stays spent until the stick is moved.
  useEffect(() => {
    if (!stream || busy) return;
    const crop = document.createElement('canvas');
    const ctx = crop.getContext('2d', { willReadFrequently: true });
    const detect = document.createElement('canvas');
    if (!ctx) return;
    // Kept across box changes on purpose: a moved or resized sample rect then
    // reads as motion (a size change as Infinity), which is also what re-arms
    // the trigger for the next stick. Clearing it would leave a fired trigger
    // with no motion to re-arm on.
    let prev: Uint8Array | null = null;
    let tick = 0;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.videoWidth) return;
      performance.mark('desk-cam-tick');
      const w = v.videoWidth;
      const h = v.videoHeight;
      const before = trackRef.current;
      // Finding the stick is the costly half of a tick at 1920×1440 (~20 ms),
      // so it runs every other tick; the held box carries the ones between.
      const next = tick++ % 2 === 0 ? trackBox(before, detectStick(v, w, h, detect)) : before;
      trackRef.current = next;
      if (next.box !== before.box || next.locked !== before.locked) {
        setShown({ box: next.box, locked: next.locked });
      }
      const r = sampleRect(next.box, w, h);
      if (crop.width !== r.w || crop.height !== r.h) {
        crop.width = r.w;
        crop.height = r.h;
      }
      ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const { gray, sample } = analyzeFrame(ctx.getImageData(0, 0, r.w, r.h).data, r.w, r.h, prev);
      prev = gray;
      const step = stepAutoCapture(autoRef.current, sample, Date.now());
      autoRef.current = step.state;
      setProgress(p => (p === step.progress ? p : step.progress));
      // Keep only the latest, so a long session doesn't fill the buffer.
      performance.clearMeasures('desk-cam-tick');
      performance.measure('desk-cam-tick', 'desk-cam-tick');
      performance.clearMarks('desk-cam-tick');
      if (step.fire) void capture(v);
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [stream, busy, capture]);

  const onPickDevice = (id: string) => {
    chosenByHandRef.current = true;
    setDeviceId(id);
    const label = devices.find(d => d.deviceId === id)?.label ?? '';
    if (label && label.length <= MAX_LABEL) setSavedLabel(label);
  };

  const hint = busy
    ? t('readingLabel')
    : progress > 0 ? t('deskHoldStill') : t('deskPlaceLabel');

  return (
    <div className="desk-cam">
      {/* Stage takes the feed's own aspect so the crop outline lines up with
          the video under object-fit: contain. */}
      <div className="desk-cam-stage" style={frame?.w ? { aspectRatio: `${frame.w} / ${frame.h}` } : undefined}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={stream ? 'is-live' : ''}
          onLoadedMetadata={e => setFrame({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
        />
        {unavailable ? (
          <div className="desk-cam-error" role="alert">
            <Icon name="camera" size={18} />
            <span>{t('deskCameraUnavailable')}</span>
          </div>
        ) : (
          <>
            {/* The box follows the stick: it is what the trigger judges and
                what gets cropped. Dashed while nothing is locked on. */}
            {frame && frame.w > 0 && (
              <div
                className={'desk-cam-corners' + (shown.locked ? ' is-locked' : '')}
                style={{
                  left: `${(shown.box.x * 100).toFixed(2)}%`,
                  top: `${(shown.box.y * 100).toFixed(2)}%`,
                  width: `${(shown.box.w * 100).toFixed(2)}%`,
                  height: `${(shown.box.h * 100).toFixed(2)}%`,
                }}
              />
            )}
            {busy && <span className="scan-line" />}
            <div className="desk-cam-hint" aria-live="polite">
              {busy && <span className="ai-dot" />}
              <span>{hint}</span>
              {!busy && progress > 0 && (
                <span className="desk-cam-progress">
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </span>
              )}
            </div>
          </>
        )}
        {flash && <div className="desk-cam-flash" />}
      </div>
      <div className="desk-cam-bar">
        {devices.length > 1 && (
          <select
            className="select"
            aria-label={t('deskCameraDevice')}
            value={deviceId ?? ''}
            onChange={e => onPickDevice(e.target.value)}
          >
            {devices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>
            ))}
          </select>
        )}
        <label className="desk-cam-auto">
          <input type="checkbox" checked={autoOpen} onChange={e => setAutoOpen(e.target.checked)} />
          <span>{t('deskAutoOpen')}</span>
        </label>
        <button type="button" className="btn sm" onClick={onClose}>
          <Icon name="x" size={12} /> {t('deskCloseCamera')}
        </button>
      </div>
    </div>
  );
}
