import { describe, it, expect } from 'vitest';
import { disputeLadder } from './disputeLadder';

const states = (stage: string | null, closed: boolean) =>
  disputeLadder(stage, closed)?.map(s => `${s.key}:${s.state}`) ?? null;

describe('disputeLadder', () => {
  it('an open case sits on its stage, with the rest still ahead', () => {
    expect(states('INQUIRY', false)).toEqual([
      'INQUIRY:active', 'CHARGEBACK:ahead', 'PRE_ARBITRATION:ahead', 'ARBITRATION:ahead',
    ]);
    expect(states('CHARGEBACK', false)).toEqual([
      'INQUIRY:reached', 'CHARGEBACK:active', 'PRE_ARBITRATION:ahead', 'ARBITRATION:ahead',
    ]);
    expect(states('ARBITRATION', false)).toEqual([
      'INQUIRY:reached', 'CHARGEBACK:reached', 'PRE_ARBITRATION:reached', 'ARBITRATION:active',
    ]);
  });

  // PayPal leaves the stage where the case was decided — every resolved case in
  // prod reads CHARGEBACK — so the stage alone kept Claim lit after the close.
  it('a closed case ends on Closed, and the stages it never reached are skipped', () => {
    expect(states('CHARGEBACK', true)).toEqual([
      'INQUIRY:reached', 'CHARGEBACK:reached', 'PRE_ARBITRATION:skipped', 'ARBITRATION:skipped',
      'CLOSED:active',
    ]);
  });

  it('a case closed in arbitration skips nothing', () => {
    expect(states('ARBITRATION', true)).toEqual([
      'INQUIRY:reached', 'CHARGEBACK:reached', 'PRE_ARBITRATION:reached', 'ARBITRATION:reached',
      'CLOSED:active',
    ]);
  });

  it('a stage it does not know draws no ladder, open or closed', () => {
    expect(disputeLadder(null, false)).toBeNull();
    expect(disputeLadder(null, true)).toBeNull();
    expect(disputeLadder('SOMETHING_NEW', true)).toBeNull();
  });
});
