import type {
  AgentRole,
  HandoffFriction,
  MetricsSnapshot,
  RoleMetrics,
} from "@corp-swarm/schema";
import { AgentRoleSchema } from "@corp-swarm/schema";
import type { Db } from "./db.js";
import { countQueuedHandoffs, isPaused, listAgentInstances } from "./db.js";

const ROLES = AgentRoleSchema.options.filter((r) => r !== "ceo");

export function computeMetrics(db: Db): MetricsSnapshot {
  const byRole: RoleMetrics[] = ROLES.map((role) => metricsForRole(db, role));
  const friction = computeFriction(db);
  const agents = listAgentInstances(db);
  const activeRuns = agents.filter((a) => a.status === "busy").length;

  return {
    byRole,
    friction,
    swarmPaused: isPaused(db),
    queueDepth: countQueuedHandoffs(db),
    activeRuns,
  };
}

function metricsForRole(db: Db, role: AgentRole): RoleMetrics {
  const runs = db
    .prepare(
      `SELECT status, duration_ms as durationMs FROM conversation_runs WHERE role = ?`,
    )
    .all(role) as Array<{ status: string; durationMs: number | null }>;

  const totalRuns = runs.length;
  const finished = runs.filter((r) => r.status === "finished").length;
  const errors = runs.filter((r) => r.status === "error").length;
  const cancelled = runs.filter((r) => r.status === "cancelled").length;
  const startupErrors = runs.filter((r) => r.status === "startup_error").length;
  const durations = runs
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === "number");
  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

  const handoffsCreated = (
    db
      .prepare(`SELECT COUNT(*) as c FROM handoffs WHERE from_role = ?`)
      .get(role) as { c: number }
  ).c;
  const handoffsReceived = (
    db
      .prepare(`SELECT COUNT(*) as c FROM handoffs WHERE to_role = ?`)
      .get(role) as { c: number }
  ).c;
  const handoffsFailed = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM handoffs WHERE to_role = ? AND status = 'failed'`,
      )
      .get(role) as { c: number }
  ).c;
  const handoffsRejected = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM handoffs WHERE to_role = ? AND status = 'rejected'`,
      )
      .get(role) as { c: number }
  ).c;

  // Reopens: same objective pair marked failed then a later queued/done with same from/to
  const reopenCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM handoffs h1
         WHERE h1.to_role = ? AND h1.status = 'failed'
         AND EXISTS (
           SELECT 1 FROM handoffs h2
           WHERE h2.to_role = h1.to_role AND h2.from_role = h1.from_role
             AND h2.created_at > h1.created_at
             AND h2.objective = h1.objective
         )`,
      )
      .get(role) as { c: number }
  ).c;

  const terminal = finished + errors + cancelled + startupErrors;
  const successRate = terminal === 0 ? 1 : finished / terminal;

  return {
    role,
    totalRuns,
    finished,
    errors,
    cancelled,
    startupErrors,
    successRate,
    avgDurationMs,
    handoffsCreated,
    handoffsReceived,
    handoffsFailed,
    handoffsRejected,
    reopenCount,
  };
}

function computeFriction(db: Db): HandoffFriction[] {
  const rows = db
    .prepare(
      `SELECT from_role as fromRole, to_role as toRole,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
       FROM handoffs
       GROUP BY from_role, to_role`,
    )
    .all() as Array<{
    fromRole: AgentRole;
    toRole: AgentRole;
    total: number;
    failed: number;
    rejected: number;
  }>;

  return rows.map((r) => {
    const pingPong = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM handoffs a
           JOIN handoffs b
             ON a.to_role = b.from_role AND a.from_role = b.to_role
            AND b.created_at > a.created_at
            AND a.goal_id IS NOT NULL AND a.goal_id = b.goal_id
           WHERE a.from_role = ? AND a.to_role = ?`,
        )
        .get(r.fromRole, r.toRole) as { c: number }
    ).c;

    return {
      fromRole: r.fromRole,
      toRole: r.toRole,
      total: r.total,
      failed: Number(r.failed),
      rejected: Number(r.rejected),
      pingPong,
    };
  });
}
