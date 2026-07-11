import { useMemo, useState } from "react";
import type {
  AgentRole,
  PromptChangeEvent,
  PromptPortalSnapshot,
  RolePromptView,
} from "@corp-swarm/schema";
import { formatWhen } from "./ceo-requests-format";

type Props = {
  snapshot: PromptPortalSnapshot;
};

function changeKindLabel(kind: PromptChangeEvent["kind"]): string {
  switch (kind) {
    case "base_pack":
      return "Base pack";
    case "override_applied":
      return "Override applied";
    case "suggestion_proposed":
      return "Suggestion proposed";
    case "suggestion_accepted":
      return "Suggestion accepted";
    case "suggestion_rejected":
      return "Suggestion rejected";
    default:
      return kind;
  }
}

function changeKindClass(kind: PromptChangeEvent["kind"]): string {
  switch (kind) {
    case "base_pack":
      return "prompt-change-base";
    case "override_applied":
    case "suggestion_accepted":
      return "prompt-change-applied";
    case "suggestion_proposed":
      return "prompt-change-proposed";
    case "suggestion_rejected":
      return "prompt-change-rejected";
    default:
      return "";
  }
}

function RolePromptDetail({ roleView }: { roleView: RolePromptView }) {
  const [showEffective, setShowEffective] = useState(true);
  const [showHistory, setShowHistory] = useState(true);

  return (
    <div className="prompt-role-detail">
      <div className="prompt-role-meta">
        <span>
          {roleView.changeCount} change{roleView.changeCount === 1 ? "" : "s"} logged
        </span>
        {roleView.lastChangedAt ? (
          <span>Last change {formatWhen(roleView.lastChangedAt)}</span>
        ) : (
          <span>No changes logged yet</span>
        )}
        {roleView.activeOverrides.length > 0 ? (
          <span>{roleView.activeOverrides.length} active override(s)</span>
        ) : null}
      </div>

      {!roleView.hasSystemPrompt ? (
        <p className="prompt-human-note">{roleView.effectiveSystemPrompt}</p>
      ) : (
        <>
          {roleView.basePack ? (
            <section className="prompt-section">
              <h3>Base role pack (code)</h3>
              <div className="prompt-structured">
                <div>
                  <span className="prompt-field-label">Mission</span>
                  <p>{roleView.basePack.mission}</p>
                </div>
                <div>
                  <span className="prompt-field-label">Boundaries</span>
                  <ul>
                    {roleView.basePack.boundaries.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span className="prompt-field-label">Success criteria</span>
                  <ul>
                    {roleView.basePack.successCriteria.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span className="prompt-field-label">Handoff contract</span>
                  <p>{roleView.basePack.handoffContract}</p>
                </div>
              </div>
            </section>
          ) : null}

          {roleView.activeOverrides.length > 0 ? (
            <section className="prompt-section">
              <h3>Active overrides</h3>
              <ul className="prompt-override-list">
                {roleView.activeOverrides.map((override) => (
                  <li key={override}>{override}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="prompt-section">
            <div className="prompt-section-head">
              <h3>Effective system prompt</h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowEffective((v) => !v)}
              >
                {showEffective ? "Hide" : "Show"}
              </button>
            </div>
            {showEffective ? (
              <pre className="prompt-code">{roleView.effectiveSystemPrompt}</pre>
            ) : null}
          </section>
        </>
      )}

      <section className="prompt-section">
        <div className="prompt-section-head">
          <h3>Change history</h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? "Hide" : "Show"}
          </button>
        </div>
        {showHistory ? (
          roleView.changes.length === 0 ? (
            <p className="prompt-empty">No prompt changes recorded for this role yet.</p>
          ) : (
            <ol className="prompt-change-timeline">
              {roleView.changes.map((change) => (
                <li key={change.id} className="prompt-change-item">
                  <div className="prompt-change-head">
                    <span className={`prompt-change-kind ${changeKindClass(change.kind)}`}>
                      {changeKindLabel(change.kind)}
                    </span>
                    <span className="prompt-change-when">{formatWhen(change.createdAt)}</span>
                  </div>
                  <div className="prompt-change-summary">{change.summary}</div>
                  {change.detail ? (
                    <pre className="prompt-change-detail">{change.detail}</pre>
                  ) : null}
                </li>
              ))}
            </ol>
          )
        ) : null}
      </section>
    </div>
  );
}

export function PromptPortalPanel({ snapshot }: Props) {
  const [selectedRole, setSelectedRole] = useState<AgentRole>("pm");
  const selected = useMemo(
    () => snapshot.roles.find((r) => r.role === selectedRole) ?? snapshot.roles[0],
    [snapshot.roles, selectedRole],
  );

  return (
    <section className="panel prompt-portal">
      <div className="prompt-portal-header">
        <div>
          <h2>Agent prompt portal</h2>
          <p className="panel-sub">
            Underlying system prompts for each agent — base role packs, live overrides, effective
            assembled prompts, and a change log (code updates, oversight suggestions, applied
            overrides).
          </p>
        </div>
      </div>

      <div className="prompt-portal-stats">
        <div className="prompt-stat">
          <span className="prompt-stat-value">{snapshot.roles.length}</span>
          <span className="prompt-stat-label">Roles</span>
        </div>
        <div className="prompt-stat">
          <span className="prompt-stat-value">{snapshot.totals.totalChanges}</span>
          <span className="prompt-stat-label">Changes logged</span>
        </div>
        <div className="prompt-stat">
          <span className="prompt-stat-value">{snapshot.totals.totalOverrides}</span>
          <span className="prompt-stat-label">Active overrides</span>
        </div>
        <div className="prompt-stat">
          <span className="prompt-stat-value">
            {snapshot.totals.lastChangedAt ? formatWhen(snapshot.totals.lastChangedAt) : "—"}
          </span>
          <span className="prompt-stat-label">Last change</span>
        </div>
      </div>

      <section className="prompt-section prompt-brief-section">
        <h3>Project brief (injected into every system prompt)</h3>
        <pre className="prompt-code prompt-brief">{snapshot.projectBriefSummary}</pre>
      </section>

      <section className="prompt-section">
        <h3>Runtime task templates</h3>
        <p className="panel-sub">
          Task prompts the orchestrator wraps around system prompts during planning, handoffs, and
          oversight. Placeholders like {"{{ceo_goal}}"} are filled at runtime.
        </p>
        <div className="prompt-template-list">
          {snapshot.runtimeTemplates.map((template) => (
            <details key={template.id} className="prompt-template-card">
              <summary>
                {template.title}
                {template.usedByRole ? ` · ${template.usedByRole}` : ""}
              </summary>
              <p className="prompt-template-desc">{template.description}</p>
              <pre className="prompt-code">{template.template}</pre>
            </details>
          ))}
        </div>
      </section>

      <div className="prompt-portal-layout">
        <nav className="prompt-role-nav" aria-label="Agent roles">
          {snapshot.roles.map((roleView) => (
            <button
              key={roleView.role}
              type="button"
              className={`prompt-role-tab ${selectedRole === roleView.role ? "active" : ""}`}
              onClick={() => setSelectedRole(roleView.role)}
            >
              <span className="prompt-role-tab-name">{roleView.role}</span>
              <span className="prompt-role-tab-meta">
                {roleView.changeCount} change{roleView.changeCount === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </nav>

        {selected ? (
          <div className="prompt-role-panel">
            <div className="prompt-role-panel-head">
              <h3>{selected.title}</h3>
              <span className="org-meta">{selected.role}</span>
            </div>
            <RolePromptDetail roleView={selected} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
