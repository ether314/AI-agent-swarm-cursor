import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CeoGoalRequestSchema,
  SetTargetRequestSchema,
  AgentRoleSchema,
  type SwarmConfig,
  type ProjectBrief,
} from "@corp-swarm/schema";
import { HANDOFF_GRAPH, ROLE_PACKS } from "@corp-swarm/roles";
import type { Db } from "./db.js";
import {
  countQueuedHandoffs,
  getRun,
  isPaused,
  listAgentInstances,
  listGoals,
  listHandoffs,
  listRuns,
  listSuggestions,
  acceptSuggestion,
  updateSuggestionStatus,
} from "./db.js";
import { computeMetrics } from "./metrics.js";
import type { Orchestrator } from "./orchestrator.js";
import type { SwarmQueue } from "./queue.js";
import { recoverStuckWork } from "./recover.js";
import { saveLocalConfig } from "./config.js";
import { resolveTargetSource } from "./target-repo.js";
import { sniffProject } from "./project-brief.js";
import { bus } from "./events.js";

export type AppDeps = {
  db: Db;
  config: SwarmConfig;
  brief: ProjectBrief;
  orchestrator: Orchestrator;
  queue: SwarmQueue;
  apiKeyPresent: boolean;
};

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("*", cors({ origin: "*" }));

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      apiKeyPresent: deps.apiKeyPresent,
      targetRepo: deps.config.targetRepo,
      githubSource: deps.config.githubSource ?? null,
      paused: isPaused(deps.db),
    }),
  );

  app.get("/api/config", (c) =>
    c.json({
      config: deps.config,
      brief: deps.brief,
      apiKeyPresent: deps.apiKeyPresent,
      ceoAutoApprove: deps.config.ceoAutoApprove,
    }),
  );

  app.post("/api/config/target", async (c) => {
    const body = SetTargetRequestSchema.parse(await c.req.json());
    if (deps.orchestrator.getActiveRunCount() > 0) {
      return c.json(
        {
          error:
            "Agents are busy. Pause the swarm or wait for runs to finish before changing the target repo.",
        },
        409,
      );
    }

    try {
      const resolved = await resolveTargetSource(body.source, body.ref);
      const brief = sniffProject(resolved.targetRepo);
      const config = saveLocalConfig({
        targetRepo: resolved.targetRepo,
        githubSource: resolved.githubSource,
        githubRef: resolved.githubRef,
      });
      await deps.orchestrator.retarget(config, brief);
      deps.config = config;
      deps.brief = brief;

      bus.emit({
        type: "target_changed",
        targetRepo: config.targetRepo,
        githubSource: config.githubSource ?? null,
        githubRef: config.githubRef ?? null,
        briefSummary: brief.summary,
      });

      return c.json({
        config,
        brief,
        resolved: {
          cloned: resolved.cloned,
          pulled: resolved.pulled,
        },
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/api/org", (c) => {
    const instances = listAgentInstances(deps.db);
    const byRole = Object.fromEntries(instances.map((i) => [i.role, i]));
    const roles = [
      {
        role: "ceo" as const,
        title: "CEO (You)",
        status: "idle" as const,
        cursorAgentId: null,
        lastRunId: null,
      },
      ...Object.values(ROLE_PACKS).map((pack) => {
        const inst = byRole[pack.role];
        return {
          role: pack.role,
          title: pack.title,
          status: inst?.status ?? "idle",
          cursorAgentId: inst?.cursorAgentId ?? null,
          lastRunId: inst?.lastRunId ?? null,
        };
      }),
    ];
    return c.json({
      roles,
      graph: HANDOFF_GRAPH,
      paused: isPaused(deps.db),
      queueDepth: countQueuedHandoffs(deps.db),
    });
  });

  app.get("/api/goals", (c) => c.json({ goals: listGoals(deps.db) }));
  app.get("/api/handoffs", (c) => c.json({ handoffs: listHandoffs(deps.db) }));
  app.get("/api/runs", (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    return c.json({ runs: listRuns(deps.db, limit) });
  });
  app.get("/api/runs/:id", (c) => {
    const run = getRun(deps.db, c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ run });
  });

  app.post("/api/goals", async (c) => {
    if (!deps.apiKeyPresent) {
      return c.json(
        {
          error:
            "CURSOR_API_KEY is not set. Add it to .env before submitting goals.",
        },
        400,
      );
    }
    const body = CeoGoalRequestSchema.parse(await c.req.json());
    const goal = await deps.queue.submitCeoGoal(body.prompt, body.title);
    return c.json({ goal }, 201);
  });

  app.post("/api/swarm/pause", (c) => {
    deps.queue.pause();
    return c.json({ paused: true });
  });

  app.post("/api/swarm/resume", (c) => {
    deps.queue.resume();
    return c.json({ paused: false });
  });

  app.post("/api/swarm/recover", (c) => {
    const result = recoverStuckWork(deps.db);
    return c.json(result);
  });

  app.post("/api/agents/:role/cancel", async (c) => {
    const parsed = AgentRoleSchema.safeParse(c.req.param("role"));
    if (!parsed.success || parsed.data === "ceo") {
      return c.json({ error: "invalid role" }, 400);
    }
    const result = await deps.orchestrator.cancelRole(
      parsed.data,
      "Cancelled by CEO",
    );
    return c.json({ role: parsed.data, ...result });
  });

  app.get("/api/metrics", (c) => c.json(computeMetrics(deps.db)));

  app.get("/api/suggestions", (c) =>
    c.json({ suggestions: listSuggestions(deps.db) }),
  );

  app.post("/api/oversight/run", async (c) => {
    if (!deps.apiKeyPresent) {
      return c.json({ error: "CURSOR_API_KEY is not set" }, 400);
    }
    const count = await deps.orchestrator.runOversightReview();
    return c.json({ created: count, suggestions: listSuggestions(deps.db) });
  });

  app.post("/api/suggestions/:id/accept", (c) => {
    const id = c.req.param("id");
    const suggestion = acceptSuggestion(deps.db, id);
    if (!suggestion) return c.json({ error: "not found" }, 404);
    return c.json({ suggestion });
  });

  app.post("/api/suggestions/:id/reject", (c) => {
    const id = c.req.param("id");
    const suggestion = updateSuggestionStatus(deps.db, id, "rejected");
    if (!suggestion) return c.json({ error: "not found" }, 404);
    return c.json({ suggestion });
  });

  return app;
}
