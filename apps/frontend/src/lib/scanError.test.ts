import { describe, it, expect, vi } from 'vitest';
import { ApiError } from './api';
import { isAiServiceFailure, scanErrorBanner, scanErrorMessage } from './scanError';

const t = (key: string) => `t:${key}`;

describe('isAiServiceFailure', () => {
  // 4xx is the user's to fix, here, now — the backend already names which.
  it('is false for the failures the user can act on', () => {
    for (const status of [400, 413, 415, 429]) {
      expect(isAiServiceFailure(new ApiError(status, 'nope')), `status ${status}`).toBe(false);
    }
  });

  it('is true for a backend or provider failure', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isAiServiceFailure(new ApiError(status, 'nope')), `status ${status}`).toBe(true);
    }
  });

  // A dropped connection never becomes an ApiError, and it is exactly the case
  // where retaking the photo cannot help.
  it('is true when the request never reached a response', () => {
    expect(isAiServiceFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isAiServiceFailure(undefined)).toBe(true);
  });
});

describe('scanErrorMessage', () => {
  it('passes a 4xx through, because the backend said something actionable', () => {
    expect(scanErrorMessage(new ApiError(415, 'unsupported image type: image/tiff'), t))
      .toBe('unsupported image type: image/tiff');
  });

  it('names the escalation when the service itself failed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(scanErrorMessage(new ApiError(502, 'label OCR failed'), t)).toBe('t:aiUnavailable');
    // The provider's own words stay reachable for whoever gets contacted.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // The backend already distinguishes 429 "Too many scans", 415 "unsupported
  // image type" and 413 "file too large". Collapsing them into one generic
  // line tells a rate-limited user to retake a photo that will fail the same.
  it('keeps each 4xx the backend bothered to write', () => {
    for (const [status, msg] of [
      [429, 'Too many scans, please wait.'],
      [415, 'unsupported image type: image/tiff'],
      [413, 'file too large (max 10485760 bytes)'],
    ] as const) {
      expect(scanErrorMessage(new ApiError(status, msg), t)).toBe(msg);
    }
  });
});

describe('scanErrorBanner', () => {
  // useAddPackageForm stores the failure and renders it later, so it needs the
  // key rather than a translated string — both shells then render one line.
  it('hands back a key for an outage and text for an actionable 4xx', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(scanErrorBanner(new ApiError(503, 'down'))).toEqual({ key: 'aiUnavailable' });
    spy.mockRestore();
    expect(scanErrorBanner(new ApiError(415, 'unsupported image type: image/tiff')))
      .toEqual({ text: 'unsupported image type: image/tiff' });
  });
});
