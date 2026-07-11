import type {
  AgentRole,
  Goal,
  GoalAgentStep,
  GoalMetrics,
  GoalMetricsSnapshot,
  GoalOutcome,
  GoalRoleMetrics,
} from "@corp-swarm/schema";
import type { Db } from "./db.js";
import { listGoals, listHandoffs, listRuns } from "./db.js";
import { estimateCostUsd } from "./model-pricing.js";

const ACTIVE_GOAL = new Set<Goal["status"]>(["queued", "planning", "executing"]);

type DbRun = ReturnType<typeof listRuns>[number];
type DbHandoff = ReturnType<typeof listHandoffs>[number];

function outcomeForGoal(
  goal: Goal,
  failedHandoffs: number,
  rejectedHandoffs: number,
): { outcome: GoalOutcome; summary: string } {
  if (goal.status === "done") {
    return { outcome: "success", summary: "Completed successfully" };
  }
  if (goal.status === "cancelled") {
    return { outcome: "cancelled", summary: "Cancelled by CEO or swarm" };
  }
  if (goal.status === "failed") {
    const parts = [];
    if (failedHandoffs > 0) parts.push(`${failedHandoffs} failed handoff(s)`);
    if (rejectedHandoffs > 0) parts.push(`${rejectedHandoffs} rejected`);
    return {
      outcome: "failed",
      summary: parts.length > 0 ? parts.join(" · ") : "Goal failed before completion",
    };
  }
  if (ACTIVE_GOAL.has(goal.status)) {
    return {
      outcome: "in_progress",
      summary:
        goal.status === "planning"
          ? "PM is planning handoffs"
          : "Agents are executing handoffs",
    };
  }
  return { outcome: "in_progress", summary: goal.status };
}

function runsForGoal(
  goalId: string,
  runs: ReturnType<typeof listRuns>,
  handoffs: ReturnType<typeof listHandoffs>,
) {
  const handoffIds = new Set(
    handoffs.filter((h) => h.goalId === goalId).map((h) => h.id),
  );
  return runs.filter(
    (r) => r.goalId === goalId || (r.handoffId != null && handoffIds.has(r.handoffId)),
  );
}

function modelsForRuns(
  goalRuns: DbRun[],
  defaultModel: string,
): { primaryModel: string | null; modelsUsed: string[] } {
  const counts = new Map<string, number>();
  for (const run of goalRuns) {
    const model = run.model ?? defaultModel;
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return { primaryModel: goalRuns.length > 0 ? defaultModel : null, modelsUsed: [] };
  }
  const modelsUsed = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model);
  return { primaryModel: modelsUsed[0] ?? null, modelsUsed };
}

function runStepMetrics(run: DbRun, defaultModel: string) {
  const model = run.model ?? defaultModel;
  return {
    durationMs: run.durationMs ?? null,
    inputTokens: run.inputTokens ?? null,
    outputTokens: run.outputTokens ?? null,
    totalTokens: run.totalTokens ?? null,
    model: run.model ?? null,
    estimatedCostUsd: estimateCostUsd(model, run.inputTokens, run.outputTokens),
  };
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
}

function runToStep(run: DbRun, defaultModel: string, nested = false): GoalAgentStep {
  const metrics = runStepMetrics(run, defaultModel);
  return {
    id: `run:${run.id}`,
    kind: "run",
    sortAt: run.startedAt,
    role: run.role,
    handoffId: run.handoffId,
    runId: run.id,
    label: nested ? `${run.role} run` : `${run.role} planning`,
    status: run.status,
    gatePhase: null,
    failureMessage: run.failureMessage,
    ...metrics,
  };
}

function handoffToStep(
  handoff: DbHandoff,
  linkedRuns: DbRun[],
  defaultModel: string,
): GoalAgentStep {
  const runMetrics = linkedRuns.map((run) => runStepMetrics(run, defaultModel));
  const durationMs =
    handoff.startedAt && handoff.finishedAt
      ? Math.max(0, Date.parse(handoff.finishedAt) - Date.parse(handoff.startedAt))
      : sumNullable(runMetrics.map((m) => m.durationMs));

  const phase = handoff.gatePhase ?? 1;
  return {
    id: `handoff:${handoff.id}`,
    kind: "handoff",
    sortAt: handoff.startedAt ?? handoff.createdAt,
    role: handoff.toRole,
    fromRole: handoff.fromRole,
    toRole: handoff.toRole,
    handoffId: handoff.id,
    runId: null,
    label: `Wave ${phase}: ${handoff.fromRole} → ${handoff.toRole}`,
    status: handoff.status,
    gatePhase: phase,
    durationMs,
    inputTokens: sumNullable(runMetrics.map((m) => m.inputTokens)),
    outputTokens: sumNullable(runMetrics.map((m) => m.outputTokens)),
    totalTokens: sumNullable(runMetrics.map((m) => m.totalTokens)),
    model: modelsForRuns(linkedRuns, defaultModel).primaryModel,
    estimatedCostUsd: sumNullable(runMetrics.map((m) => m.estimatedCostUsd)),
    failureMessage: handoff.failureReason ?? null,
  };
}

