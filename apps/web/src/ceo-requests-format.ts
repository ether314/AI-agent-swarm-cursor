import type { GoalMetrics, GoalMetricsSnapshot } from "@corp-swarm/schema";

/** Guard against partial API payloads (e.g. server not restarted after schema change). */
export function normalizeGoalMetrics(snapshot: GoalMetricsSnapshot): GoalMetricsSnapshot {
  return {
    ...snapshot,
    goals: snapshot.goals.map((goal) => normalizeGoal(goal)),
  };
}

export function normalizeGoal(goal: GoalMetrics): GoalMetrics {
  return {
    ...goal,
    steps: goal.steps ?? [],
    byRole: goal.byRole ?? [],
    modelsUsed: goal.modelsUsed ?? [],
    rolesInvolved: goal.rolesInvolved ?? [],
    contextDigestChars: goal.contextDigestChars ?? null,
  };
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatModel(model: string | null | undefined, modelsUsed?: string[]): string {
  if (!model) return "—";
  if (modelsUsed && modelsUsed.length > 1) {
    return `${model} +${modelsUsed.length - 1}`;
  }
  return model;
}

export function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "success":
      return "Success";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "In progress";
  }
}

export function stepStatusLabel(status: string): string {
  switch (status) {
    case "finished":
    case "done":
      return "Done";
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "error":
      return "Error";
    case "failed":
      return "Failed";
    case "rejected":
      return "Rejected";
    case "cancelled":
      return "Cancelled";
    case "in_progress":
      return "In progress";
    default:
      return status;
  }
}
