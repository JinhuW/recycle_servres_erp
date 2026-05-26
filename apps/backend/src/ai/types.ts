// src/ai/types.ts
import type { LineCategory } from '../types';

export type OcrProvider = 'stub' | 'openrouter';

export type ScanResult = {
  category: LineCategory;
  confidence: number;
  fields: Record<string, string>;
  provider: OcrProvider;
};

// Below this overall confidence the UI surfaces a "please verify every field"
// banner. Lowered from 0.6 → 0.5 in tandem with the recalibrated prompt
// rubric (see ai/prompts.ts) and the coverage-derived floor in
// ai/openrouter.ts — together those moves push legitimate scans into a more
// honest mid-range, where a 0.6 cutoff was over-flagging clean reads.
// Keep in sync with the frontend gate.
export const CONFIDENCE_FLOOR = 0.5;
