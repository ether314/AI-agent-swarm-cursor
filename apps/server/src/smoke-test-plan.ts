import type { PmPlan } from "@corp-swarm/schema";

const SMOKE_TEST_RE =
  /\b(smoke\s*test|dispatch_canary|agent[\s-]?comms|agents?\s+can\s+talk)\b/i;

export function isSmokeTestGoal(prompt: string): boolean {
  return SMOKE_TEST_RE.test(prompt);
}

/** Deterministic 4-wave canary — never skip to DevOps without QA on this goal. */
export function buildSmokeTestPlan(ceoPrompt: string): PmPlan {
  const summary =
    "DISPATCH_CANARY smoke test: sequential backend → frontend → qa → devops read-only contract pings on this goal. Do not assume prior goals completed upstream waves.";

  return {
    summary,
    handoffs: [
      {
        phase: 1,
        toRole: "backend",
        objective:
          "Wave 1 of 4 — backend read-only contract ping (canary-backend-comms-001)",
        contextSummary: [
          `CEO goal: ${ceoPrompt}`,
          "Read-only probe in the target repo. Do not run deploy, build, or npm install.",
          "Persist artifacts/canary-backend-comms-001.json with SpecialistResult JSON.",
        ].join("\n"),
        acceptanceCriteria: [
          "Verify target repo is reachable and respond with SpecialistResult status=done|failed|blocked.",
          "Persist artifacts/canary-backend-comms-001.json.",
          "Return JSON-only SpecialistResult; no deploy or build commands.",
        ],
      },
      {
        phase: 2,
        toRole: "frontend",
        objective:
          "Wave 2 of 4 — frontend read-only contract ping (canary-frontend-comms-002)",
        contextSummary: [
          "Upstream: wave 1 backend artifact canary-backend-comms-001 must be status=done.",
          "Read-only probe. Persist artifacts/canary-frontend-comms-002.json.",
        ].join("\n"),
        acceptanceCriteria: [
          "Confirm artifacts/canary-backend-comms-001.json exists with status=done; else return blocked.",
          "Persist artifacts/canary-frontend-comms-002.json.",
          "Return JSON-only SpecialistResult; no deploy or build commands.",
        ],
      },
      {
        phase: 3,
        toRole: "qa",
        objective:
          "Wave 3 of 4 — QA aggregation GO/NO-GO (canary-qa-comms-003)",
        contextSummary: [
          "Verify upstream backend and frontend canary artifacts before GO.",
          "Read-only verification gate for the agent-comms chain.",
        ].join("\n"),
        acceptanceCriteria: [
          "Read canary-backend-comms-001 and canary-frontend-comms-002 artifacts; both must be done.",
          "Persist artifacts/canary-qa-comms-003.json.",
          "SpecialistResult summary must end with GO or NO-GO.",
        ],
      },
      {
        phase: 4,
        toRole: "devops",
        objective:
          "Wave 4 of 4 — devops read-only infra contract ping (canary-devops-comms-004)",
        contextSummary: [
          "QA wave 3 must return GO (canary-qa-comms-003 status=done, summary ends GO).",
          "Read-only infra probe — do not run npm run deploy, build, or install.",
        ].join("\n"),
        acceptanceCriteria: [
          "Confirm QA artifact canary-qa-comms-003 returned GO; else return blocked.",
          "Read firebase.json and package.json deploy script (read-only).",
          "Persist artifacts/canary-devops-comms-004.json.",
          "SpecialistResult summary must end with GO or NO-GO.",
        ],
      },
    ],
  };
}