function buildGoalSteps(
  goalHandoffs: DbHandoff[],
  goalRuns: DbRun[],
  defaultModel: string,
): GoalAgentStep[] {
  const runsById = new Map(goalRuns.map((run) => [run.id, run]));
  const runsByHandoffId = new Map<string, DbRun[]>();
  for (const run of goalRuns) {
    if (!run.handoffId) continue;
    const bucket = runsByHandoffId.get(run.handoffId) ?? [];
    bucket.push(run);
    runsByHandoffId.set(run.handoffId, bucket);
  }

  const handoffRunIds = new Set(goalHandoffs.flatMap((h) => h.conversationRunIds));
  for (const run of goalRuns) {
    if (run.handoffId) handoffRunIds.add(run.id);
  }

  const steps: GoalAgentStep[] = [];

  const standaloneRuns = goalRuns
    .filter((run) => !handoffRunIds.has(run.id))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const run of standaloneRuns) {
    steps.push(runToStep(run, defaultModel));
  }

  const sortedHandoffs = [...goalHandoffs].sort(
    (a, b) =>
      (a.gatePhase ?? 1) - (b.gatePhase ?? 1) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );

  for (const handoff of sortedHandoffs) {
    const linkedFromIds = handoff.conversationRunIds
      .map((id) => runsById.get(id))
      .filter((run): run is DbRun => run != null);
    const linkedFromHandoff = runsByHandoffId.get(handoff.id) ?? [];
    const linkedRuns = [...new Map(
      [...linkedFromIds, ...linkedFromHandoff].map((run) => [run.id, run]),
    ).values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

    steps.push(handoffToStep(handoff, linkedRuns, defaultModel));
    for (const run of linkedRuns) {
      steps.push(runToStep(run, defaultModel, true));
    }
  }

  return steps;
}

type RoleAccumulator = {
  runs: number;
  handoffsReceived: number;
  failedOrRejectedHandoffs: number;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  modelCounts: Map<string, number>;
};

function emptyRoleAccumulator(): RoleAccumulator {
  return {
    runs: 0,
    handoffsReceived: 0,
    failedOrRejectedHandoffs: 0,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    estimatedCostUsd: null,
    modelCounts: new Map(),
  };
}

function accumulateRunMetrics(acc: RoleAccumulator, run: DbRun, defaultModel: string) {
  const metrics = runStepMetrics(run, defaultModel);
  acc.runs += 1;
  if (metrics.durationMs != null) acc.durationMs = (acc.durationMs ?? 0) + metrics.durationMs;
  if (metrics.inputTokens != null) acc.inputTokens = (acc.inputTokens ?? 0) + metrics.inputTokens;
  if (metrics.outputTokens != null) {
    acc.outputTokens = (acc.outputTokens ?? 0) + metrics.outputTokens;
  }
  if (metrics.totalTokens != null) acc.totalTokens = (acc.totalTokens ?? 0) + metrics.totalTokens;
  if (metrics.estimatedCostUsd != null) {
    acc.estimatedCostUsd = (acc.estimatedCostUsd ?? 0) + metrics.estimatedCostUsd;
  }
  const model = run.model ?? defaultModel;
  acc.modelCounts.set(model, (acc.modelCounts.get(model) ?? 0) + 1);
}

