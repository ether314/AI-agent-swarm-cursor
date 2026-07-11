import { createHash } from "node:crypto";
import type {
  AgentRole,
  PromptPortalSnapshot,
  ProjectBrief,
  RolePromptView,
  RuntimePromptTemplate,
} from "@corp-swarm/schema";
import { WORKER_ROLES } from "@corp-swarm/schema";
import {
  buildSystemPrompt,
  getRolePack,
  ROLE_PACKS,
  type RolePack,
} from "@corp-swarm/roles";
import type { Db } from "./db.js";
import {
  backfillPromptChangeHistory,
  getMeta,
  insertPromptChangeEvent,
  listPromptChangeEvents,
  listRoleOverrideRecords,
  listRoleOverrides,
  setMeta,
} from "./db.js";
import { compressOverrides, DEFAULT_CONTEXT_CAPS } from "./context-compress.js";

export const RUNTIME_PROMPT_TEMPLATES: RuntimePromptTemplate[] = [
  {
    id: "pm_planning",
    title: "PM goal planning (task prompt)",
    usedByRole: "pm",
    description:
      "Appended after the PM system prompt when breaking a CEO goal into phased handoffs. Pipeline sequencing is enforced in code.",
    template: [
      "CEO goal → phased specialist handoffs. Pipeline phases are enforced in code.",
      "",
      "GOAL: {{ceo_goal}}",
      "",
      "Return JSON ONLY:",
      '{ "summary": string, "handoffs": [{ "phase": number, "toRole": "backend"|"frontend"|"middleware"|"qa"|"devops", "objective": string, "contextSummary": string, "acceptanceCriteria": string[] }] }',
      "",
      "Prefer fewest specialists; one handoff per phase when possible. Keep contextSummary short and task-specific (do not repeat the full plan summary).",
      "Enabled: {{enabled_roles}}",
    ].join("\n"),
  },
  {
    id: "handoff_execution",
    title: "Specialist handoff execution (task prompt)",
    usedByRole: null,
    description:
      "Wrapped around each handoff for specialists. Includes capped GOAL DIGEST from the DB plus task context. Handoff IDs stay in the DB only.",
    template: [
      "FROM: {{from_role}} → {{to_role}}",
      "OBJECTIVE: {{objective}}",
      "",
      "GOAL DIGEST:",
      "{{goal_digest}}",
      "",
      "TASK CONTEXT:",
      "{{context_summary}}",
      "",
      "ACCEPTANCE:",
      "{{acceptance_criteria}}",
      "",
      "Execute in the target repo. Stream tool use immediately.",
      "Finish with JSON ONLY matching SpecialistResult.",
    ].join("\n"),
  },
  {
    id: "oversight_review",
    title: "Oversight dossier review (task prompt)",
    usedByRole: "oversight",
    description:
      "Failure/friction dossier sent to the oversight agent to propose prompt improvements.",
    template: [
      "Review this swarm dossier and propose prompt/process improvements.",
      "",
      "{{dossier_json}}",
      "",
      "Return JSON ONLY matching OversightOutput with suggestions[].",
    ].join("\n"),
  },
];

function basePackFingerprint(pack: RolePack): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mission: pack.mission,
        boundaries: pack.boundaries,
        successCriteria: pack.successCriteria,
        handoffContract: pack.handoffContract,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function syncBasePackChangeLog(db: Db): void {
  backfillPromptChangeHistory(db);

  for (const role of WORKER_ROLES) {
    const pack = getRolePack(role);
    if (!pack) continue;

    const fingerprint = basePackFingerprint(pack);
    const metaKey = `prompt_base_hash:${role}`;
    const previous = getMeta(db, metaKey);

    if (previous && previous !== fingerprint) {
      insertPromptChangeEvent(db, {
        id: `base-pack-${role}-${fingerprint}`,
        role,
        kind: "base_pack",
        summary: "Base role pack updated in code",
        detail: `Fingerprint changed ${previous.slice(0, 8)} → ${fingerprint.slice(0, 8)}`,
      });
    }

    if (!previous) {
      insertPromptChangeEvent(db, {
        id: `base-pack-${role}-initial`,
        role,
        kind: "base_pack",
        summary: "Base role pack recorded",
        detail: `Initial fingerprint ${fingerprint.slice(0, 8)}`,
      });
    }

    setMeta(db, metaKey, fingerprint);
  }
}

function buildRolePromptView(
  db: Db,
  role: AgentRole,
  brief: ProjectBrief,
): RolePromptView {
  if (role === "ceo") {
    return {
      role,
      title: "CEO (You)",
      hasSystemPrompt: false,
      basePack: null,
      activeOverrides: [],
      effectiveSystemPrompt:
        "The CEO is the human operator. Goals are dispatched from the Corp Swarm UI; there is no automated system prompt for this role.",
      changeCount: 0,
      lastChangedAt: null,
      changes: [],
    };
  }

  const pack = getRolePack(role)!;
  const allOverrides = listRoleOverrides(db, role);
  const overrides = compressOverrides(allOverrides, 3, DEFAULT_CONTEXT_CAPS);
  const effectiveSystemPrompt = buildSystemPrompt(pack, brief.summary, {
    overrides,
  });
  const changes = listPromptChangeEvents(db, role);
  const lastChangedAt = changes[0]?.createdAt ?? null;

  return {
    role,
    title: pack.title,
    hasSystemPrompt: true,
    basePack: {
      role: pack.role,
      title: pack.title,
      mission: pack.mission,
      boundaries: pack.boundaries,
      successCriteria: pack.successCriteria,
      handoffContract: pack.handoffContract,
    },
    activeOverrides: overrides,
    effectiveSystemPrompt,
    changeCount: changes.length,
    lastChangedAt,
    changes,
  };
}

export function computePromptPortal(db: Db, brief: ProjectBrief): PromptPortalSnapshot {
  syncBasePackChangeLog(db);

  const roles: RolePromptView[] = (["ceo", ...WORKER_ROLES] as AgentRole[]).map((role) =>
    buildRolePromptView(db, role, brief),
  );

  const overrideRecords = listRoleOverrideRecords(db);
  const allChanges = listPromptChangeEvents(db);
  const rolesWithOverrides = new Set(overrideRecords.map((r) => r.role)).size;

  return {
    projectBriefSummary: brief.summary,
    roles,
    runtimeTemplates: RUNTIME_PROMPT_TEMPLATES,
    totals: {
      rolesWithOverrides,
      totalOverrides: overrideRecords.length,
      totalChanges: allChanges.length,
      lastChangedAt: allChanges[0]?.createdAt ?? null,
    },
  };
}

/** Expose raw role packs for API consumers that want structured fields only. */
export function listRolePackDefinitions() {
  return ROLE_PACKS;
}
