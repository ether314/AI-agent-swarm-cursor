import { z } from "zod";

export const AgentRoleSchema = z.enum([
  "ceo",
  "pm",
  "backend",
  "frontend",
  "middleware",
  "qa",
  "devops",
  "oversight",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const WORKER_ROLES = [
  "pm",
  "backend",
  "frontend",
  "middleware",
  "qa",
  "devops",
  "oversight",
] as const satisfies readonly AgentRole[];

export const HandoffStatusSchema = z.enum([
  "queued",
  "accepted",
  "in_progress",
  "done",
  "failed",
  "rejected",
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const ArtifactSchema = z.object({
  kind: z.enum(["path", "url", "log_ref", "note"]),
  value: z.string(),
  label: z.string().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const HandoffSchema = z.object({
  id: z.string(),
  fromRole: AgentRoleSchema,
  toRole: AgentRoleSchema,
  status: HandoffStatusSchema,
  objective: z.string(),
  contextSummary: z.string(),
  acceptanceCriteria: z.array(z.string()),
  artifacts: z.array(ArtifactSchema).default([]),
  parentHandoffId: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
  conversationRunIds: z.array(z.string()).default([]),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const CreateHandoffSchema = z.object({
  fromRole: AgentRoleSchema,
  toRole: AgentRoleSchema,
  objective: z.string().min(1),
  contextSummary: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  parentHandoffId: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
});
export type CreateHandoff = z.infer<typeof CreateHandoffSchema>;

export const GoalStatusSchema = z.enum([
  "queued",
  "planning",
  "executing",
  "done",
  "failed",
  "cancelled",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  status: GoalStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const RunStatusSchema = z.enum([
  "running",
  "finished",
  "error",
  "cancelled",
  "startup_error",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ConversationRunSchema = z.object({
  id: z.string(),
  cursorRunId: z.string().nullable(),
  cursorAgentId: z.string().nullable(),
  role: AgentRoleSchema,
  handoffId: z.string().nullable(),
  goalId: z.string().nullable(),
  status: RunStatusSchema,
  prompt: z.string(),
  resultText: z.string().nullable(),
  failureKind: z.enum(["none", "run_error", "startup_error"]).default("none"),
  failureMessage: z.string().nullable(),
  transcriptJson: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type ConversationRun = z.infer<typeof ConversationRunSchema>;

export const AgentInstanceSchema = z.object({
  role: AgentRoleSchema,
  cursorAgentId: z.string().nullable(),
  status: z.enum(["idle", "busy", "error", "paused"]),
  lastRunId: z.string().nullable(),
  updatedAt: z.string(),
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;

export const SuggestionStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

export const SuggestionSchema = z.object({
  id: z.string(),
  targetRole: AgentRoleSchema,
  finding: z.string(),
  proposedPromptChange: z.string(),
  evidenceLogIds: z.array(z.string()).default([]),
  status: SuggestionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const ProjectBriefSchema = z.object({
  path: z.string(),
  name: z.string().nullable(),
  languages: z.array(z.string()),
  packageManagers: z.array(z.string()),
  testCommands: z.array(z.string()),
  summary: z.string(),
});
export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;

export const SwarmConfigSchema = z.object({
  targetRepo: z.string().min(1),
  model: z.string().default("composer-2.5"),
  maxConcurrentAgents: z.number().int().positive().default(2),
  enabledRoles: z.array(AgentRoleSchema).default([
    "pm",
    "backend",
    "frontend",
    "middleware",
    "qa",
    "devops",
    "oversight",
  ]),
  serverPort: z.number().int().default(8787),
  webPort: z.number().int().default(5173),
  /** When true, CEO auto-accepts every oversight suggestion (applies role overrides immediately). */
  ceoAutoApprove: z.boolean().default(true),
  /** Kill + rotate agents that produce no SDK output for this long (ms). */
  silentStallMs: z.number().int().positive().default(90_000),
  /** Max automatic requeues per handoff after a silent stall. */
  maxSilentRetries: z.number().int().positive().default(2),
  /** How often the silent-run watchdog polls in-flight agents (ms). */
  silentWatchdogIntervalMs: z.number().int().positive().default(15_000),
  /** Optional GitHub URL or owner/repo that produced the current targetRepo checkout. */
  githubSource: z.string().nullable().optional(),
  githubRef: z.string().nullable().optional(),
});
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

export const SetTargetRequestSchema = z.object({
  /** Absolute local path, GitHub URL, or owner/repo shorthand. */
  source: z.string().min(1),
  /** Optional branch/tag/commit for GitHub clones. */
  ref: z.string().min(1).optional(),
});
export type SetTargetRequest = z.infer<typeof SetTargetRequestSchema>;

export const RoleMetricsSchema = z.object({
  role: AgentRoleSchema,
  totalRuns: z.number(),
  finished: z.number(),
  errors: z.number(),
  cancelled: z.number(),
  startupErrors: z.number(),
  successRate: z.number(),
  avgDurationMs: z.number().nullable(),
  handoffsCreated: z.number(),
  handoffsReceived: z.number(),
  handoffsFailed: z.number(),
  handoffsRejected: z.number(),
  reopenCount: z.number(),
});
export type RoleMetrics = z.infer<typeof RoleMetricsSchema>;

export const HandoffFrictionSchema = z.object({
  fromRole: AgentRoleSchema,
  toRole: AgentRoleSchema,
  total: z.number(),
  failed: z.number(),
  rejected: z.number(),
  pingPong: z.number(),
});
export type HandoffFriction = z.infer<typeof HandoffFrictionSchema>;

export const MetricsSnapshotSchema = z.object({
  byRole: z.array(RoleMetricsSchema),
  friction: z.array(HandoffFrictionSchema),
  swarmPaused: z.boolean(),
  queueDepth: z.number(),
  activeRuns: z.number(),
});
export type MetricsSnapshot = z.infer<typeof MetricsSnapshotSchema>;

export const WsEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent_status"),
    role: AgentRoleSchema,
    status: z.enum(["idle", "busy", "error", "paused"]),
    lastRunId: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("handoff_updated"),
    handoff: HandoffSchema,
  }),
  z.object({
    type: z.literal("goal_updated"),
    goal: GoalSchema,
  }),
  z.object({
    type: z.literal("run_started"),
    run: ConversationRunSchema,
  }),
  z.object({
    type: z.literal("run_chunk"),
    runId: z.string(),
    role: AgentRoleSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal("run_finished"),
    run: ConversationRunSchema,
  }),
  z.object({
    type: z.literal("suggestion_created"),
    suggestion: SuggestionSchema,
  }),
  z.object({
    type: z.literal("swarm_state"),
    paused: z.boolean(),
    queueDepth: z.number(),
  }),
  z.object({
    type: z.literal("target_changed"),
    targetRepo: z.string(),
    githubSource: z.string().nullable(),
    githubRef: z.string().nullable(),
    briefSummary: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export const CeoGoalRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().optional(),
});
export type CeoGoalRequest = z.infer<typeof CeoGoalRequestSchema>;

export const PmPlanSchema = z.object({
  summary: z.string(),
  handoffs: z
    .array(
      z.object({
        toRole: z.enum([
          "backend",
          "frontend",
          "middleware",
          "qa",
          "devops",
        ]),
        objective: z.string(),
        contextSummary: z.string().default(""),
        acceptanceCriteria: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type PmPlan = z.infer<typeof PmPlanSchema>;

export const SpecialistResultSchema = z.object({
  status: z.enum(["done", "failed", "blocked"]),
  summary: z.string(),
  artifacts: z.array(ArtifactSchema).default([]),
  followUpHandoffs: z
    .array(
      z.object({
        toRole: AgentRoleSchema,
        objective: z.string(),
        contextSummary: z.string().default(""),
        acceptanceCriteria: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  failureReason: z.string().optional(),
});
export type SpecialistResult = z.infer<typeof SpecialistResultSchema>;

export const OversightOutputSchema = z.object({
  suggestions: z.array(
    z.object({
      targetRole: AgentRoleSchema,
      finding: z.string(),
      proposedPromptChange: z.string(),
      evidenceLogIds: z.array(z.string()).default([]),
    }),
  ),
});
export type OversightOutput = z.infer<typeof OversightOutputSchema>;
