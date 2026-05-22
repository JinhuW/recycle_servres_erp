import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Generates a 64-byte verifier base64url-encoded (≈86 chars), inside the
// RFC 7636 length window.
export function generateVerifier(): string {
  return randomBytes(64).toString('base64url');
}

export function challengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function verifyChallenge(challenge: string, verifier: string): boolean {
  const expected = Buffer.from(challengeS256(verifier));
  const provided = Buffer.from(challenge);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
