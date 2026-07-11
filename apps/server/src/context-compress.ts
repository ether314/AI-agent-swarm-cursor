import type { AgentRole, Artifact, ContextCaps, SwarmConfig } from "@corp-swarm/schema";

export const DEFAULT_CONTEXT_CAPS: ContextCaps = {
  objective: 400,
  contextSummary: 800,
  acceptanceCriteriaItem: 120,
  maxAcceptanceCriteria: 5,
  digest: 1500,
  resultSummary: 500,
  roleOverride: 300,
};

export function resolveContextCaps(
  config?: Pick<SwarmConfig, "contextCaps"> | null,
): ContextCaps {
  return { ...DEFAULT_CONTEXT_CAPS, ...(config?.contextCaps ?? {}) };
}

/** Truncate to maxLen, preferring a clean break at whitespace when possible. */
export function clip(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  if (maxLen <= 1) return "…";
  const slice = t.slice(0, maxLen - 1);
  const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"));
  const cut = breakAt > maxLen * 0.6 ? slice.slice(0, breakAt) : slice;
  return `${cut.trimEnd()}…`;
}

export function clipMultiline(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  if (maxLen <= 1) return "…";
  return `${t.slice(0, maxLen - 1).trimEnd()}…`;
}

export function compressAcceptanceCriteria(
  criteria: string[],
  caps: ContextCaps,
): string[] {
  return criteria
    .map((c) => clip(c, caps.acceptanceCriteriaItem))
    .filter(Boolean)
    .slice(0, caps.maxAcceptanceCriteria);
}

export function compressObjective(objective: string, caps: ContextCaps): string {
  return clip(objective, caps.objective);
}

export function compressContextSummary(
  context: string,
  caps: ContextCaps,
): string {
  return clipMultiline(context, caps.contextSummary);
}

/** Per-handoff context only — do not paste the full plan summary here. */
export function normalizePmHandoffContext(
  perHandoffContext: string,
  caps: ContextCaps,
): string {
  return compressContextSummary(perHandoffContext || "", caps);
}

export function compressResultSummary(
  summary: string | null | undefined,
  caps: ContextCaps,
): string | null {
  if (!summary?.trim()) return null;
  return clip(summary, caps.resultSummary);
}

export function compressOverrides(
  overrides: string[],
  maxCount: number,
  caps: ContextCaps,
): string[] {
  if (maxCount <= 0 || overrides.length === 0) return [];
  return overrides
    .slice(-maxCount)
    .map((o) => clip(o, caps.roleOverride))
    .filter(Boolean);
}

function artifactPaths(artifacts: Artifact[]): string[] {
  const paths: string[] = [];
  for (const a of artifacts) {
    if (a.kind === "path" && a.value) paths.push(a.value);
  }
  return paths.slice(0, 6);
}

export function formatDigestLine(input: {
  role: AgentRole;
  status?: string;
  summary: string;
  artifacts?: Artifact[];
  caps: ContextCaps;
}): string {
  const paths = artifactPaths(input.artifacts ?? []);
  const pathBit = paths.length > 0 ? ` paths=${paths.join(",")}` : "";
  const statusBit = input.status ? ` [${input.status}]` : "";
  const body = clip(input.summary, Math.min(220, input.caps.resultSummary));
  return `- ${input.role}${statusBit}: ${body}${pathBit}`;
}

/** Append a digest line and drop oldest lines when over the char budget. */
export function appendGoalDigest(
  existing: string | null | undefined,
  line: string,
  caps: ContextCaps,
): string {
  const lines = (existing ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const nextLine = line.trim();
  if (nextLine) lines.push(nextLine);

  let digest = lines.join("\n");
  while (digest.length > caps.digest && lines.length > 1) {
    lines.shift();
    digest = lines.join("\n");
  }
  if (digest.length > caps.digest) {
    digest = clipMultiline(digest, caps.digest);
  }
  return digest;
}

export function seedGoalDigestFromPlan(
  planSummary: string,
  caps: ContextCaps,
): string {
  const summary = clip(planSummary || "Plan created", Math.min(400, caps.digest));
  return `Plan: ${summary}`;
}

/** Build the CONTEXT block for a specialist task prompt. */
export function buildHandoffContext(input: {
  goalDigest?: string | null;
  handoffContext?: string | null;
  caps: ContextCaps;
}): string {
  const parts: string[] = [];
  const digest = (input.goalDigest ?? "").trim();
  if (digest) {
    parts.push(`GOAL DIGEST:\n${clipMultiline(digest, input.caps.digest)}`);
  }
  const ctx = (input.handoffContext ?? "").trim();
  if (ctx) {
    parts.push(
      `TASK CONTEXT:\n${compressContextSummary(ctx, input.caps)}`,
    );
  }
  return parts.join("\n\n") || "(no prior context)";
}

/** Heuristic: inject blog/content domain addendum only when relevant. */
export function needsBlogDomainAddendum(...texts: Array<string | null | undefined>): boolean {
  const blob = texts.filter(Boolean).join("\n").toLowerCase();
  if (!blob) return false;
  return /\b(blog|post|hero|thumbnail|article|content entry|visual capitalist)\b/.test(
    blob,
  );
}
