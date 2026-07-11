import { useState } from "react";
import type { GoalAgentStep, GoalMetrics, GoalMetricsSnapshot } from "@corp-swarm/schema";
import {
  formatCost,
  formatDuration,
  formatModel,
  formatTokens,
  formatWhen,
  normalizeGoal,
  outcomeLabel,
  stepStatusLabel,
} from "./ceo-requests-format";

type Props = {
  snapshot: GoalMetricsSnapshot;
};

function OutcomeBadge({ outcome }: { outcome: GoalMetrics["outcome"] }) {
  const cls =
    outcome === "success"
      ? "ceo-req-outcome-success"
      : outcome === "failed"
        ? "ceo-req-outcome-failed"
        : outcome === "cancelled"
          ? "ceo-req-outcome-cancelled"
          : "ceo-req-outcome-active";
  return <span className={`ceo-req-outcome ${cls}`}>{outcomeLabel(outcome)}</span>;
}

function StepStatusBadge({ step }: { step: GoalAgentStep }) {
  const failed =
    step.status === "failed" ||
    step.status === "rejected" ||
    step.status === "error" ||
    step.status === "cancelled";
  const active =
    step.status === "running" || step.status === "queued" || step.status === "in_progress";
  const cls = failed
    ? "ceo-req-step-status-failed"
    : active
      ? "ceo-req-step-status-active"
      : "ceo-req-step-status-done";
  return <span className={`ceo-req-step-status ${cls}`}>{stepStatusLabel(step.status)}</span>;
}

function MetricCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="ceo-req-metric-cell">
      <span className="ceo-req-metric-label">{label}</span>
      <span className="ceo-req-metric-value">{value}</span>
      {hint ? <span className="ceo-req-metric-hint">{hint}</span> : null}
    </div>
  );
}

