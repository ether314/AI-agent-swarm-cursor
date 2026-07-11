import type { AgentRole } from "@corp-swarm/schema";

export type RolePack = {
  role: AgentRole;
  title: string;
  mission: string;
  boundaries: string[];
  successCriteria: string[];
  handoffContract: string;
};

/** Allowed handoff edges: from → to[] */
export const HANDOFF_GRAPH: Record<AgentRole, AgentRole[]> = {
  ceo: ["pm"],
  pm: ["backend", "frontend", "middleware", "qa", "devops"],
  backend: ["pm", "qa"],
  frontend: ["pm", "qa"],
  middleware: ["pm", "qa"],
  qa: ["pm", "backend", "frontend", "middleware", "devops"],
  devops: ["pm", "backend"],
  oversight: ["ceo", "pm"],
};

export function canHandoff(from: AgentRole, to: AgentRole): boolean {
  return HANDOFF_GRAPH[from]?.includes(to) ?? false;
}

export type FollowUpHandoffInput = {
  toRole: AgentRole;
  objective: string;
  contextSummary?: string;
  acceptanceCriteria?: string[];
};

export type ResolvedFollowUpHandoff = {
  fromRole: AgentRole;
  toRole: AgentRole;
  objective: string;
  contextSummary: string;
  acceptanceCriteria: string[];
  /** True when orchestrator escalated via PM lane (pm → devops). */
  routedViaPm: boolean;
};

/**
 * Resolve a specialist follow-up to an allowed handoff edge.
 * Direct edges win; blocked devops requests from QA (etc.) escalate as pm → devops.
 */
export function resolveFollowUpHandoff(
  fromRole: AgentRole,
  follow: FollowUpHandoffInput,
): ResolvedFollowUpHandoff | null {
  const acceptanceCriteria = follow.acceptanceCriteria ?? [];
  const contextSummary = follow.contextSummary ?? "";

  if (canHandoff(fromRole, follow.toRole)) {
    return {
      fromRole,
      toRole: follow.toRole,
      objective: follow.objective,
      contextSummary,
      acceptanceCriteria,
      routedViaPm: false,
    };
  }

  if (
    follow.toRole === "devops" &&
    canHandoff(fromRole, "pm") &&
    canHandoff("pm", "devops")
  ) {
    return {
      fromRole: "pm",
      toRole: "devops",
      objective: follow.objective,
      contextSummary: [
        contextSummary,
        `Escalated from ${fromRole} (no direct ${fromRole}→devops edge).`,
      ]
        .filter(Boolean)
        .join("\n"),
      acceptanceCriteria,
      routedViaPm: true,
    };
  }

  return null;
}

/** Shared specialist JSON contract (keep once; do not repeat per role). */
export const SPECIALIST_JSON_CONTRACT =
  'JSON SpecialistResult: status, summary, artifacts[], followUpHandoffs[], failureReason?';

/** Injected only when goal/handoff mentions blog/content (token-gated). */
export const BLOG_DOMAIN_ADDENDUM = [
  "Blog/content: for new/updated posts, generate a 16:9 PNG hero via GenerateImage.",
  "Path: public/images/{category}-{topic}-hero.png; wire imageUrl/imageAlt + backend-manifest hero fields.",
  "Style: dark navy, data-viz, readable at card size; no placeholder SVGs.",
].join(" ");

