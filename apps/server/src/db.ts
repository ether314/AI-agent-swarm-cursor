import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { dataDir } from "./config.js";
import type {
  AgentInstance,
  AgentRole,
  ConversationRun,
  Goal,
  Handoff,
  Suggestion,
} from "@corp-swarm/schema";

export type Db = DatabaseSync;

export function openDb(): Db {
  const dbPath = path.join(dataDir(), "corp-swarm.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT NOT NULL,
      context_summary TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      parent_handoff_id TEXT,
      goal_id TEXT,
      conversation_run_ids_json TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_runs (
      id TEXT PRIMARY KEY,
      cursor_run_id TEXT,
      cursor_agent_id TEXT,
      role TEXT NOT NULL,
      handoff_id TEXT,
      goal_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      result_text TEXT,
      failure_kind TEXT NOT NULL DEFAULT 'none',
      failure_message TEXT,
      transcript_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS agent_instances (
      role TEXT PRIMARY KEY,
      cursor_agent_id TEXT,
      status TEXT NOT NULL,
      last_run_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY,
      target_role TEXT NOT NULL,
      finding TEXT NOT NULL,
      proposed_prompt_change TEXT NOT NULL,
      evidence_log_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_overrides (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source_suggestion_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metric_events (
      id TEXT PRIMARY KEY,
      role TEXT,
      kind TEXT NOT NULL,
      handoff_id TEXT,
      run_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function now(): string {
  return new Date().toISOString();
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function isPaused(db: Db): boolean {
  return getMeta(db, "swarm_paused") === "1";
}

export function setPaused(db: Db, paused: boolean): void {
  setMeta(db, "swarm_paused", paused ? "1" : "0");
}

export function upsertAgentInstance(db: Db, instance: AgentInstance): void {
  db.prepare(
    `INSERT INTO agent_instances (role, cursor_agent_id, status, last_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET
       cursor_agent_id = excluded.cursor_agent_id,
       status = excluded.status,
       last_run_id = excluded.last_run_id,
       updated_at = excluded.updated_at`,
  ).run(
    instance.role,
    instance.cursorAgentId,
    instance.status,
    instance.lastRunId,
    instance.updatedAt,
  );
}

export function listAgentInstances(db: Db): AgentInstance[] {
  return db
    .prepare(
      `SELECT role, cursor_agent_id as cursorAgentId, status, last_run_id as lastRunId, updated_at as updatedAt
       FROM agent_instances`,
    )
    .all() as AgentInstance[];
}

export function getAgentInstance(db: Db, role: AgentRole): AgentInstance | null {
  return (
    (db
      .prepare(
        `SELECT role, cursor_agent_id as cursorAgentId, status, last_run_id as lastRunId, updated_at as updatedAt
         FROM agent_instances WHERE role = ?`,
      )
      .get(role) as AgentInstance | undefined) ?? null
  );
}

export function insertGoal(db: Db, goal: Goal): void {
  db.prepare(
    `INSERT INTO goals (id, title, prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    goal.id,
    goal.title,
    goal.prompt,
    goal.status,
    goal.createdAt,
    goal.updatedAt,
  );
}

export function updateGoalStatus(db: Db, id: string, status: Goal["status"]): Goal {
  const updatedAt = now();
  db.prepare(`UPDATE goals SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    updatedAt,
    id,
  );
  return getGoal(db, id)!;
}

export function getGoal(db: Db, id: string): Goal | null {
  return (
    (db
      .prepare(
        `SELECT id, title, prompt, status, created_at as createdAt, updated_at as updatedAt FROM goals WHERE id = ?`,
      )
      .get(id) as Goal | undefined) ?? null
  );
}

export function listGoals(db: Db): Goal[] {
  return db
    .prepare(
      `SELECT id, title, prompt, status, created_at as createdAt, updated_at as updatedAt
       FROM goals ORDER BY created_at DESC`,
    )
    .all() as Goal[];
}

function rowToHandoff(row: Record<string, unknown>): Handoff {
  return {
    id: row.id as string,
    fromRole: row.from_role as Handoff["fromRole"],
    toRole: row.to_role as Handoff["toRole"],
    status: row.status as Handoff["status"],
    objective: row.objective as string,
    contextSummary: row.context_summary as string,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json as string),
    artifacts: JSON.parse(row.artifacts_json as string),
    parentHandoffId: (row.parent_handoff_id as string | null) ?? null,
    goalId: (row.goal_id as string | null) ?? null,
    conversationRunIds: JSON.parse(row.conversation_run_ids_json as string),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function insertHandoff(db: Db, handoff: Handoff): void {
  db.prepare(
    `INSERT INTO handoffs (
      id, from_role, to_role, status, objective, context_summary,
      acceptance_criteria_json, artifacts_json, parent_handoff_id, goal_id,
      conversation_run_ids_json, started_at, finished_at, failure_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    handoff.id,
    handoff.fromRole,
    handoff.toRole,
    handoff.status,
    handoff.objective,
    handoff.contextSummary,
    JSON.stringify(handoff.acceptanceCriteria),
    JSON.stringify(handoff.artifacts),
    handoff.parentHandoffId ?? null,
    handoff.goalId ?? null,
    JSON.stringify(handoff.conversationRunIds),
    handoff.startedAt ?? null,
    handoff.finishedAt ?? null,
    handoff.failureReason ?? null,
    handoff.createdAt,
    handoff.updatedAt,
  );
}

export function updateHandoff(db: Db, handoff: Handoff): void {
  db.prepare(
    `UPDATE handoffs SET
      status = ?,
      artifacts_json = ?,
      conversation_run_ids_json = ?,
      started_at = ?,
      finished_at = ?,
      failure_reason = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    handoff.status,
    JSON.stringify(handoff.artifacts),
    JSON.stringify(handoff.conversationRunIds),
    handoff.startedAt ?? null,
    handoff.finishedAt ?? null,
    handoff.failureReason ?? null,
    handoff.updatedAt,
    handoff.id,
  );
}

export function getHandoff(db: Db, id: string): Handoff | null {
  const row = db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToHandoff(row) : null;
}

export function listHandoffs(db: Db): Handoff[] {
  return (
    db.prepare(`SELECT * FROM handoffs ORDER BY created_at DESC`).all() as Record<
      string,
      unknown
    >[]
  ).map(rowToHandoff);
}

export function listQueuedHandoffs(db: Db): Handoff[] {
  return (
    db
      .prepare(
        `SELECT * FROM handoffs WHERE status = 'queued' ORDER BY created_at ASC`,
      )
      .all() as Record<string, unknown>[]
  ).map(rowToHandoff);
}

export function countQueuedHandoffs(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM handoffs WHERE status = 'queued'`)
    .get() as { c: number };
  return Number(row.c);
}

export function insertRun(db: Db, run: ConversationRun): void {
  db.prepare(
    `INSERT INTO conversation_runs (
      id, cursor_run_id, cursor_agent_id, role, handoff_id, goal_id, status, prompt,
      result_text, failure_kind, failure_message, transcript_json, started_at, finished_at, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.cursorRunId,
    run.cursorAgentId,
    run.role,
    run.handoffId,
    run.goalId,
    run.status,
    run.prompt,
    run.resultText,
    run.failureKind,
    run.failureMessage,
    run.transcriptJson,
    run.startedAt,
    run.finishedAt,
    run.durationMs,
  );
}

export function updateRun(db: Db, run: ConversationRun): void {
  db.prepare(
    `UPDATE conversation_runs SET
      cursor_run_id = ?,
      cursor_agent_id = ?,
      status = ?,
      result_text = ?,
      failure_kind = ?,
      failure_message = ?,
      transcript_json = ?,
      finished_at = ?,
      duration_ms = ?
     WHERE id = ?`,
  ).run(
    run.cursorRunId,
    run.cursorAgentId,
    run.status,
    run.resultText,
    run.failureKind,
    run.failureMessage,
    run.transcriptJson,
    run.finishedAt,
    run.durationMs,
    run.id,
  );
}

function mapRun(row: Record<string, unknown>): ConversationRun {
  return {
    id: row.id as string,
    cursorRunId: (row.cursorRunId as string | null) ?? null,
    cursorAgentId: (row.cursorAgentId as string | null) ?? null,
    role: row.role as ConversationRun["role"],
    handoffId: (row.handoffId as string | null) ?? null,
    goalId: (row.goalId as string | null) ?? null,
    status: row.status as ConversationRun["status"],
    prompt: row.prompt as string,
    resultText: (row.resultText as string | null) ?? null,
    failureKind: (row.failureKind as ConversationRun["failureKind"]) ?? "none",
    failureMessage: (row.failureMessage as string | null) ?? null,
    transcriptJson: (row.transcriptJson as string | null) ?? null,
    startedAt: row.startedAt as string,
    finishedAt: (row.finishedAt as string | null) ?? null,
    durationMs: (row.durationMs as number | null) ?? null,
  };
}

const RUN_SELECT = `SELECT id, cursor_run_id as cursorRunId, cursor_agent_id as cursorAgentId, role,
  handoff_id as handoffId, goal_id as goalId, status, prompt, result_text as resultText,
  failure_kind as failureKind, failure_message as failureMessage,
  transcript_json as transcriptJson, started_at as startedAt, finished_at as finishedAt,
  duration_ms as durationMs
 FROM conversation_runs`;

export function getRun(db: Db, id: string): ConversationRun | null {
  const row = db.prepare(`${RUN_SELECT} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRun(row) : null;
}

export function listRuns(db: Db, limit = 100): ConversationRun[] {
  return (
    db.prepare(`${RUN_SELECT} ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<
      string,
      unknown
    >[]
  ).map(mapRun);
}

export function listRecentFailures(db: Db, limit = 20): ConversationRun[] {
  return (
    db
      .prepare(
        `${RUN_SELECT}
         WHERE status IN ('error', 'startup_error')
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[]
  ).map(mapRun);
}

export function insertSuggestion(db: Db, s: Suggestion): void {
  db.prepare(
    `INSERT INTO suggestions (
      id, target_role, finding, proposed_prompt_change, evidence_log_ids_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.targetRole,
    s.finding,
    s.proposedPromptChange,
    JSON.stringify(s.evidenceLogIds),
    s.status,
    s.createdAt,
    s.updatedAt,
  );
}

export function listSuggestions(db: Db): Suggestion[] {
  const rows = db
    .prepare(
      `SELECT id, target_role as targetRole, finding, proposed_prompt_change as proposedPromptChange,
        evidence_log_ids_json as evidenceJson, status, created_at as createdAt, updated_at as updatedAt
       FROM suggestions ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    targetRole: Suggestion["targetRole"];
    finding: string;
    proposedPromptChange: string;
    evidenceJson: string;
    status: Suggestion["status"];
    createdAt: string;
    updatedAt: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    targetRole: r.targetRole,
    finding: r.finding,
    proposedPromptChange: r.proposedPromptChange,
    evidenceLogIds: JSON.parse(r.evidenceJson),
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export function updateSuggestionStatus(
  db: Db,
  id: string,
  status: Suggestion["status"],
): Suggestion | null {
  const updatedAt = now();
  db.prepare(`UPDATE suggestions SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    updatedAt,
    id,
  );
  return listSuggestions(db).find((s) => s.id === id) ?? null;
}

/** Accept a suggestion and apply it as a role override. */
export function acceptSuggestion(db: Db, id: string): Suggestion | null {
  const suggestion = updateSuggestionStatus(db, id, "accepted");
  if (!suggestion) return null;
  // Avoid double-applying if already accepted earlier
  const existing = listRoleOverrides(db, suggestion.targetRole);
  if (!existing.includes(suggestion.proposedPromptChange)) {
    addRoleOverride(
      db,
      crypto.randomUUID(),
      suggestion.targetRole,
      suggestion.proposedPromptChange,
      suggestion.id,
    );
  }
  return suggestion;
}

/** Accept every pending suggestion (CEO auto-approve). */
export function acceptAllPendingSuggestions(db: Db): number {
  let n = 0;
  for (const s of listSuggestions(db)) {
    if (s.status !== "pending") continue;
    if (acceptSuggestion(db, s.id)) n += 1;
  }
  return n;
}

export function addRoleOverride(
  db: Db,
  id: string,
  role: AgentRole,
  content: string,
  sourceSuggestionId: string | null,
): void {
  db.prepare(
    `INSERT INTO role_overrides (id, role, content, source_suggestion_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, role, content, sourceSuggestionId, now());
}

export function listRoleOverrides(db: Db, role: AgentRole): string[] {
  const rows = db
    .prepare(
      `SELECT content FROM role_overrides WHERE role = ? ORDER BY created_at ASC`,
    )
    .all(role) as Array<{ content: string }>;
  return rows.map((r) => r.content);
}

export function insertMetricEvent(
  db: Db,
  event: {
    id: string;
    role: AgentRole | null;
    kind: string;
    handoffId?: string | null;
    runId?: string | null;
    payload?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO metric_events (id, role, kind, handoff_id, run_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.role,
    event.kind,
    event.handoffId ?? null,
    event.runId ?? null,
    JSON.stringify(event.payload ?? {}),
    now(),
  );
}

export { now };
