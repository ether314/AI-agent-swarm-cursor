import type { AgentRole, Handoff, SwarmConfig } from "@corp-swarm/schema";

const ACTIVE_STATUSES = new Set<Handoff["status"]>([
  "queued",
  "accepted",
  "in_progress",
]);

const IMPLEMENT_ROLES = new Set<AgentRole>(["backend", "frontend", "middleware"]);

/** Infer pipeline wave from PM objective text or target role. */
export function inferGatePhase(objective: string, toRole: AgentRole): number {
  const wave = objective.match(/wave\s*(\d+)\s*of\s*\d+/i);
  if (wave?.[1]) return Math.max(1, parseInt(wave[1], 10));

  switch (toRole) {
    case "backend":
    case "middleware":
      return 1;
    case "frontend":
      return 2;
    case "qa":
      return 3;
    case "devops":
      return 4;
    default:
      return 1;
  }
}

export function handoffGatePhase(handoff: Handoff): number {
  return handoff.gatePhase ?? inferGatePhase(handoff.objective, handoff.toRole);
}

/** True when a later handoff on the same lane supersedes this failure. */
export function isSupersededFailure(handoff: Handoff, allOnGoal: Handoff[]): boolean {
  if (handoff.status !== "failed" && handoff.status !== "rejected") return false;
  return allOnGoal.some(
    (o) =>
      o.id !== handoff.id &&
      o.fromRole === handoff.fromRole &&
      o.toRole === handoff.toRole &&
      Date.parse(o.createdAt) > Date.parse(handoff.createdAt) &&
      (o.status === "done" ||
        o.status === "in_progress" ||
        o.status === "queued" ||
        o.status === "accepted"),
  );
}

export type GateCheck = { runnable: boolean; blockedBy?: string };

export function checkHandoffGate(
  handoff: Handoff,
  goalHandoffs: Handoff[],
  config: Pick<SwarmConfig, "sequentialPipeline" | "maxConcurrentPerGoal">,
): GateCheck {
  if (handoff.status !== "queued") {
    return { runnable: false, blockedBy: "not queued" };
  }

  const phase = handoffGatePhase(handoff);
  const inFlight = goalHandoffs.filter((h) =>
    ["in_progress", "accepted"].includes(h.status),
  );

  if (config.sequentialPipeline && inFlight.length > 0) {
    const busy = inFlight.map((h) => `${h.fromRole}→${h.toRole}`).join(", ");
    return {
      runnable: false,
      blockedBy: `waiting for in-flight handoff (${busy})`,
    };
  }

  if (
    config.maxConcurrentPerGoal > 0 &&
    inFlight.length >= config.maxConcurrentPerGoal
  ) {
    return { runnable: false, blockedBy: "max concurrent per goal reached" };
  }

  const lowerPhases = goalHandoffs.filter(
    (h) => h.id !== handoff.id && handoffGatePhase(h) < phase,
  );
  const incompleteLower = lowerPhases.filter(
    (h) =>
      h.status !== "done" && !isSupersededFailure(h, goalHandoffs),
  );
  if (incompleteLower.length > 0) {
    const waiting = incompleteLower
      .map((h) => `wave ${handoffGatePhase(h)} ${h.toRole} (${h.status})`)
      .join("; ");
    return { runnable: false, blockedBy: `earlier wave incomplete: ${waiting}` };
  }

  if (handoff.toRole === "devops") {
    const qaDone = goalHandoffs.some((h) => h.toRole === "qa" && h.status === "done");
    if (!qaDone) {
      return { runnable: false, blockedBy: "DevOps blocked until QA returns GO (done)" };
    }
  }

  if (handoff.toRole === "qa" && phase >= 3) {
    const implDone = goalHandoffs.some(
      (h) => IMPLEMENT_ROLES.has(h.toRole) && h.status === "done",
    );
    if (!implDone) {
      return {
        runnable: false,
        blockedBy: "QA gate blocked until backend or frontend handoff is done",
      };
    }
  }

  return { runnable: true };
}

