import { v4 as uuid } from "uuid";
import { Agent, CursorAgentError } from "@cursor/sdk";
import {
  PmPlanSchema,
  SpecialistResultSchema,
  OversightOutputSchema,
  type AgentRole,
  type ConversationRun,
  type Handoff,
  type ProjectBrief,
  type SwarmConfig,
  type Suggestion,
} from "@corp-swarm/schema";
import {
  buildSystemPrompt,
  canHandoff,
  getRolePack,
} from "@corp-swarm/roles";
import type { Db } from "./db.js";
import {
  getAgentInstance,
  insertHandoff,
  insertMetricEvent,
  insertRun,
  listHandoffs,
  listRoleOverrides,
  getRun,
  now,
  updateHandoff,
  updateRun,
  upsertAgentInstance,
  acceptSuggestion,
} from "./db.js";
import { bus } from "./events.js";
import { withTimeout } from "./recover.js";

/** Max time for a single Cursor agent run (stream + wait). */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

type ActiveAgent = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any;
  role: AgentRole;
};

type InflightRun = {
  dbRunId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdkRun: any;
  handoffId: string | null;
};

function isStaleBusyAgentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already has active run/i.test(msg);
}

/** Strip orchestrator banner lines to detect runs that produced no agent output. */
function isSilentAgentOutput(streamed: string): boolean {
  const body = streamed.replace(/\[orchestrator\][^\n]*\n?/g, "").trim();
  return body.length === 0;
}

/** Extract terminal failure details from a Cursor SDK RunResult when present. */
function formatSdkRunError(result: {
  id?: string;
  error?: { message?: string; code?: string };
  result?: string;
}): string {
  const parts: string[] = [];
  if (result.error?.message) parts.push(result.error.message);
  if (result.error?.code) parts.push(`code=${result.error.code}`);
  if (parts.length > 0) return parts.join(" · ");
  if (result.result?.trim()) return result.result.trim().slice(0, 500);
  return `Cursor run ${result.id ?? "unknown"} failed`;
}

/** Rotate long-lived agents to avoid context bloat and silent SDK failures. */
const AGENT_ROTATE_AFTER_RUNS = 6;

export class Orchestrator {
  private active = new Map<AgentRole, ActiveAgent>();
  private inflight = new Map<AgentRole, InflightRun>();
  private runningCount = 0;
  private finishedRunsPerRole = new Map<AgentRole, number>();

  constructor(
    private db: Db,
    private config: SwarmConfig,
    private brief: ProjectBrief,
    private apiKey: string,
  ) {}

