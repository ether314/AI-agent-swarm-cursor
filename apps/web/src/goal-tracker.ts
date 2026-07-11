import type {
  AgentRole,
  ConversationRun,
  Goal,
  Handoff,
  HandoffFriction,
  MetricsSnapshot,
} from "@corp-swarm/schema";

export type MilestoneStatus = "pending" | "active" | "complete" | "failed";

export type TrackerMilestone = {
  id: string;
  label: string;
  hint: string;
  status: MilestoneStatus;
};

export type TrackerActiveAgent = {
  role: AgentRole;
  status: "busy" | "error";
  objective: string;
  runningMinutes: number;
  stallLevel: "ok" | "watch" | "stuck";
  pingPongMinutes: number | null;
  pingPongLabel: string | null;
};

export type GoalTrackerSnapshot = {
  goal: Goal | null;
  milestones: TrackerMilestone[];
  completedMilestones: number;
  remainingSteps: number;
  progressPercent: number;
  activeAgents: TrackerActiveAgent[];
  blockedHandoffs: Array<{ id: string; label: string; reason: string }>;
  bottleneck: { title: string; detail: string } | null;
  etaMinutes: number | null;
  alerts: string[];
};

const ACTIVE_HANDOFF = new Set<Handoff["status"]>([
  "queued",
  "accepted",
  "in_progress",
]);

const IMPLEMENT_ROLES = new Set<AgentRole>(["backend", "frontend", "middleware"]);

type MilestoneDef = {
  id: string;
  label: string;
  hint: string;
  matches: (h: Handoff) => boolean;
  isComplete: (ctx: MilestoneContext) => boolean;
  isActive: (ctx: MilestoneContext) => boolean;
  isFailed: (ctx: MilestoneContext) => boolean;
};

type MilestoneContext = {
  goal: Goal;
  goalHandoffs: Handoff[];
  busyRoles: Set<AgentRole>;
  queuedRoles: Set<AgentRole>;
};

const MILESTONE_DEFS: MilestoneDef[] = [
  {
    id: "plan",
    label: "PM planning",
    hint: "Break goal into handoffs",
    matches: (h) => h.fromRole === "pm",
    isComplete: (ctx) =>
      ctx.goal.status === "executing" ||
      ctx.goal.status === "done" ||
      ctx.goalHandoffs.some((h) => h.fromRole === "pm"),
    isActive: (ctx) =>
      ctx.goal.status === "planning" ||
      ctx.goal.status === "queued" ||
      ctx.busyRoles.has("pm"),
    isFailed: (ctx) => ctx.goal.status === "failed" && ctx.goalHandoffs.length === 0,
  },
  {
    id: "build",
    label: "Build & wire",
    hint: "Backend / frontend implementation",
    matches: (h) => IMPLEMENT_ROLES.has(h.toRole),
    isComplete: (ctx) =>
      ctx.goalHandoffs.some(
        (h) => IMPLEMENT_ROLES.has(h.toRole) && h.status === "done",
      ) &&
      !ctx.goalHandoffs.some(
        (h) =>
          IMPLEMENT_ROLES.has(h.toRole) && ACTIVE_HANDOFF.has(h.status),
      ),
    isActive: (ctx) =>
      [...IMPLEMENT_ROLES].some(
        (r) => ctx.busyRoles.has(r) || ctx.queuedRoles.has(r),
      ) ||
      ctx.goalHandoffs.some(
        (h) => IMPLEMENT_ROLES.has(h.toRole) && ACTIVE_HANDOFF.has(h.status),
      ),
    isFailed: (ctx) => {
      const impl = ctx.goalHandoffs.filter((h) => IMPLEMENT_ROLES.has(h.toRole));
      const anyDone = impl.some((h) => h.status === "done");
      const anyActive =
        impl.some((h) => ACTIVE_HANDOFF.has(h.status)) ||
        [...IMPLEMENT_ROLES].some((r) => ctx.busyRoles.has(r));
      if (anyDone || anyActive) return false;
      return impl.some((h) => h.status === "failed" || h.status === "rejected");
    },
  },
  {
    id: "qa",
    label: "QA gate",
    hint: "Tests, smoke, GO sign-off",
    matches: (h) => h.toRole === "qa",
    isComplete: (ctx) =>
      ctx.goalHandoffs.some((h) => h.toRole === "qa" && h.status === "done") &&
      !ctx.goalHandoffs.some((h) => h.toRole === "qa" && ACTIVE_HANDOFF.has(h.status)),
    isActive: (ctx) =>
      ctx.busyRoles.has("qa") ||
      ctx.queuedRoles.has("qa") ||
      ctx.goalHandoffs.some((h) => h.toRole === "qa" && ACTIVE_HANDOFF.has(h.status)),
    isFailed: (ctx) => {
      const qa = ctx.goalHandoffs.filter((h) => h.toRole === "qa");
      const latest = qa.sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      )[0];
      return (
        latest != null &&
        (latest.status === "failed" || latest.status === "rejected") &&
        !qa.some((h) => h.status === "done" && h.id !== latest.id)
      );
    },
  },
  {
    id: "deploy",
    label: "Deploy",
    hint: "Firebase / release pipeline",
    matches: (h) => h.toRole === "devops",
    isComplete: (ctx) =>
      ctx.goal.status === "done" ||
      ctx.goalHandoffs.some((h) => h.toRole === "devops" && h.status === "done"),
    isActive: (ctx) =>
      ctx.busyRoles.has("devops") ||
      ctx.queuedRoles.has("devops") ||
      ctx.goalHandoffs.some(
        (h) => h.toRole === "devops" && ACTIVE_HANDOFF.has(h.status),
      ),
    isFailed: (ctx) => {
      const devops = ctx.goalHandoffs.filter((h) => h.toRole === "devops");
      const latest = devops.sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      )[0];
      return (
        latest != null &&
        (latest.status === "failed" || latest.status === "rejected") &&
        ctx.goal.status !== "done"
      );
    },
  },
  {
    id: "complete",
    label: "Outcome delivered",
    hint: "Goal marked done",
    matches: () => false,
    isComplete: (ctx) => ctx.goal.status === "done",
    isActive: (ctx) =>
      ctx.goal.status === "executing" &&
      ctx.goalHandoffs.some((h) => h.toRole === "devops" && h.status === "done"),
    isFailed: (ctx) => ctx.goal.status === "failed",
  },
];

function minutesSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
}

function agentOutputChars(text: string | null | undefined): number {
  return (text ?? "").replace(/\[orchestrator\][^\n]*\n?/g, "").trim().length;
}

function stallLevel(
  runningMinutes: number,
  outputChars: number,
  stallMinutes: number,
): "ok" | "watch" | "stuck" {
  if (runningMinutes >= stallMinutes) return "stuck";
  if (runningMinutes >= Math.max(1, stallMinutes - 1) && outputChars < 80) return "watch";
  if (runningMinutes >= 2 && outputChars < 40) return "watch";
  return "ok";
}

/** Ping-pong pairs on a goal (A→B then B→A), minutes since the reverse handoff started. */
function goalPingPongByRole(
  goalHandoffs: Handoff[],
  nowMs: number,
): Map<AgentRole, { minutes: number; label: string }> {
  const sorted = [...goalHandoffs].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const result = new Map<AgentRole, { minutes: number; label: string }>();

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (a.fromRole === b.toRole && a.toRole === b.fromRole) {
        const started = b.startedAt ?? b.createdAt;
        const minutes = minutesSince(started, nowMs);
        const label = `${a.fromRole} ↔ ${a.toRole}`;
        for (const role of [a.fromRole, a.toRole] as AgentRole[]) {
          const prev = result.get(role);
          if (!prev || minutes > prev.minutes) {
            result.set(role, { minutes, label });
          }
        }
      }
    }
  }
  return result;
}

function roleFailuresOnGoal(goalHandoffs: Handoff[], role: AgentRole): number {
  return goalHandoffs.filter(
    (h) =>
      h.toRole === role &&
      (h.status === "failed" || h.status === "rejected"),
  ).length;
}

function estimateEtaMinutes(
  milestones: TrackerMilestone[],
  metrics: MetricsSnapshot | null,
  maxConcurrent: number,
): number | null {
  const pending = milestones.filter((m) => m.status === "pending" || m.status === "active");
  if (pending.length === 0) return 0;

  const roleForMilestone: Record<string, AgentRole[]> = {
    plan: ["pm"],
    build: ["backend", "frontend"],
    qa: ["qa"],
    deploy: ["devops"],
    complete: [],
  };

  let totalMs = 0;
  for (const m of pending) {
    if (m.status === "complete") continue;
    const roles = roleForMilestone[m.id] ?? [];
    const durations = roles
      .map((r) => metrics?.byRole.find((x) => x.role === r)?.avgDurationMs)
      .filter((d): d is number => typeof d === "number" && d > 0);
    const avg =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 4 * 60_000;
    totalMs += avg;
  }

  const parallel = Math.max(1, maxConcurrent);
  return Math.max(1, Math.ceil(totalMs / parallel / 60_000));
}