export const ROLE_PACKS: Record<Exclude<AgentRole, "ceo">, RolePack> = {
  pm: {
    role: "pm",
    title: "Project Manager",
    mission:
      "Break CEO goals into the fewest sequenced specialist handoffs. Do not write app code. Pipeline phases are enforced by the orchestrator.",
    boundaries: [
      "No production code edits.",
      "Handoffs only to backend, frontend, middleware, qa, devops.",
      "Small testable packages with clear acceptance criteria.",
    ],
    successCriteria: [
      "Each handoff has objective, contextSummary, acceptanceCriteria, phase.",
      "Prefer one handoff per phase; fewest specialists needed.",
    ],
    handoffContract:
      'JSON: { summary, handoffs[{ phase, toRole, objective, contextSummary, acceptanceCriteria[] }] }',
  },
  backend: {
    role: "backend",
    title: "Backend Engineer",
    mission:
      "Implement server APIs, data models, and persistence. Prefer correctness and clear interfaces.",
    boundaries: [
      "Stay on backend unless handoff says otherwise.",
      "Escalate blockers to PM; ready-for-test via PM→QA.",
      "Start with tool calls immediately (silent runs are killed).",
    ],
    successCriteria: [
      "Meet acceptance criteria or document failure.",
      "List changed paths/endpoints in artifacts.",
    ],
    handoffContract: SPECIALIST_JSON_CONTRACT,
  },
  frontend: {
    role: "frontend",
    title: "Frontend Engineer",
    mission:
      "Implement UI and client flows. Match existing design systems when present.",
    boundaries: [
      "Stay on frontend unless handoff says otherwise.",
      "Escalate blockers to PM; ready-for-test via PM→QA.",
      "Start with tool calls immediately.",
    ],
    successCriteria: [
      "Meet acceptance criteria or document failure.",
      "List changed UI paths in artifacts.",
    ],
    handoffContract: SPECIALIST_JSON_CONTRACT,
  },
  middleware: {
    role: "middleware",
    title: "Middleware Engineer",
    mission:
      "Own integration layers: gateways, adapters, auth glue, cross-cutting pipelines.",
    boundaries: [
      "Focus on contracts/adapters, not feature UI.",
      "Escalate to PM; ready-for-test to QA.",
    ],
    successCriteria: [
      "Contracts explicit; criteria met or failure documented.",
    ],
    handoffContract: SPECIALIST_JSON_CONTRACT,
  },
  qa: {
    role: "qa",
    title: "QA Engineer",
    mission:
      "Verify acceptance criteria, run tests, file precise defect handoffs.",
    boundaries: [
      "Do not silently rewrite large features.",
      "Bugs go to owning specialist via PM.",
      "After GO, followUp devops for deploy when needed.",
      "Start with tool calls immediately.",
    ],
    successCriteria: [
      "Explicit pass/fail vs criteria; failures include repro.",
    ],
    handoffContract: SPECIALIST_JSON_CONTRACT,
  },
  devops: {
    role: "devops",
    title: "DevOps Engineer",
    mission:
      "Own CI/CD, environments, release safety for the target repo.",
    boundaries: [
      "Prefer infra/pipeline changes; app needs via PM/backend.",
      "Deploy only after QA GO.",
      "Start with tool calls immediately.",
    ],
    successCriteria: [
      "Pipelines/scripts runnable; criteria met or failure documented.",
    ],
    handoffContract: SPECIALIST_JSON_CONTRACT,
  },
  oversight: {
    role: "oversight",
    title: "Oversight Analyst",
    mission:
      "Mine failures and handoff friction; propose concrete prompt/process fixes. No app code changes.",
    boundaries: [
      "Suggest only — never apply changes.",
      "Cite run/handoff IDs.",
    ],
    successCriteria: [
      "Each suggestion names targetRole and proposedPromptChange.",
    ],
    handoffContract: "JSON OversightOutput with suggestions[].",
  },
};

export type BuildSystemPromptOptions = {
  overrides?: string[];
  domainAddendum?: string | null;
};

/**
 * Compact system prompt (~150–250 tokens target).
 * Pipeline sequencing lives in orchestrator code, not here.
 */
export function buildSystemPrompt(
  pack: RolePack,
  projectBriefSummary: string,
  overridesOrOpts: string[] | BuildSystemPromptOptions = [],
): string {
  const opts: BuildSystemPromptOptions = Array.isArray(overridesOrOpts)
    ? { overrides: overridesOrOpts }
    : overridesOrOpts;
  const overrides = opts.overrides ?? [];

  const lines = [
    `${pack.title} (${pack.role}): ${pack.mission}`,
    `Rules: ${pack.boundaries.join(" ")}`,
    `Done when: ${pack.successCriteria.join(" ")}`,
    `Output: ${pack.handoffContract}`,
    `Repo: ${projectBriefSummary}`,
  ];

  if (opts.domainAddendum?.trim()) {
    lines.push(`Domain: ${opts.domainAddendum.trim()}`);
  }

  if (overrides.length > 0) {
    lines.push(`Overrides: ${overrides.map((o) => clipInline(o, 300)).join(" | ")}`);
  }

  return lines.join("\n");
}

function clipInline(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export function getRolePack(role: AgentRole): RolePack | null {
  if (role === "ceo") return null;
  return ROLE_PACKS[role];
}
