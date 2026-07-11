/** Indicative USD per 1M tokens — for dashboard estimates, not official billing. */
const MODEL_RATES: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "composer-2.5": { inputPer1M: 2.5, outputPer1M: 10 },
  "composer-2": { inputPer1M: 2.0, outputPer1M: 8 },
  "gpt-5": { inputPer1M: 2.5, outputPer1M: 10 },
  "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15 },
  "claude-opus-4": { inputPer1M: 15.0, outputPer1M: 75 },
};

const FALLBACK_RATES = { inputPer1M: 2.5, outputPer1M: 10 };

export function ratesForModel(modelId: string): { inputPer1M: number; outputPer1M: number } {
  const key = modelId.toLowerCase();
  if (MODEL_RATES[key]) return MODEL_RATES[key];
  if (key.includes("composer")) return MODEL_RATES["composer-2.5"] ?? FALLBACK_RATES;
  if (key.includes("sonnet")) return { inputPer1M: 3, outputPer1M: 15 };
  if (key.includes("opus")) return { inputPer1M: 15, outputPer1M: 75 };
  return FALLBACK_RATES;
}

export function estimateCostUsd(
  modelId: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  if (inputTokens == null && outputTokens == null) return null;
  const inp = inputTokens ?? 0;
  const out = outputTokens ?? 0;
  if (inp === 0 && out === 0) return null;
  const rates = ratesForModel(modelId);
  return (inp * rates.inputPer1M + out * rates.outputPer1M) / 1_000_000;
}
