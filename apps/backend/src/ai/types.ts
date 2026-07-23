// src/ai/types.ts
import type { LineCategory } from '../types';

export type OcrProvider = 'stub' | 'openrouter';

export type ScanResult = {
  category: LineCategory;
  confidence: number;
  fields: Record<string, string>;
  provider: OcrProvider;
};