function buildRoleMetrics(
  goalHandoffs: DbHandoff[],
  goalRuns: DbRun[],
  defaultModel: string,
): GoalRoleMetrics[] {
  const byRole = new Map<AgentRole, RoleAccumulator>();

  const ensureRole = (role: AgentRole) => {
    if (!byRole.has(role)) byRole.set(role, emptyRoleAccumulator());
    return byRole.get(role)!;
  };

  for (const run of goalRuns) {
    if (run.role === "ceo") continue;
    accumulateRunMetrics(ensureRole(run.role), run, defaultModel);
  }

  for (const handoff of goalHandoffs) {
    const acc = ensureRole(handoff.toRole);
    acc.handoffsReceived += 1;
    if (handoff.status === "failed" || handoff.status === "rejected") {
      acc.failedOrRejectedHandoffs += 1;
    }
  }

  return [...byRole.entries()]
    .map(([role, acc]) => {
      const primaryModel =
        acc.modelCounts.size > 0
          ? [...acc.modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
          : null;
      return {
        role,
        runs: acc.runs,
        handoffsReceived: acc.handoffsReceived,
        failedOrRejectedHandoffs: acc.failedOrRejectedHandoffs,
        durationMs: acc.durationMs,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        totalTokens: acc.totalTokens,
        estimatedCostUsd: acc.estimatedCostUsd,
        primaryModel,
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role));
}

export function computeGoalMetrics(db: Db, defaultModel: string): GoalMetricsSnapshot {
  const goals = listGoals(db);
  const handoffs = listHandoffs(db);
  const runs = listRuns(db, 5000);
  const nowMs = Date.now();

  const goalRows: GoalMetrics[] = goals.map((goal) => {
    const goalHandoffs = handoffs.filter((h) => h.goalId === goal.id);
    const goalRuns = runsForGoal(goal.id, runs, handoffs);

    const failedHandoffs = goalHandoffs.filter((h) => h.status === "failed").length;
    const rejectedHandoffs = goalHandoffs.filter((h) => h.status === "rejected").length;
    const { outcome, summary } = outcomeForGoal(goal, failedHandoffs, rejectedHandoffs);

    const agentIds = new Set(
      goalRuns.map((r) => r.cursorAgentId).filter((id): id is string => Boolean(id)),
    );
    const rolesInvolved = [
      ...new Set(goalRuns.map((r) => r.role).filter((r) => r !== "ceo")),
    ] as AgentRole[];

    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let totalTokens: number | null = null;
    let estimatedCostUsd: number | null = null;

    for (const run of goalRuns) {
      if (run.inputTokens != null) inputTokens = (inputTokens ?? 0) + run.inputTokens;
      if (run.outputTokens != null) outputTokens = (outputTokens ?? 0) + run.outputTokens;
      if (run.totalTokens != null) totalTokens = (totalTokens ?? 0) + run.totalTokens;

      const model = run.model ?? defaultModel;
      const runCost = estimateCostUsd(model, run.inputTokens, run.outputTokens);
      if (runCost != null) estimatedCostUsd = (estimatedCostUsd ?? 0) + runCost;
    }

    const { primaryModel, modelsUsed } = modelsForRuns(goalRuns, defaultModel);

    const agentTimeMs =
      goalRuns.length > 0
        ? goalRuns.reduce((sum, r) => sum + (r.durationMs ?? 0), 0)
        : null;

    const endMs = ACTIVE_GOAL.has(goal.status) ? nowMs : Date.parse(goal.updatedAt);
    const durationMs = Math.max(0, endMs - Date.parse(goal.createdAt));

    return {
      goalId: goal.id,
      title: goal.title,
      prompt: goal.prompt,
      status: goal.status,
      outcome,
      outcomeSummary: summary,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      durationMs,
      agentTimeMs,
      totalRuns: goalRuns.length,
      agentsSpunUp: agentIds.size > 0 ? agentIds.size : new Set(goalRuns.map((r) => r.role)).size,
      rolesInvolved,
      totalHandoffs: goalHandoffs.length,
      failedHandoffs,
      rejectedHandoffs,
      inputTokens,
      outputTokens,
      totalTokens,
      primaryModel,
      modelsUsed,
      estimatedCostUsd,
      contextDigestChars: goal.contextDigest?.length ?? 0,
      steps: buildGoalSteps(goalHandoffs, goalRuns, defaultModel),
      byRole: buildRoleMetrics(goalHandoffs, goalRuns, defaultModel),
    };
  });

  goalRows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const successCount = goalRows.filter((g) => g.outcome === "success").length;
  const failedCount = goalRows.filter((g) => g.outcome === "failed").length;
  const inProgressCount = goalRows.filter((g) => g.outcome === "in_progress").length;

  const durations = goalRows
    .map((g) => g.durationMs)
    .filter((d): d is number => typeof d === "number");
  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

  let totalTokensSum: number | null = null;
  let estimatedTotalCostUsd: number | null = null;
  const fleetModelCounts = new Map<string, number>();
  for (const g of goalRows) {
    if (g.totalTokens != null) totalTokensSum = (totalTokensSum ?? 0) + g.totalTokens;
    if (g.estimatedCostUsd != null) {
      estimatedTotalCostUsd = (estimatedTotalCostUsd ?? 0) + g.estimatedCostUsd;
    }
    if (g.primaryModel) {
      fleetModelCounts.set(
        g.primaryModel,
        (fleetModelCounts.get(g.primaryModel) ?? 0) + 1,
      );
    }
  }

  const primaryModel =
    [...fleetModelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? defaultModel;

  return {
    goals: goalRows,
    totals: {
      requests: goalRows.length,
      successCount,
      failedCount,
      inProgressCount,
      totalTokens: totalTokensSum,
      totalAgentRuns: goalRows.reduce((n, g) => n + g.totalRuns, 0),
      estimatedTotalCostUsd,
      primaryModel,
      avgDurationMs,
    },
  };
}
