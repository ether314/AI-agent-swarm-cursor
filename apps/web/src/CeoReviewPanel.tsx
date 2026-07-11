import type { AgentRole, ConversationRun, Goal, Handoff } from "@corp-swarm/schema";
import { formatWhen } from "./ceo-requests-format";

type Props = {
  failedGoals: Goal[];
  failedHandoffs: Handoff[];
  failedRuns: ConversationRun[];
  errorRoles: Array<{ role: AgentRole }>;
  goalTitleById: Map<string, string>;
  selectedHandoffId: string | null;
  onInspectHandoff: (handoffId: string) => void;
  onInspectRun: (run: ConversationRun) => void;
  onInspectErrorRole: (role: AgentRole) => void;
  onRetryGoal: (prompt: string) => void;
};

export function CeoReviewPanel({
  failedGoals,
  failedHandoffs,
  failedRuns,
  errorRoles,
  goalTitleById,
  selectedHandoffId,
  onInspectHandoff,
  onInspectRun,
  onInspectErrorRole,
  onRetryGoal,
}: Props) {
  const needsReviewCount =
    failedGoals.length + failedHandoffs.length + errorRoles.length;

  return (
    <section className="panel ceo-review-page">
      <header className="ceo-review-page-header">
        <div>
          <h2>CEO review</h2>
          <p className="panel-sub">
            Goals, handoffs, and agents that did not complete successfully. Click an item to
            inspect the transcript on Mission, or dispatch a retry from the CEO directive box.
          </p>
        </div>
        {needsReviewCount > 0 ? (
          <span className="ceo-review-count">{needsReviewCount} need attention</span>
        ) : null}
      </header>

      {needsReviewCount === 0 ? (
        <div className="transcript-empty">
          Nothing needs review right now. Failed goals, handoffs, and agent errors will appear
          here.
        </div>
      ) : (
        <div className="ceo-review-body">
          {errorRoles.length > 0 && (
            <div className="ceo-review-block">
              <span className="active-now-label">Agents in error</span>
              <div className="active-now-chips">
                {errorRoles.map((r) => (
                  <button
                    key={r.role}
                    type="button"
                    className="active-chip active-chip-danger"
                    onClick={() => onInspectErrorRole(r.role)}
                  >
                    {r.role} · error
                  </button>
                ))}
              </div>
            </div>
          )}

          {failedGoals.length > 0 && (
            <div className="ceo-review-block">
              <span className="active-now-label">Failed goals ({failedGoals.length})</span>
              <div className="ceo-review-list">
                {failedGoals.map((g) => {
                  const relatedFails = failedHandoffs.filter((h) => h.goalId === g.id);
                  const topReason =
                    relatedFails.find((h) => h.failureReason)?.failureReason ??
                    "One or more handoffs on this goal failed or were rejected.";
                  return (
                    <div key={g.id} className="ceo-review-card ceo-review-card-goal">
                      <div className="ceo-review-card-head">
                        <span className="badge badge-failed">{g.status}</span>
                        <span className="ceo-review-when">{formatWhen(g.updatedAt)}</span>
                      </div>
                      <div className="ceo-review-title">{g.title}</div>
                      <p className="ceo-review-reason">{topReason}</p>
                      {relatedFails.length > 0 && (
                        <div className="ceo-review-related">
                          {relatedFails.slice(0, 4).map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              className="ceo-review-link"
                              onClick={() => onInspectHandoff(h.id)}
                            >
                              {h.fromRole} → {h.toRole} · {h.status}
                            </button>
                          ))}
                          {relatedFails.length > 4 ? (
                            <span className="org-meta">
                              +{relatedFails.length - 4} more failed handoffs
                            </span>
                          ) : null}
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          onRetryGoal(
                            `Retry failed goal: ${g.title}\n\nPrior failure: ${topReason.slice(0, 500)}`,
                          )
                        }
                      >
                        Dispatch retry
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {failedHandoffs.length > 0 && (
            <div className="ceo-review-block">
              <span className="active-now-label">Failed handoffs ({failedHandoffs.length})</span>
              <div className="ceo-review-list">
                {failedHandoffs.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className={`handoff-card handoff-card-failed ${selectedHandoffId === h.id ? "active" : ""}`}
                    onClick={() => onInspectHandoff(h.id)}
                  >
                    <div className="handoff-edge">
                      <span className="badge badge-failed">{h.status}</span>
                      {h.fromRole} → {h.toRole}
                      {h.goalId && goalTitleById.has(h.goalId) ? (
                        <span className="ceo-review-goal-tag">
                          · {goalTitleById.get(h.goalId)!.slice(0, 48)}
                        </span>
                      ) : null}
                      <span className="ceo-review-when"> · {formatWhen(h.updatedAt)}</span>
                    </div>
                    <div className="handoff-obj">{h.objective}</div>
                    {h.failureReason ? (
                      <p className="ceo-review-reason">{h.failureReason}</p>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          )}

          {failedRuns.length > 0 && (
            <div className="ceo-review-block">
              <span className="active-now-label">Recent failed runs</span>
              <div className="ceo-review-list">
                {failedRuns.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="ceo-review-card"
                    onClick={() => onInspectRun(r)}
                  >
                    <div className="ceo-review-card-head">
                      <span className="badge badge-failed">{r.status}</span>
                      <span className="org-meta">{r.role}</span>
                      <span className="ceo-review-when">{formatWhen(r.startedAt)}</span>
                    </div>
                    <p className="ceo-review-reason">{r.failureMessage}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
