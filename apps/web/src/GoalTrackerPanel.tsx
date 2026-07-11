import type { GoalTrackerSnapshot, TrackerMilestone } from "./goal-tracker";

type Props = {
  tracker: GoalTrackerSnapshot;
  paused: boolean;
  onSelectRole: (role: string) => void;
};

function milestoneIcon(status: TrackerMilestone["status"]): string {
  if (status === "complete") return "✓";
  if (status === "active") return "●";
  if (status === "failed") return "!";
  return "○";
}

export function GoalTrackerPanel({ tracker, paused, onSelectRole }: Props) {
  const { goal, milestones, activeAgents, blockedHandoffs, bottleneck, alerts } = tracker;

  if (!goal || !["queued", "planning", "executing"].includes(goal.status)) {
    return (
      <section className="panel pipeline-tracker pipeline-tracker-idle">
        <div className="pipeline-tracker-header">
          <h2>Pipeline tracker</h2>
          <span className="pipeline-eta">No active goal</span>
        </div>
        <p className="panel-sub">
          Dispatch a CEO goal to see Domino&apos;s-style progress — milestones left,
          active agents, bottlenecks, and stall timers.
        </p>
      </section>
    );
  }

  return (
    <section
      className={`panel pipeline-tracker ${activeAgents.length > 0 ? "pipeline-tracker-live" : ""}`}
    >
      <div className="pipeline-tracker-header">
        <h2>Pipeline tracker</h2>
        <div className="pipeline-tracker-meta">
          {tracker.etaMinutes != null ? (
            <span className="pipeline-eta">
              ~{tracker.etaMinutes} min remaining
            </span>
          ) : null}
          <span className="pipeline-remaining">
            {tracker.remainingSteps} step{tracker.remainingSteps === 1 ? "" : "s"} left
          </span>
        </div>
      </div>

      <p className="pipeline-goal-title">{goal.title}</p>

      <div className="pipeline-progress-bar" aria-hidden>
        <span style={{ width: `${tracker.progressPercent}%` }} />
      </div>
      <p className="pipeline-progress-label">
        {tracker.progressPercent}% · {tracker.completedMilestones} of{" "}
        {milestones.length} milestones
        {paused ? " · swarm paused" : ""}
      </p>

      <ol className="pipeline-steps">
        {milestones.map((m, i) => (
          <li
            key={m.id}
            className={`pipeline-step pipeline-step-${m.status}`}
          >
            <span className="pipeline-step-icon" aria-hidden>
              {milestoneIcon(m.status)}
            </span>
            <div className="pipeline-step-body">
              <div className="pipeline-step-label">{m.label}</div>
              <div className="pipeline-step-hint">{m.hint}</div>
            </div>
            {i < milestones.length - 1 ? (
              <span className="pipeline-step-connector" aria-hidden />
            ) : null}
          </li>
        ))}
      </ol>

      {activeAgents.length > 0 && (
        <div className="pipeline-active-block">
          <span className="active-now-label">Active agents ({activeAgents.length})</span>
          <div className="pipeline-agent-list">
            {activeAgents.map((a) => (
              <button
                key={a.role}
                type="button"
                className={`pipeline-agent-card pipeline-agent-${a.stallLevel}`}
                onClick={() => onSelectRole(a.role)}
              >
                <div className="pipeline-agent-head">
                  <strong>{a.role}</strong>
                  <span className={`badge ${a.status === "error" ? "error" : "busy"}`}>
                    {a.status}
                  </span>
                  {a.runningMinutes > 0 ? (
                    <span className="pipeline-agent-time">{a.runningMinutes} min</span>
                  ) : null}
                </div>
                <p className="pipeline-agent-obj">{a.objective}</p>
                {a.pingPongMinutes != null && a.pingPongMinutes >= 1 ? (
                  <p className="pipeline-agent-pingpong">
                    Ping-pong {a.pingPongLabel} · {a.pingPongMinutes} min
                  </p>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {blockedHandoffs.length > 0 && (
        <div className="pipeline-active-block">
          <span className="active-now-label">Waiting in queue ({blockedHandoffs.length})</span>
          <ul className="pipeline-alerts pipeline-blocked-list">
            {blockedHandoffs.map((b) => (
              <li key={b.id}>
                <strong>{b.label}</strong> — {b.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {bottleneck && (
        <div className="pipeline-bottleneck">
          <span className="active-now-label">Current bottleneck</span>
          <strong>{bottleneck.title}</strong>
          <p>{bottleneck.detail}</p>
        </div>
      )}

      {alerts.length > 0 && (
        <ul className="pipeline-alerts">
          {alerts.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