function GoalStepsDetail({ goal: rawGoal }: { goal: GoalMetrics }) {
  const goal = normalizeGoal(rawGoal);
  const steps = goal.steps;
  const byRole = goal.byRole;

  if (steps.length === 0) {
    return (
      <div className="ceo-req-steps-empty">
        {goal.totalRuns > 0
          ? "Agent runs exist for this directive but step details are missing from the metrics API. Restart the Corp Swarm server and refresh this page."
          : "No agent steps recorded yet for this directive."}
      </div>
    );
  }

  return (
    <div className="ceo-req-steps-panel">
      {byRole.length > 0 ? (
        <section className="ceo-req-detail-section">
          <h4 className="ceo-req-detail-heading">Per-agent summary</h4>
          <div className="ceo-req-by-role-grid">
            {byRole.map((roleMetrics) => (
              <article key={roleMetrics.role} className="ceo-req-role-card">
                <header className="ceo-req-role-card-head">
                  <span className="ceo-req-role-name">{roleMetrics.role}</span>
                  <span className="ceo-req-role-model">{formatModel(roleMetrics.primaryModel)}</span>
                </header>
                <dl className="ceo-req-role-stats">
                  <div>
                    <dt>Time</dt>
                    <dd>{formatDuration(roleMetrics.durationMs)}</dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>{formatTokens(roleMetrics.totalTokens)}</dd>
                  </div>
                  <div>
                    <dt>Est. cost</dt>
                    <dd>{formatCost(roleMetrics.estimatedCostUsd)}</dd>
                  </div>
                  <div>
                    <dt>Runs</dt>
                    <dd>{roleMetrics.runs}</dd>
                  </div>
                  {roleMetrics.handoffsReceived > 0 ? (
                    <div>
                      <dt>Handoffs</dt>
                      <dd>{roleMetrics.handoffsReceived}</dd>
                    </div>
                  ) : null}
                  {roleMetrics.failedOrRejectedHandoffs > 0 ? (
                    <div className="ceo-req-role-fail-stat">
                      <dt>Failed</dt>
                      <dd>{roleMetrics.failedOrRejectedHandoffs}</dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ceo-req-detail-section">
        <h4 className="ceo-req-detail-heading">Pipeline steps ({steps.length})</h4>
        <ol className="ceo-req-step-timeline">
          {steps.map((step) => {
            const nested = step.kind === "run" && step.handoffId;
            return (
              <li
                key={step.id}
                className={`ceo-req-step-card${nested ? " ceo-req-step-card-nested" : ""}`}
              >
                <div className="ceo-req-step-card-top">
                  <div className="ceo-req-step-card-title">
                    {nested ? <span className="ceo-req-step-indent">Run</span> : null}
                    <span>{step.label}</span>
                  </div>
                  <StepStatusBadge step={step} />
                </div>

                <div className="ceo-req-step-card-metrics">
                  <MetricCell label="Duration" value={formatDuration(step.durationMs)} />
                  <MetricCell
                    label="Tokens"
                    value={formatTokens(step.totalTokens)}
                    hint={
                      step.inputTokens != null || step.outputTokens != null
                        ? `${formatTokens(step.inputTokens)} in · ${formatTokens(step.outputTokens)} out`
                        : undefined
                    }
                  />
                  <MetricCell label="Model" value={formatModel(step.model)} />
                  <MetricCell label="Est. cost" value={formatCost(step.estimatedCostUsd)} />
                </div>

                {step.failureMessage ? (
                  <p className="ceo-req-step-error" title={step.failureMessage}>
                    {step.failureMessage}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function GoalRequestCard({
  goal: rawGoal,
  expanded,
  onToggle,
}: {
  goal: GoalMetrics;
  expanded: boolean;
  onToggle: () => void;
}) {
  const g = normalizeGoal(rawGoal);
  const tokenHint =
    g.inputTokens != null || g.outputTokens != null
      ? `${formatTokens(g.inputTokens)} in · ${formatTokens(g.outputTokens)} out`
      : g.totalRuns > 0
        ? "Not reported"
        : undefined;
  const agentHint = [
    `${g.totalRuns} run${g.totalRuns === 1 ? "" : "s"}`,
    g.rolesInvolved.length > 0 ? g.rolesInvolved.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className={`ceo-req-card ceo-req-card-${g.outcome}${expanded ? " ceo-req-card-expanded" : ""}`}>
      <button
        type="button"
        className="ceo-req-card-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="ceo-req-card-chevron" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="ceo-req-card-main">
          <span className="ceo-req-card-topline">
            <span className="ceo-req-title">{g.title}</span>
            <OutcomeBadge outcome={g.outcome} />
          </span>
          <span className="ceo-req-summary">{g.outcomeSummary}</span>
          {g.steps.length > 0 ? (
            <span className="ceo-req-card-meta">
              {g.steps.length} pipeline step{g.steps.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
        <span className="ceo-req-card-when">{formatWhen(g.createdAt)}</span>
      </button>

      <div className="ceo-req-card-metrics">
        <MetricCell
          label="Wall time"
          value={formatDuration(g.durationMs)}
          hint={
            g.agentTimeMs != null && g.agentTimeMs > 0
              ? `${formatDuration(g.agentTimeMs)} agent time`
              : undefined
          }
        />
        <MetricCell label="Tokens" value={formatTokens(g.totalTokens)} hint={tokenHint} />
        <MetricCell label="Est. cost" value={formatCost(g.estimatedCostUsd)} />
        <MetricCell
          label="Digest"
          value={
            g.contextDigestChars != null && g.contextDigestChars > 0
              ? `${g.contextDigestChars} chars`
              : "—"
          }
          hint="Compressed goal context"
        />
        <MetricCell label="Model" value={formatModel(g.primaryModel, g.modelsUsed)} />
        <MetricCell label="Agents" value={String(g.agentsSpunUp)} hint={agentHint} />
        <MetricCell
          label="Handoffs"
          value={
            g.failedHandoffs + g.rejectedHandoffs > 0
              ? `${g.failedHandoffs + g.rejectedHandoffs} failed`
              : "All clear"
          }
          hint={`${g.totalHandoffs} total`}
        />
      </div>

      {expanded ? (
        <div className="ceo-req-card-detail">
          <GoalStepsDetail goal={g} />
        </div>
      ) : null}
    </article>
  );
}

export function CeoRequestsPanel({ snapshot }: Props) {
  const { goals, totals } = snapshot;
  const [expandedGoalIds, setExpandedGoalIds] = useState<Set<string>>(() => new Set());
  const successRate =
    totals.requests > 0 ? Math.round((totals.successCount / totals.requests) * 100) : null;

  const toggleExpanded = (goalId: string) => {
    setExpandedGoalIds((prev) => {
      const next = new Set(prev);
      if (next.has(goalId)) next.delete(goalId);
      else next.add(goalId);
      return next;
    });
  };

  return (
    <section className="panel ceo-requests">
      <header className="ceo-requests-header">
        <h2>CEO requests</h2>
        <p className="panel-sub ceo-requests-intro">
          Per-directive metrics for wall time, tokens, model, cost, and agents. Click a request to
          expand pipeline steps. Costs are indicative — not official billing.
        </p>
      </header>

      <div className="ceo-requests-stats">
        <div className="ceo-req-stat">
          <span className="ceo-req-stat-value">{totals.requests}</span>
          <span className="ceo-req-stat-label">Requests</span>
        </div>
        <div className="ceo-req-stat">
          <span className="ceo-req-stat-value">
            {successRate != null ? `${successRate}%` : "—"}
          </span>
          <span className="ceo-req-stat-label">Success rate</span>
        </div>
        <div className="ceo-req-stat">
          <span className="ceo-req-stat-value">{formatTokens(totals.totalTokens)}</span>
          <span className="ceo-req-stat-label">Total tokens</span>
        </div>
        <div className="ceo-req-stat">
          <span className="ceo-req-stat-value">{formatCost(totals.estimatedTotalCostUsd)}</span>
          <span className="ceo-req-stat-label">Est. total cost</span>
        </div>
        <div className="ceo-req-stat ceo-req-stat-wide">
          <span className="ceo-req-stat-value">{formatModel(totals.primaryModel)}</span>
          <span className="ceo-req-stat-label">Primary model</span>
        </div>
      </div>

      <div className="ceo-requests-secondary-stats">
        <span>Avg wall time {formatDuration(totals.avgDurationMs)}</span>
        <span>{totals.totalAgentRuns} agent runs</span>
        <span>{totals.inProgressCount} in flight</span>
      </div>

      {goals.length === 0 ? (
        <div className="transcript-empty">No CEO directives yet. Dispatch a goal to start tracking.</div>
      ) : (
        <div className="ceo-req-card-list">
          {goals.map((goal) => (
            <GoalRequestCard
              key={goal.goalId}
              goal={goal}
              expanded={expandedGoalIds.has(goal.goalId)}
              onToggle={() => toggleExpanded(goal.goalId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
