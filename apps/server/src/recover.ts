import type { AgentRole } from "@corp-swarm/schema";
import type { Db } from "./db.js";
import {
  getHandoff,
  getRun,
  listAgentInstances,
  listHandoffs,
  listRuns,
  now,
  updateHandoff,
  updateRun,
  upsertAgentInstance,
} from "./db.js";
import { bus } from "./events.js";

/**
 * After a process crash/restart, in-memory awaits are gone but SQLite may still
 * show agents as busy and runs as running. Mark those as orphaned failures.
 */
export function recoverStuckWork(db: Db, maxAgeMs = 0): {
  recoveredRuns: number;
  recoveredHandoffs: number;
  recoveredAgents: number;
} {
  const ts = now();
  let recoveredRuns = 0;
  let recoveredHandoffs = 0;
  let recoveredAgents = 0;
  const rolesToClear = new Set<AgentRole>();

  for (const run of listRuns(db, 500)) {
    if (run.status !== "running") continue;
    if (maxAgeMs > 0 && run.startedAt) {
      const age = Date.parse(ts) - Date.parse(run.startedAt);
      if (age < maxAgeMs) continue;
    }
    const finished: typeof run = {
      ...run,
      status: "error",
      failureKind: "run_error",
      failureMessage:
        "Run orphaned — the Corp Swarm API process restarted while this Cursor agent was still running (often caused by `tsx watch` reloading on file save). In-flight wait() was lost. Re-dispatch the handoff; use `npm run dev:server` without watch while agents are working.",
      finishedAt: ts,
      durationMs: run.startedAt
        ? Date.parse(ts) - Date.parse(run.startedAt)
        : null,
    };
    updateRun(db, finished);
    bus.emit({ type: "run_finished", run: finished });
    recoveredRuns += 1;
    rolesToClear.add(run.role as AgentRole);
  }

  for (const handoff of listHandoffs(db)) {
    if (handoff.status !== "in_progress" && handoff.status !== "accepted") {
      continue;
    }
    const updated = {
      ...handoff,
      status: "failed" as const,
      failureReason:
        handoff.failureReason ??
        "Handoff interrupted — agent run did not complete (orchestrator restart or hang).",
      finishedAt: ts,
      updatedAt: ts,
    };
    updateHandoff(db, updated);
    bus.emit({ type: "handoff_updated", handoff: updated });
    recoveredHandoffs += 1;
    rolesToClear.add(handoff.toRole as AgentRole);
  }

  // Clear cursorAgentId for recovered roles so the next run creates a fresh
  // Agent — resuming a Cursor agent that still has an in-flight run breaks send().
  for (const agent of listAgentInstances(db)) {
    const wasBusy = agent.status === "busy";
    const shouldClear =
      wasBusy || rolesToClear.has(agent.role as AgentRole);
    if (!shouldClear) continue;
    upsertAgentInstance(db, {
      ...agent,
      cursorAgentId: null,
      status: "idle",
      updatedAt: ts,
    });
    bus.emit({
      type: "agent_status",
      role: agent.role as AgentRole,
      status: "idle",
      lastRunId: agent.lastRunId,
    });
    if (wasBusy) recoveredAgents += 1;
  }

  return { recoveredRuns, recoveredHandoffs, recoveredAgents };
}

/** Soft timeout helper for long Cursor waits. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function requeueHandoff(db: Db, handoffId: string): boolean {
  const handoff = getHandoff(db, handoffId);
  if (!handoff) return false;
  const updated = {
    ...handoff,
    status: "queued" as const,
    failureReason: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: now(),
  };
  updateHandoff(db, updated);
  bus.emit({ type: "handoff_updated", handoff: updated });
  return true;
}

export function getStuckRunIds(db: Db): string[] {
  return listRuns(db, 200)
    .filter((r) => r.status === "running")
    .map((r) => r.id);
}