/** Queued handoffs that pass pipeline gates, lowest wave first. */
export function listRunnableHandoffs(
  queued: Handoff[],
  allHandoffs: Handoff[],
  config: Pick<SwarmConfig, "sequentialPipeline" | "maxConcurrentPerGoal">,
): Handoff[] {
  const byGoal = new Map<string, Handoff[]>();
  for (const h of allHandoffs) {
    if (!h.goalId) continue;
    const list = byGoal.get(h.goalId) ?? [];
    list.push(h);
    byGoal.set(h.goalId, list);
  }

  const runnable: Handoff[] = [];
  for (const handoff of queued) {
    const goalHandoffs = handoff.goalId
      ? (byGoal.get(handoff.goalId) ?? [handoff])
      : [handoff];
    if (checkHandoffGate(handoff, goalHandoffs, config).runnable) {
      runnable.push(handoff);
    }
  }

  return runnable.sort((a, b) => {
    const phaseDiff = handoffGatePhase(a) - handoffGatePhase(b);
    if (phaseDiff !== 0) return phaseDiff;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

/** Decide terminal goal status once no handoffs are active. */
export function resolveGoalOutcome(
  related: Handoff[],
  config: Pick<SwarmConfig, "sequentialPipeline" | "maxConcurrentPerGoal"> = {
    sequentialPipeline: true,
    maxConcurrentPerGoal: 1,
  },
): "done" | "failed" | null {
  const inFlight = related.some((h) =>
    ["in_progress", "accepted"].includes(h.status),
  );
  const runnableQueued = related.some(
    (h) => h.status === "queued" && checkHandoffGate(h, related, config).runnable,
  );
  if (inFlight || runnableQueued) return null;

  const blockedQueued = related.filter(
    (h) =>
      h.status === "queued" && !checkHandoffGate(h, related, config).runnable,
  );
  if (blockedQueued.length > 0) return "failed";

  if (related.some((h) => h.toRole === "devops" && h.status === "done")) {
    return "done";
  }

  const relevantFailures = related.filter(
    (h) =>
      (h.status === "failed" || h.status === "rejected") &&
      !isSupersededFailure(h, related),
  );

  if (relevantFailures.length === 0) {
    if (related.length > 0 && related.every((h) => h.status === "done")) {
      return "done";
    }
    return related.length > 0 ? "failed" : null;
  }

  return "failed";
}

export function gatePhaseForFollowUp(
  fromRole: AgentRole,
  toRole: AgentRole,
  objective: string,
): number {
  const inferred = inferGatePhase(objective, toRole);
  if (fromRole === "qa" && toRole === "devops") return Math.max(4, inferred);
  if (fromRole === "qa" && IMPLEMENT_ROLES.has(toRole)) return Math.min(2, inferred);
  return inferred;
}

export type PmPlanHandoffLike = {
  phase?: number;
  toRole: AgentRole;
  objective: string;
  contextSummary: string;
  acceptanceCriteria: string[];
};

export type PmPlanLike = {
  summary: string;
  handoffs: PmPlanHandoffLike[];
};

/**
 * Normalize PM plan phases in code so prompts do not need long pipeline rules.
 * - Assign missing phases from role defaults
 * - Force qa ≥ 3 and devops ≥ 4, and after implement roles
 * - Ensure unique ascending phases when collisions would mix qa/devops with build
 * - Prefix Wave N of M on objectives
 */
export function normalizePmPlan(
  plan: PmPlanLike,
  enabledRoles: AgentRole[],
): PmPlanLike {
  const enabled = new Set(enabledRoles);
  const filtered = plan.handoffs.filter(
    (h) => h.toRole === "qa" || h.toRole === "devops" || enabled.has(h.toRole),
  );

  const items = filtered.map((h) => {
    let phase = h.phase ?? inferGatePhase(h.objective, h.toRole);
    if (h.toRole === "qa") phase = Math.max(3, phase);
    if (h.toRole === "devops") phase = Math.max(4, phase);
    if (IMPLEMENT_ROLES.has(h.toRole) && phase >= 3) phase = inferGatePhase("", h.toRole);
    return { ...h, phase };
  });

  // Sort by phase then role priority within phase
  const roleOrder: Record<string, number> = {
    backend: 0,
    middleware: 1,
    frontend: 2,
    qa: 3,
    devops: 4,
  };
  items.sort(
    (a, b) =>
      (a.phase ?? 1) - (b.phase ?? 1) ||
      (roleOrder[a.toRole] ?? 9) - (roleOrder[b.toRole] ?? 9),
  );

  // Re-number so qa/devops never share a phase with implement roles
  let nextPhase = 1;
  const used = new Map<number, AgentRole[]>();
  for (const h of items) {
    let phase = h.phase ?? nextPhase;
    const peers = used.get(phase) ?? [];
    const qaDevopsVsImpl =
      (h.toRole === "qa" || h.toRole === "devops") &&
      peers.some((r) => IMPLEMENT_ROLES.has(r));
    const implVsQaDevops =
      IMPLEMENT_ROLES.has(h.toRole) &&
      peers.some((r) => r === "qa" || r === "devops");
    const conflict = peers.length > 0 && (qaDevopsVsImpl || implVsQaDevops);
    if (conflict) {
      const maxUsed = used.size > 0 ? Math.max(...used.keys()) : 0;
      phase = Math.max(maxUsed, nextPhase) + 1;
    }
    h.phase = phase;
    used.set(phase, [...(used.get(phase) ?? []), h.toRole]);
    nextPhase = Math.max(nextPhase, phase);
  }

  const maxPhase = items.reduce((m, h) => Math.max(m, h.phase ?? 1), 1);
  return {
    summary: plan.summary,
    handoffs: items.map((h) => {
      const phase = h.phase ?? 1;
      const objective = h.objective.match(/wave\s*\d+\s*of\s*\d+/i)
        ? h.objective
        : `Wave ${phase} of ${maxPhase} — ${h.objective}`;
      return { ...h, phase, objective };
    }),
  };
}