export function computeGoalTracker(input: {
  goal: Goal | null;
  handoffs: Handoff[];
  runs: ConversationRun[];
  busyRoles: AgentRole[];
  errorRoles: AgentRole[];
  metrics: MetricsSnapshot | null;
  friction: HandoffFriction[];
  nowMs: number;
  silentStallMs: number;
  maxConcurrentAgents: number;
}): GoalTrackerSnapshot {
  const empty: GoalTrackerSnapshot = {
    goal: null,
    milestones: MILESTONE_DEFS.map((d) => ({
      id: d.id,
      label: d.label,
      hint: d.hint,
      status: "pending",
    })),
    completedMilestones: 0,
    remainingSteps: MILESTONE_DEFS.length,
    progressPercent: 0,
    activeAgents: [],
    blockedHandoffs: [],
    bottleneck: null,
    etaMinutes: null,
    alerts: [],
  };

  const { goal } = input;
  if (!goal || !["queued", "planning", "executing"].includes(goal.status)) {
    return { ...empty, goal };
  }

  const goalHandoffs = input.handoffs.filter((h) => h.goalId === goal.id);
  const busyRoles = new Set(input.busyRoles);
  const queuedRoles = new Set(
    goalHandoffs.filter((h) => h.status === "queued").map((h) => h.toRole),
  );

  const ctx: MilestoneContext = { goal, goalHandoffs, busyRoles, queuedRoles };

  const milestones: TrackerMilestone[] = MILESTONE_DEFS.map((def) => {
    let status: MilestoneStatus = "pending";
    if (def.isFailed(ctx)) status = "failed";
    else if (def.isComplete(ctx)) status = "complete";
    else if (def.isActive(ctx)) status = "active";
    return { id: def.id, label: def.label, hint: def.hint, status };
  });

  // First pending after last complete becomes active if none active
  if (!milestones.some((m) => m.status === "active")) {
    const firstOpen = milestones.findIndex(
      (m) => m.status === "pending" || m.status === "failed",
    );
    if (firstOpen >= 0 && milestones[firstOpen]!.status === "pending") {
      milestones[firstOpen] = { ...milestones[firstOpen]!, status: "active" };
    }
  }

  const completedMilestones = milestones.filter((m) => m.status === "complete").length;
  const remainingSteps = milestones.filter(
    (m) => m.status !== "complete",
  ).length;
  const progressPercent = Math.round(
    (completedMilestones / milestones.length) * 100,
  );

  const stallMinutes = Math.max(1, Math.round(input.silentStallMs / 60_000));
  const pingPong = goalPingPongByRole(goalHandoffs, input.nowMs);

  const goalRunIds = new Set(
    goalHandoffs.flatMap((h) => h.conversationRunIds ?? []),
  );

  const activeAgents: TrackerActiveAgent[] = [];

  for (const role of input.busyRoles) {
    const run =
      input.runs.find(
        (r) =>
          r.role === role &&
          r.status === "running" &&
          (r.goalId === goal.id || (r.handoffId && goalRunIds.has(r.handoffId))),
      ) ?? input.runs.find((r) => r.role === role && r.status === "running");

    const inflight = goalHandoffs.find(
      (h) => h.toRole === role && h.status === "in_progress",
    );
    const startedAt =
      run?.startedAt ?? inflight?.startedAt ?? inflight?.updatedAt ?? null;
    const runningMinutes = startedAt ? minutesSince(startedAt, input.nowMs) : 0;
    const outputChars = agentOutputChars(
      run?.resultText ?? run?.prompt ?? null,
    );
    const pp = pingPong.get(role) ?? null;

    activeAgents.push({
      role,
      status: "busy",
      objective:
        inflight?.objective ??
        run?.prompt?.split("\n").find((l) => l.startsWith("OBJECTIVE:"))?.slice(10)?.trim() ??
        "Working…",
      runningMinutes,
      stallLevel: stallLevel(runningMinutes, outputChars, stallMinutes),
      pingPongMinutes: pp?.minutes ?? null,
      pingPongLabel: pp?.label ?? null,
    });
  }

  for (const role of input.errorRoles) {
    if (activeAgents.some((a) => a.role === role)) continue;
    activeAgents.push({
      role,
      status: "error",
      objective: "Agent unhealthy — may need Clear stuck",
      runningMinutes: 0,
      stallLevel: "stuck",
      pingPongMinutes: pingPong.get(role)?.minutes ?? null,
      pingPongLabel: pingPong.get(role)?.label ?? null,
    });
  }

  const alerts: string[] = [];
  for (const agent of activeAgents) {
    if (agent.stallLevel === "stuck") {
      alerts.push(
        `${agent.role} may be stuck — running ${agent.runningMinutes} min with little output (watchdog ~${stallMinutes} min).`,
      );
    } else if (agent.stallLevel === "watch") {
      alerts.push(
        `${agent.role} running ${agent.runningMinutes} min — monitor for silent stall.`,
      );
    }
    if (agent.pingPongMinutes != null && agent.pingPongMinutes >= 2) {
      alerts.push(
        `${agent.role} ping-ponging (${agent.pingPongLabel}) for ${agent.pingPongMinutes} min.`,
      );
    }
  }

  // Bottleneck scoring
  let bottleneck: GoalTrackerSnapshot["bottleneck"] = null;
  let bestScore = 0;

  for (const agent of activeAgents) {
    const score =
      agent.stallLevel === "stuck"
        ? 100 + agent.runningMinutes
        : agent.stallLevel === "watch"
          ? 50 + agent.runningMinutes
          : agent.runningMinutes;
    if (score > bestScore) {
      bestScore = score;
      bottleneck = {
        title: `${agent.role} (${agent.stallLevel === "ok" ? "active" : agent.stallLevel})`,
        detail: `${agent.runningMinutes} min on: ${agent.objective.slice(0, 120)}`,
      };
    }
  }

  const failCounts = new Map<AgentRole, number>();
  for (const h of goalHandoffs) {
    if (h.status === "failed" || h.status === "rejected") {
      failCounts.set(h.toRole, (failCounts.get(h.toRole) ?? 0) + 1);
    }
  }
  for (const [role, count] of failCounts) {
    if (count > bestScore) {
      bestScore = count;
      bottleneck = {
        title: `${role} (failure history)`,
        detail: `${count} failed/rejected handoff${count === 1 ? "" : "s"} on this goal`,
      };
    }
  }

  const goalFriction = input.friction
    .filter((f) => f.pingPong > 0)
    .sort((a, b) => b.pingPong - a.pingPong)[0];
  if (goalFriction && goalFriction.pingPong > bestScore) {
    bottleneck = {
      title: `Ping-pong: ${goalFriction.fromRole} ↔ ${goalFriction.toRole}`,
      detail: `${goalFriction.pingPong} reverse handoffs historically — likely coordination bottleneck`,
    };
  }

  const etaMinutes = estimateEtaMinutes(
    milestones,
    input.metrics,
    input.maxConcurrentAgents,
  );

  const blockedHandoffs: GoalTrackerSnapshot["blockedHandoffs"] = [];
  const inFlight = goalHandoffs.filter((h) =>
    ["in_progress", "accepted"].includes(h.status),
  );
  for (const h of goalHandoffs.filter((h) => h.status === "queued")) {
    const phase = h.gatePhase ?? 1;
    let reason: string | null = null;
    if (inFlight.length > 0) {
      reason = `waiting for ${inFlight.map((x) => `${x.fromRole}→${x.toRole}`).join(", ")}`;
    } else if (
      goalHandoffs.some(
        (o) => (o.gatePhase ?? 1) < phase && o.status !== "done" && o.id !== h.id,
      )
    ) {
      reason = `wave ${phase} blocked until earlier wave completes`;
    } else if (h.toRole === "devops" && !goalHandoffs.some((o) => o.toRole === "qa" && o.status === "done")) {
      reason = "DevOps blocked until QA returns GO";
    } else if (
      h.toRole === "qa" &&
      phase >= 3 &&
      !goalHandoffs.some(
        (o) => IMPLEMENT_ROLES.has(o.toRole) && o.status === "done",
      )
    ) {
      reason = "QA blocked until backend or frontend completes";
    }
    if (reason) {
      blockedHandoffs.push({
        id: h.id,
        label: `${h.fromRole}→${h.toRole} (wave ${phase})`,
        reason,
      });
    }
  }

  return {
    goal,
    milestones,
    completedMilestones,
    remainingSteps,
    progressPercent,
    activeAgents,
    blockedHandoffs,
    bottleneck,
    etaMinutes,
    alerts,
  };
}
