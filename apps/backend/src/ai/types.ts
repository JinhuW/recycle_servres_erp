// src/ai/types.ts
import type { AiProviderId } from '@recycle-erp/shared';
import type { LineCategory } from '../types';

export type OcrProvider = 'stub' | AiProviderId;

export type ScanResult = {
  category: LineCategory;
  confidence: number;
  fields: Record<string, string>;
  provider: OcrProvider;
};
