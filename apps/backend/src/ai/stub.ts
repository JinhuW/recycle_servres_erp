// src/ai/stub.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';

export const STUB_BY_CATEGORY: Record<LineCategory, Omit<ScanResult, 'provider'>> = {
  RAM: {
    category: 'RAM',
    confidence: 0.94,
    fields: {
      brand: 'Samsung',
      capacity: '32GB',
      generation: 'DDR4',
      type: 'Server',
      classification: 'RDIMM',
      rank: '2Rx4',
      speed: '3200',
      partNumber: 'M393A4K40DB3-CWE',
    },
  },
  SSD: {
    category: 'SSD',
    confidence: 0.91,
    fields: {
      brand: 'Samsung',
      capacity: '1.92TB',
      interface: 'NVMe',
      formFactor: 'M.2 22110',
      partNumber: 'MZ1L21T9HCLS-00A07',
    },
  },
  HDD: {
    category: 'HDD',
    confidence: 0.89,
    fields: {
      brand: 'Seagate',
      capacity: '4TB',
      interface: 'SAS',
      formFactor: '3.5"',
      rpm: '7200',
      partNumber: 'ST4000NM0023',
    },
  },
  Other: {
    category: 'Other',
    confidence: 0.88,
    fields: {
      description: 'Intel Xeon Gold 6248',
      partNumber: 'SRF90',
    },
  },
};

export function stubScan(env: Env, category: LineCategory): ScanResult {
  // STUB_LOW_CONF=true simulates an unreadable label so the manual-entry
  // path can be exercised without a real model.
  if ((env.STUB_LOW_CONF ?? 'false').toLowerCase() === 'true') {
    return { category, confidence: 0.3, fields: {}, provider: 'stub' };
  }
  return { ...STUB_BY_CATEGORY[category], provider: 'stub' };
}