  getActiveRunCount(): number {
    return this.runningCount;
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  getBrief(): ProjectBrief {
    return this.brief;
  }

  /**
   * Cancel the in-flight Cursor run for a role (CEO kill switch).
   * Also fails that role's queued/in_progress handoffs so the queue won't
   * immediately restart the same work.
   */
  async cancelRole(
    role: AgentRole,
    reason = "Cancelled by CEO",
  ): Promise<{ cancelledRun: boolean; failedHandoffs: number }> {
    const inflight = this.inflight.get(role);
    let cancelledRun = false;

    if (inflight?.sdkRun) {
      try {
        if (
          typeof inflight.sdkRun.supports === "function" &&
          inflight.sdkRun.supports("cancel")
        ) {
          await inflight.sdkRun.cancel();
          cancelledRun = true;
        }
      } catch (err) {
        console.warn(`cancel() failed for ${role}`, err);
      }
    }

    // Force-terminal the DB run if still marked running
    if (inflight?.dbRunId) {
      const run = getRun(this.db, inflight.dbRunId);
      if (run && run.status === "running") {
        const finishedAt = now();
        const updated = {
          ...run,
          status: "cancelled" as const,
          failureKind: "none" as const,
          failureMessage: reason,
          finishedAt,
          durationMs: Date.parse(finishedAt) - Date.parse(run.startedAt),
        };
        updateRun(this.db, updated);
        bus.emit({ type: "run_finished", run: updated });
      }
    }

    let failedHandoffs = 0;
    for (const handoff of listHandoffs(this.db)) {
      if (handoff.toRole !== role) continue;
      if (
        handoff.status !== "queued" &&
        handoff.status !== "accepted" &&
        handoff.status !== "in_progress"
      ) {
        continue;
      }
      const updated = {
        ...handoff,
        status: "failed" as const,
        failureReason: reason,
        finishedAt: now(),
        updatedAt: now(),
      };
      updateHandoff(this.db, updated);
      bus.emit({ type: "handoff_updated", handoff: updated });
      failedHandoffs += 1;
    }

    await this.disposeRoleAgent(role);
    this.inflight.delete(role);
    upsertAgentInstance(this.db, {
      role,
      cursorAgentId: null,
      status: "idle",
      lastRunId: getAgentInstance(this.db, role)?.lastRunId ?? null,
      updatedAt: now(),
    });
    bus.emit({
      type: "agent_status",
      role,
      status: "idle",
      lastRunId: null,
    });

    return { cancelledRun, failedHandoffs };
  }

  /**
   * Point the swarm at a new working tree. Disposes live agents and clears
   * persisted Cursor agent IDs so the next runs bind to the new cwd.
   */
  async retarget(config: SwarmConfig, brief: ProjectBrief): Promise<void> {
    if (this.runningCount > 0) {
      throw new Error(
        "Cannot change target repo while agents are running. Pause/clear stuck work first.",
      );
    }
    await this.disposeAll();
    for (const role of [
      "pm",
      "backend",
      "frontend",
      "middleware",
      "qa",
      "devops",
      "oversight",
    ] as AgentRole[]) {
      const instance = getAgentInstance(this.db, role);
      if (!instance) continue;
      upsertAgentInstance(this.db, {
        role,
        cursorAgentId: null,
        status: "idle",
        lastRunId: instance.lastRunId,
        updatedAt: now(),
      });
      bus.emit({
        type: "agent_status",
        role,
        status: "idle",
        lastRunId: instance.lastRunId,
      });
    }
    this.config = config;
    this.brief = brief;
  }

  async disposeAll(): Promise<void> {
    for (const [, handle] of this.active) {
      try {
        await handle.agent[Symbol.asyncDispose]?.();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }

  /** Drop in-memory handle and clear persisted Cursor agent id for a role. */
  private async disposeRoleAgent(role: AgentRole): Promise<void> {
    const existing = this.active.get(role);
    if (existing) {
      this.active.delete(role);
      try {
        await existing.agent[Symbol.asyncDispose]?.();
      } catch {
        /* ignore */
      }
    }
    const instance = getAgentInstance(this.db, role);
    upsertAgentInstance(this.db, {
      role,
      cursorAgentId: null,
      status: instance?.status ?? "idle",
      lastRunId: instance?.lastRunId ?? null,
      updatedAt: now(),
    });
  }

  private async createFreshAgent(role: AgentRole): Promise<ActiveAgent> {
    const pack = getRolePack(role);
    if (!pack) throw new Error(`No role pack for ${role}`);

    const instance = getAgentInstance(this.db, role);
    const agent = await Agent.create({
      apiKey: this.apiKey,
      model: { id: this.config.model },
      local: {
        cwd: this.config.targetRepo,
        settingSources: [],
      },
    });

    const handle = { agent, role };
    this.active.set(role, handle);

    upsertAgentInstance(this.db, {
      role,
      cursorAgentId: agent.agentId ?? null,
      status: instance?.status ?? "idle",
      lastRunId: instance?.lastRunId ?? null,
      updatedAt: now(),
    });

    return handle;
  }

  private async ensureAgent(role: AgentRole): Promise<ActiveAgent> {
    const existing = this.active.get(role);
    if (existing) return existing;

    const pack = getRolePack(role);
    if (!pack) throw new Error(`No role pack for ${role}`);

    const instance = getAgentInstance(this.db, role);

    if (instance?.cursorAgentId) {
      try {
        const agent = await Agent.resume(instance.cursorAgentId, {
          apiKey: this.apiKey,
          model: { id: this.config.model },
          local: {
            cwd: this.config.targetRepo,
            settingSources: [],
          },
        });
        const handle = { agent, role };
        this.active.set(role, handle);
        upsertAgentInstance(this.db, {
          role,
          cursorAgentId: agent.agentId ?? instance.cursorAgentId,
          status: "idle",
          lastRunId: instance.lastRunId ?? null,
          updatedAt: now(),
        });
        return handle;
      } catch (err) {
        console.warn(
          `resume failed for ${role}, clearing stale id and creating new agent`,
          err,
        );
        await this.disposeRoleAgent(role);
        return this.createFreshAgent(role);
      }
    }

    return this.createFreshAgent(role);
  }

  /**
   * If send/startup fails because the resumed agent still has an in-flight run,
   * dispose it, create a fresh agent, and return the new handle for a single retry.
   */
  private async recreateOnStaleBusy(
    role: AgentRole,
    err: unknown,
  ): Promise<ActiveAgent | null> {
    if (!isStaleBusyAgentError(err)) return null;
    console.warn(
      `Agent for ${role} already has active run — disposing and creating fresh agent`,
      err instanceof Error ? err.message : err,
    );
    await this.disposeRoleAgent(role);
    return this.createFreshAgent(role);
  }

  private noteFinishedRun(role: AgentRole): void {
    const count = (this.finishedRunsPerRole.get(role) ?? 0) + 1;
    this.finishedRunsPerRole.set(role, count);
    if (count >= AGENT_ROTATE_AFTER_RUNS) {
      console.warn(
        `Agent for ${role} reached ${count} finished runs — rotating to fresh agent`,
      );
      this.finishedRunsPerRole.set(role, 0);
      void this.disposeRoleAgent(role);
    }
  }

  private async handleUnhealthyAgent(role: AgentRole, reason: string): Promise<void> {
    console.warn(`Disposing ${role} agent after unhealthy run: ${reason}`);
    await this.disposeRoleAgent(role);
    this.finishedRunsPerRole.set(role, 0);
  }

  private getSystemPrompt(role: AgentRole): string {
    const pack = getRolePack(role);
    if (!pack) return "";
    const overrides = listRoleOverrides(this.db, role);
    return buildSystemPrompt(pack, this.brief.summary, overrides);
  }

  async runPrompt(opts: {
    role: AgentRole;
    prompt: string;
    handoffId?: string | null;
    goalId?: string | null;
  }): Promise<ConversationRun> {
    const startedAt = now();
    const runId = uuid();
    let run: ConversationRun = {
      id: runId,
      cursorRunId: null,
      cursorAgentId: null,
      role: opts.role,
      handoffId: opts.handoffId ?? null,
      goalId: opts.goalId ?? null,
      status: "running",
      prompt: opts.prompt,
      resultText: null,
      failureKind: "none",
      failureMessage: null,
      transcriptJson: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
    };
    insertRun(this.db, run);
    bus.emit({ type: "run_started", run });

    this.runningCount += 1;
    upsertAgentInstance(this.db, {
      role: opts.role,
      cursorAgentId: getAgentInstance(this.db, opts.role)?.cursorAgentId ?? null,
      status: "busy",
      lastRunId: runId,
      updatedAt: now(),
    });
    bus.emit({
      type: "agent_status",
      role: opts.role,
      status: "busy",
      lastRunId: runId,
    });

    const fullPrompt = [
      this.getSystemPrompt(opts.role),
      "",
      "---",
      "",
      opts.prompt,
    ].join("\n");

    try {
      let handle = await this.ensureAgent(opts.role);
      let agentId = handle.agent.agentId as string;
      run.cursorAgentId = agentId;
      updateRun(this.db, run);

      upsertAgentInstance(this.db, {
        role: opts.role,
        cursorAgentId: agentId,
        status: "busy",
        lastRunId: runId,
        updatedAt: now(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sdkRun: any;
      try {
        sdkRun = await handle.agent.send(fullPrompt);
      } catch (sendErr) {
        const fresh = await this.recreateOnStaleBusy(opts.role, sendErr);
        if (!fresh) throw sendErr;
        handle = fresh;
        agentId = handle.agent.agentId as string;
        run.cursorAgentId = agentId;
        updateRun(this.db, run);
        upsertAgentInstance(this.db, {
          role: opts.role,
          cursorAgentId: agentId,
          status: "busy",
          lastRunId: runId,
          updatedAt: now(),
        });
        sdkRun = await handle.agent.send(fullPrompt);
      }
      run.cursorRunId = sdkRun.id ?? null;
      updateRun(this.db, run);
      this.inflight.set(opts.role, {
        dbRunId: runId,
        sdkRun,
        handoffId: opts.handoffId ?? null,
      });

      let streamed = "";
      let lastFlush = 0;
      const flushStream = (force = false) => {
        const t = Date.now();
        if (!force && t - lastFlush < 1000) return;
        lastFlush = t;
        run = { ...run, resultText: streamed };
        updateRun(this.db, run);
      };
      const emitChunk = (text: string) => {
        if (!text) return;
        streamed += text;
        bus.emit({
          type: "run_chunk",
          runId,
          role: opts.role,
          text,
        });
        flushStream(false);
      };
      emitChunk(`[orchestrator] ${opts.role} run started (cursor ${run.cursorRunId})\n`);
      flushStream(true);

      const consumeStream = async () => {
        try {
          for await (const event of sdkRun.stream()) {
            if (event.type === "assistant") {
              for (const block of event.message.content ?? []) {
                if (block.type === "text" && block.text) {
                  emitChunk(block.text);
                }
              }
            } else if (event.type === "tool_call") {
              const name =
                (event as { name?: string; toolCall?: { name?: string } }).name ??
                (event as { toolCall?: { name?: string } }).toolCall?.name ??
                "tool";
              emitChunk(`\n[tool] ${name}…\n`);
            } else if (event.type === "thinking" && (event as { text?: string }).text) {
              emitChunk(`[thinking] ${(event as { text: string }).text}\n`);
            }
          }
        } catch (streamErr) {
          console.warn("stream error (continuing to wait)", streamErr);
          emitChunk(
            `\n[orchestrator] stream interrupted: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}\n`,
          );
        }
      };

      const result = await withTimeout(
        (async () => {
          await consumeStream();
          return sdkRun.wait();
        })(),
        RUN_TIMEOUT_MS,
        `${opts.role} run`,
      );
      const finishedAt = now();
      const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);

      let transcript: unknown = null;
      try {
        if (typeof sdkRun.supports === "function" && sdkRun.supports("conversation")) {
          transcript = await sdkRun.conversation();
        }
      } catch {
        /* optional */
      }

      if (result.status === "error") {
        const failureMessage = formatSdkRunError(result);
        const silent = isSilentAgentOutput(streamed);
        if (silent && result.error?.message) {
          emitChunk(`\n[orchestrator] SDK error: ${failureMessage}\n`);
        }
        run = {
          ...run,
          status: "error",
          failureKind: "run_error",
          failureMessage,
          resultText: streamed || result.result || null,
          transcriptJson: transcript ? JSON.stringify(transcript) : null,
          finishedAt,
          durationMs,
        };
        if (silent) {
          await this.handleUnhealthyAgent(
            opts.role,
            `silent run_error (${failureMessage})`,
          );
        }
      } else if (result.status === "cancelled") {
        run = {
          ...run,
          status: "cancelled",
          resultText: streamed || result.result || null,
          transcriptJson: transcript ? JSON.stringify(transcript) : null,
          finishedAt,
          durationMs,
        };
      } else {
        run = {
          ...run,
          status: "finished",
          resultText: streamed || result.result || null,
          transcriptJson: transcript ? JSON.stringify(transcript) : null,
          finishedAt,
          durationMs,
        };
        this.noteFinishedRun(opts.role);
      }
      updateRun(this.db, run);
      insertMetricEvent(this.db, {
        id: uuid(),
        role: opts.role,
        kind: `run_${run.status}`,
        handoffId: opts.handoffId,
        runId: run.id,
        payload: {
          durationMs,
          cursorRunId: run.cursorRunId,
          failureMessage: run.failureMessage ?? undefined,
          silentFailure:
            run.status === "error" ? isSilentAgentOutput(streamed) : undefined,
        },
      });
      bus.emit({ type: "run_finished", run });
      return run;
    } catch (err) {
      const finishedAt = now();
      const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
      const isStartup = err instanceof CursorAgentError;
      run = {
        ...run,
        status: isStartup ? "startup_error" : "error",
        failureKind: isStartup ? "startup_error" : "run_error",
        failureMessage: err instanceof Error ? err.message : String(err),
        finishedAt,
        durationMs,
      };
      updateRun(this.db, run);
      if (!isStartup) {
        await this.handleUnhealthyAgent(
          opts.role,
          run.failureMessage ?? "run exception",
        );
      }
      insertMetricEvent(this.db, {
        id: uuid(),
        role: opts.role,
        kind: `run_${run.status}`,
        handoffId: opts.handoffId,
        runId: run.id,
        payload: { message: run.failureMessage },
      });
      bus.emit({ type: "run_finished", run });
      bus.emit({
        type: "agent_status",
        role: opts.role,
        status: "error",
        lastRunId: runId,
      });
      return run;
    } finally {
      this.inflight.delete(opts.role);
      this.runningCount = Math.max(0, this.runningCount - 1);
      const inst = getAgentInstance(this.db, opts.role);
      upsertAgentInstance(this.db, {
        role: opts.role,
        cursorAgentId: inst?.cursorAgentId ?? run.cursorAgentId,
        status: "idle",
        lastRunId: runId,
        updatedAt: now(),
      });
      bus.emit({
        type: "agent_status",
        role: opts.role,
        status: "idle",
        lastRunId: runId,
      });
    }
  }

  extractJson<T>(text: string, schema: { parse: (v: unknown) => T }): T | null {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates = [
      fenced?.[1],
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ].filter(Boolean) as string[];

    for (const c of candidates) {
      try {
        return schema.parse(JSON.parse(c));
      } catch {
        /* try next */
      }
    }
    return null;
  }

  createHandoffRecord(input: {
    fromRole: AgentRole;
    toRole: AgentRole;
    objective: string;
    contextSummary?: string;
    acceptanceCriteria?: string[];
    parentHandoffId?: string | null;
    goalId?: string | null;
  }): Handoff {
    if (!canHandoff(input.fromRole, input.toRole)) {
      throw new Error(
        `Handoff not allowed: ${input.fromRole} → ${input.toRole}`,
      );
    }
    const ts = now();
    const handoff: Handoff = {
      id: uuid(),
      fromRole: input.fromRole,
      toRole: input.toRole,
      status: "queued",
      objective: input.objective,
      contextSummary: input.contextSummary ?? "",
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      artifacts: [],
      parentHandoffId: input.parentHandoffId ?? null,
      goalId: input.goalId ?? null,
      conversationRunIds: [],
      startedAt: null,
      finishedAt: null,
      failureReason: null,
      createdAt: ts,
      updatedAt: ts,
    };
    insertHandoff(this.db, handoff);
    insertMetricEvent(this.db, {
      id: uuid(),
      role: input.fromRole,
      kind: "handoff_created",
      handoffId: handoff.id,
      payload: { toRole: input.toRole },
    });
    bus.emit({ type: "handoff_updated", handoff });
    return handoff;
  }

  async planGoal(goalId: string, prompt: string): Promise<Handoff[]> {
    const planPrompt = [
      "You are the Project Manager. The CEO issued this goal.",
      "",
      `GOAL: ${prompt}`,
      "",
      "Produce a JSON object ONLY (optionally in a ```json fence) matching:",
      '{ "summary": string, "handoffs": [{ "toRole": "backend"|"frontend"|"middleware"|"qa"|"devops", "objective": string, "contextSummary": string, "acceptanceCriteria": string[] }] }',
      "",
      "Create at least one handoff. Prefer the smallest set of specialists needed.",
      `Enabled specialists: ${this.config.enabledRoles.filter((r) => r !== "pm" && r !== "oversight").join(", ")}`,
    ].join("\n");

    const run = await this.runPrompt({
      role: "pm",
      prompt: planPrompt,
      goalId,
    });

    if (run.status !== "finished" || !run.resultText) {
      throw new Error(run.failureMessage ?? "PM planning failed");
    }

    const plan = this.extractJson(run.resultText, PmPlanSchema);
    if (!plan) {
      // Fallback: single backend handoff so the swarm can still move
      const fallback = this.createHandoffRecord({
        fromRole: "pm",
        toRole: "backend",
        objective: prompt,
        contextSummary: `PM could not parse structured plan. Raw output logged in run ${run.id}.`,
        acceptanceCriteria: [
          "Address the CEO goal as far as possible in this repository",
          "Document what was done and what remains",
        ],
        goalId,
      });
      return [fallback];
    }

    const created: Handoff[] = [];
    for (const h of plan.handoffs) {
      if (!this.config.enabledRoles.includes(h.toRole)) continue;
      created.push(
        this.createHandoffRecord({
          fromRole: "pm",
          toRole: h.toRole,
          objective: h.objective,
          contextSummary: `${plan.summary}\n\n${h.contextSummary}`,
          acceptanceCriteria: h.acceptanceCriteria,
          goalId,
        }),
      );
    }
    if (created.length === 0) {
      created.push(
        this.createHandoffRecord({
          fromRole: "pm",
          toRole: "backend",
          objective: prompt,
          contextSummary: plan.summary,
          acceptanceCriteria: ["Complete the goal or document blockers"],
          goalId,
        }),
      );
    }
    return created;
  }

  async executeHandoff(handoff: Handoff): Promise<Handoff> {
    const ts = now();
    handoff = {
      ...handoff,
      status: "in_progress",
      startedAt: handoff.startedAt ?? ts,
      updatedAt: ts,
    };
    updateHandoff(this.db, handoff);
    bus.emit({ type: "handoff_updated", handoff });

    const prompt = [
      `HANDOFF ID: ${handoff.id}`,
      `FROM: ${handoff.fromRole}`,
      `TO: ${handoff.toRole}`,
      "",
      `OBJECTIVE: ${handoff.objective}`,
      "",
      `CONTEXT: ${handoff.contextSummary}`,
      "",
      "ACCEPTANCE CRITERIA:",
      ...handoff.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "Execute this handoff in the target repository.",
      "When finished, respond with JSON ONLY matching SpecialistResult:",
      '{ "status": "done"|"failed"|"blocked", "summary": string, "artifacts": [{"kind":"path"|"url"|"log_ref"|"note","value":string,"label"?:string}], "followUpHandoffs": [{"toRole": string, "objective": string, "contextSummary"?: string, "acceptanceCriteria"?: string[]}], "failureReason"?: string }',
    ].join("\n");

    const run = await this.runPrompt({
      role: handoff.toRole,
      prompt,
      handoffId: handoff.id,
      goalId: handoff.goalId,
    });

    handoff.conversationRunIds = [...handoff.conversationRunIds, run.id];
    handoff.updatedAt = now();

    if (run.status !== "finished") {
      handoff.status = "failed";
      handoff.failureReason = run.failureMessage ?? `Run status ${run.status}`;
      handoff.finishedAt = now();
      updateHandoff(this.db, handoff);
      bus.emit({ type: "handoff_updated", handoff });
      return handoff;
    }

    const parsed = run.resultText
      ? this.extractJson(run.resultText, SpecialistResultSchema)
      : null;

    if (!parsed) {
      // Treat finished-but-unparsed as done with raw summary
      handoff.status = "done";
      handoff.artifacts = [
        {
          kind: "note",
          value: run.resultText?.slice(0, 2000) ?? "No structured result",
          label: "raw_result",
        },
      ];
      handoff.finishedAt = now();
      updateHandoff(this.db, handoff);
      bus.emit({ type: "handoff_updated", handoff });
      return handoff;
    }

    if (parsed.status === "failed" || parsed.status === "blocked") {
      handoff.status = parsed.status === "blocked" ? "rejected" : "failed";
      handoff.failureReason = parsed.failureReason ?? parsed.summary;
      handoff.artifacts = parsed.artifacts;
      handoff.finishedAt = now();
    } else {
      handoff.status = "done";
      handoff.artifacts = parsed.artifacts;
      handoff.finishedAt = now();
    }
    updateHandoff(this.db, handoff);
    bus.emit({ type: "handoff_updated", handoff });

    for (const follow of parsed.followUpHandoffs) {
      if (!canHandoff(handoff.toRole, follow.toRole)) continue;
      if (
        follow.toRole !== "pm" &&
        follow.toRole !== "qa" &&
        !this.config.enabledRoles.includes(follow.toRole)
      ) {
        continue;
      }
      this.createHandoffRecord({
        fromRole: handoff.toRole,
        toRole: follow.toRole,
        objective: follow.objective,
        contextSummary: follow.contextSummary,
        acceptanceCriteria: follow.acceptanceCriteria,
        parentHandoffId: handoff.id,
        goalId: handoff.goalId,
      });
    }

    return handoff;
  }

  async runOversightReview(): Promise<number> {
    const { listRecentFailures, listHandoffs, listRuns, insertSuggestion } =
      await import("./db.js");
    const { computeMetrics } = await import("./metrics.js");

    const failures = listRecentFailures(this.db, 15);
    const friction = computeMetrics(this.db).friction
      .filter((f) => f.failed + f.rejected + f.pingPong > 0)
      .slice(0, 10);
    const recentHandoffs = listHandoffs(this.db).slice(0, 20);
    const recentRuns = listRuns(this.db, 20);

    const dossier = {
      failures: failures.map((f) => ({
        id: f.id,
        role: f.role,
        status: f.status,
        failureMessage: f.failureMessage,
        prompt: f.prompt.slice(0, 500),
      })),
      friction,
      recentHandoffs: recentHandoffs.map((h) => ({
        id: h.id,
        fromRole: h.fromRole,
        toRole: h.toRole,
        status: h.status,
        objective: h.objective.slice(0, 200),
        failureReason: h.failureReason,
      })),
      recentRunStats: recentRuns.map((r) => ({
        id: r.id,
        role: r.role,
        status: r.status,
        durationMs: r.durationMs,
      })),
    };

    const prompt = [
      "Review this swarm dossier and propose prompt/process improvements.",
      "Do not modify code. Return JSON ONLY:",
      '{ "suggestions": [{ "targetRole": string, "finding": string, "proposedPromptChange": string, "evidenceLogIds": string[] }] }',
      "",
      "DOSSIER:",
      JSON.stringify(dossier, null, 2),
    ].join("\n");

    const run = await this.runPrompt({ role: "oversight", prompt });
    if (run.status !== "finished" || !run.resultText) {
      return 0;
    }

    const output = this.extractJson(run.resultText, OversightOutputSchema);
    if (!output) return 0;

    let count = 0;
    for (const s of output.suggestions) {
      const ts = now();
      let suggestion: Suggestion = {
        id: uuid(),
        targetRole: s.targetRole,
        finding: s.finding,
        proposedPromptChange: s.proposedPromptChange,
        evidenceLogIds: s.evidenceLogIds,
        status: "pending",
        createdAt: ts,
        updatedAt: ts,
      };
      insertSuggestion(this.db, suggestion);

      if (this.config.ceoAutoApprove) {
        const accepted = acceptSuggestion(this.db, suggestion.id);
        if (accepted) suggestion = accepted;
      }

      bus.emit({ type: "suggestion_created", suggestion });
      count += 1;
    }
    return count;
  }
}

export { PmPlanSchema, SpecialistResultSchema, OversightOutputSchema };
