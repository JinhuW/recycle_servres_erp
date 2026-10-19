-- The response schema is part of what a prompt version is: the same wording
-- judged with the verdict asked for before the reasoning gave different
-- verdicts (docs/prompt-evaluations/2026-10-19-candidate-1-offline.md).
-- Every version recorded before this column existed used that order.
ALTER TABLE prompt_versions
  ADD COLUMN IF NOT EXISTS response_schema TEXT NOT NULL DEFAULT 'verdict-first';
