import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentRole,
  ConversationRun,
  Goal,
  GoalMetricsSnapshot,
  Handoff,
  MetricsSnapshot,
  PromptPortalSnapshot,
  Suggestion,
  WsEvent,
} from "@corp-swarm/schema";
import { computeGoalTracker } from "./goal-tracker";
import { GoalTrackerPanel } from "./GoalTrackerPanel";
import { LiveTranscript } from "./LiveTranscript";
import { CeoDirectivePanel } from "./CeoDirectivePanel";
import { CeoRequestsPanel } from "./CeoRequestsPanel";
import { CeoReviewPanel } from "./CeoReviewPanel";
import { PromptPortalPanel } from "./PromptPortalPanel";
import { normalizeGoalMetrics } from "./ceo-requests-format";

type OrgRole = {
  role: AgentRole;
  title: string;
  status: "idle" | "busy" | "error" | "paused";
  cursorAgentId: string | null;
  lastRunId: string | null;
};

type Tab = "directive" | "mission" | "review" | "requests" | "prompts" | "metrics" | "oversight";

const ACTIVE_HANDOFF_STATUSES = new Set<Handoff["status"]>([
  "queued",
  "accepted",
  "in_progress",
]);

const ACTIVE_GOAL_STATUSES = new Set<Goal["status"]>(["queued", "planning", "executing"]);

const FAILED_HANDOFF_STATUSES = new Set<Handoff["status"]>(["failed", "rejected"]);

const FAILED_GOAL_STATUSES = new Set<Goal["status"]>(["failed", "cancelled"]);

const FAILED_RUN_STATUSES = new Set<ConversationRun["status"]>([
  "error",
  "startup_error",
  "cancelled",
]);

const API = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function App() {
  const [tab, setTab] = useState<Tab>("mission");
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [runs, setRuns] = useState<ConversationRun[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [goalMetrics, setGoalMetrics] = useState<GoalMetricsSnapshot | null>(null);
  const [promptPortal, setPromptPortal] = useState<PromptPortalSnapshot | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedHandoffId, setSelectedHandoffId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<AgentRole | "ceo">("ceo");
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const [goalText, setGoalText] = useState("");
  const [paused, setPaused] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const [apiKeyPresent, setApiKeyPresent] = useState(true);
  const [ceoAutoApprove, setCeoAutoApprove] = useState(true);
  const [targetRepo, setTargetRepo] = useState("");
  const [githubSource, setGithubSource] = useState<string | null>(null);
  const [briefSummary, setBriefSummary] = useState("");
  const [targetDraft, setTargetDraft] = useState("");
  const [refDraft, setRefDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retargeting, setRetargeting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [silentStallMs, setSilentStallMs] = useState(90_000);
  const [maxConcurrentAgents, setMaxConcurrentAgents] = useState(2);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [org, goalsRes, handoffsRes, runsRes, metricsRes, suggestionsRes, configRes] =
      await Promise.all([
        api<{ roles: OrgRole[]; paused: boolean; queueDepth: number }>("/api/org"),
        api<{ goals: Goal[] }>("/api/goals"),
        api<{ handoffs: Handoff[] }>("/api/handoffs"),
        api<{ runs: ConversationRun[] }>("/api/runs"),
        api<MetricsSnapshot>("/api/metrics"),
        api<{ suggestions: Suggestion[] }>("/api/suggestions"),
        api<{
          config: {
            targetRepo: string;
            ceoAutoApprove?: boolean;
            githubSource?: string | null;
            githubRef?: string | null;
            silentStallMs?: number;
            maxConcurrentAgents?: number;
          };
          brief?: { summary?: string };
          apiKeyPresent: boolean;
          ceoAutoApprove?: boolean;
        }>("/api/config"),
      ]);
    setRoles(org.roles);
    setPaused(org.paused);
    setQueueDepth(org.queueDepth);
    setGoals(goalsRes.goals);
    setHandoffs(handoffsRes.handoffs);
    setRuns(runsRes.runs);
    setMetrics(metricsRes);
    setSuggestions(suggestionsRes.suggestions);
    setTargetRepo(configRes.config.targetRepo);
    setGithubSource(configRes.config.githubSource ?? null);
    setBriefSummary(configRes.brief?.summary ?? "");
    setTargetDraft(
      configRes.config.githubSource ?? configRes.config.targetRepo ?? "",
    );
    setRefDraft(configRes.config.githubRef ?? "");
    setApiKeyPresent(configRes.apiKeyPresent);
    setCeoAutoApprove(
      configRes.ceoAutoApprove ?? configRes.config.ceoAutoApprove ?? true,
    );
    setSilentStallMs(configRes.config.silentStallMs ?? 90_000);
    setMaxConcurrentAgents(configRes.config.maxConcurrentAgents ?? 2);

    try {
      const goalMetricsRes = await api<GoalMetricsSnapshot>("/api/goals/metrics");
      setGoalMetrics(normalizeGoalMetrics(goalMetricsRes));
    } catch (goalMetricsError) {
      console.error("Failed to load CEO request metrics", goalMetricsError);
    }

    try {
      const promptPortalRes = await api<PromptPortalSnapshot>("/api/prompts");
      setPromptPortal(promptPortalRes);
    } catch (promptPortalError) {
      console.error("Failed to load prompt portal", promptPortalError);
    }
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError(String(e.message ?? e)));
  }, [refresh]);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as WsEvent;
      if (event.type === "agent_status") {
        setRoles((prev) =>
          prev.map((r) =>
            r.role === event.role
              ? { ...r, status: event.status, lastRunId: event.lastRunId ?? r.lastRunId }
              : r,
          ),
        );
      } else if (event.type === "handoff_updated") {
        setHandoffs((prev) => {
          const idx = prev.findIndex((h) => h.id === event.handoff.id);
          if (idx === -1) return [event.handoff, ...prev];
          const next = [...prev];
          next[idx] = event.handoff;
          return next;
        });
        void api<GoalMetricsSnapshot>("/api/goals/metrics")
          .then((res) => setGoalMetrics(normalizeGoalMetrics(res)))
          .catch(() => undefined);
      } else if (event.type === "goal_updated") {
        setGoals((prev) => {
          const idx = prev.findIndex((g) => g.id === event.goal.id);
          if (idx === -1) return [event.goal, ...prev];
          const next = [...prev];
          next[idx] = event.goal;
          return next;
        });
        void api<GoalMetricsSnapshot>("/api/goals/metrics")
          .then((res) => setGoalMetrics(normalizeGoalMetrics(res)))
          .catch(() => undefined);
      } else if (event.type === "run_started") {
        setRuns((prev) => [event.run, ...prev.filter((r) => r.id !== event.run.id)]);
      } else if (event.type === "run_chunk") {
        setLiveText((prev) => ({
          ...prev,
          [event.runId]: (prev[event.runId] ?? "") + event.text,
        }));
      } else if (event.type === "run_finished") {
        setRuns((prev) => {
          const idx = prev.findIndex((r) => r.id === event.run.id);
          if (idx === -1) return [event.run, ...prev];
          const next = [...prev];
          next[idx] = event.run;
          return next;
        });
        void api<GoalMetricsSnapshot>("/api/goals/metrics")
          .then((res) => setGoalMetrics(normalizeGoalMetrics(res)))
          .catch(() => undefined);
      } else if (event.type === "suggestion_created") {
        setSuggestions((prev) => [event.suggestion, ...prev]);
      } else if (event.type === "swarm_state") {
        setPaused(event.paused);
        setQueueDepth(event.queueDepth);
      } else if (event.type === "target_changed") {
        setTargetRepo(event.targetRepo);
        setGithubSource(event.githubSource);
        setBriefSummary(event.briefSummary);
        setTargetDraft(event.githubSource ?? event.targetRepo);
        setRefDraft(event.githubRef ?? "");
      } else if (event.type === "error") {
        setError(event.message);
      }
    };
    return () => ws.close();
  }, []);

  const activeGoal = useMemo(
    () => goals.find((g) => ACTIVE_GOAL_STATUSES.has(g.status)) ?? null,
    [goals],
  );

  useEffect(() => {
    if (!activeGoal) return;
    const tick = () => setNowMs(Date.now());
    tick();
    const handle = setInterval(tick, 15_000);
    return () => clearInterval(handle);
  }, [activeGoal?.id, activeGoal?.status]);

  const activeHandoffs = useMemo(
    () =>
      handoffs
        .filter((h) => ACTIVE_HANDOFF_STATUSES.has(h.status))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [handoffs],
  );

  const runningRuns = useMemo(
    () => runs.filter((r) => r.status === "running"),
    [runs],
  );

  const busyRoles = useMemo(
    () => roles.filter((r) => r.role !== "ceo" && r.status === "busy"),
    [roles],
  );

  const swarmIsActive = useMemo(
    () =>
      !paused &&
      (activeHandoffs.length > 0 ||
        runningRuns.length > 0 ||
        busyRoles.length > 0 ||
        queueDepth > 0),
    [paused, activeHandoffs.length, runningRuns.length, busyRoles.length, queueDepth],
  );

  const failedGoals = useMemo(
    () =>
      goals
        .filter((g) => FAILED_GOAL_STATUSES.has(g.status))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [goals],
  );

  const failedHandoffs = useMemo(
    () =>
      handoffs
        .filter((h) => FAILED_HANDOFF_STATUSES.has(h.status))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [handoffs],
  );

  const failedRuns = useMemo(
    () =>
      runs
        .filter(
          (r) =>
            FAILED_RUN_STATUSES.has(r.status) &&
            Boolean(r.failureMessage?.trim()),
        )
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, 8),
    [runs],
  );

  const errorRoles = useMemo(
    () => roles.filter((r) => r.role !== "ceo" && r.status === "error"),
    [roles],
  );

  const needsReviewCount =
    failedGoals.length + failedHandoffs.length + errorRoles.length;

  const goalTitleById = useMemo(
    () => new Map(goals.map((g) => [g.id, g.title])),
    [goals],
  );

  const selectAgentStream = (opts: {
    runId?: string;
    handoffId?: string;
    role?: AgentRole;
  }) => {
    if (opts.runId) {
      const run = runs.find((r) => r.id === opts.runId);
      setSelectedRunId(opts.runId);
      if (run) {
        setSelectedRole(run.role);
        if (run.handoffId) setSelectedHandoffId(run.handoffId);
      }
      return;
    }

    if (opts.handoffId) {
      const handoff = handoffs.find((h) => h.id === opts.handoffId);
      setSelectedHandoffId(opts.handoffId);
      if (handoff) {
        setSelectedRole(handoff.toRole);
        const runId = handoff.conversationRunIds?.at(-1);
        if (runId) setSelectedRunId(runId);
        else setSelectedRunId(null);
      }
      return;
    }

    if (opts.role) {
      setSelectedRole(opts.role);
      const run =
        runs.find((r) => r.role === opts.role && r.status === "running") ??
        runs.find((r) => r.role === opts.role);
      setSelectedRunId(run?.id ?? null);
      if (run?.handoffId) setSelectedHandoffId(run.handoffId);
    }
  };

  const selectFailureForReview = (handoffId: string) => {
    selectAgentStream({ handoffId });
    setTab("mission");
  };

  const inspectRunFailure = (run: ConversationRun) => {
    setSelectedRole(run.role);
    if (run.handoffId) selectAgentStream({ handoffId: run.handoffId });
    else selectAgentStream({ runId: run.id, role: run.role });
    setTab("mission");
  };

  const inspectErrorRole = (role: AgentRole) => {
    selectAgentStream({ role });
    setTab("mission");
  };

  const prefillRetryGoal = (prompt: string) => {
    setGoalText(prompt);
    setTab("directive");
    const el = document.getElementById("ceo-goal");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el instanceof HTMLTextAreaElement) el.focus();
  };

  const goalTracker = useMemo(
    () =>
      computeGoalTracker({
        goal: activeGoal,
        handoffs,
        runs,
        busyRoles: busyRoles.map((r) => r.role),
        errorRoles: errorRoles.map((r) => r.role),
        metrics,
        friction: metrics?.friction ?? [],
        nowMs,
        silentStallMs,
        maxConcurrentAgents,
      }),
    [
      activeGoal,
      handoffs,
      runs,
      busyRoles,
      errorRoles,
      metrics,
      nowMs,
      silentStallMs,
      maxConcurrentAgents,
    ],
  );

  const selectedHandoff = useMemo(
    () => handoffs.find((h) => h.id === selectedHandoffId) ?? handoffs[0] ?? null,
    [handoffs, selectedHandoffId],
  );

  const activeRun = useMemo(() => {
    if (selectedRunId) {
      const selected = runs.find((r) => r.id === selectedRunId);
      if (selected) return selected;
    }
    if (selectedHandoff?.conversationRunIds?.length) {
      const id = selectedHandoff.conversationRunIds.at(-1)!;
      return runs.find((r) => r.id === id) ?? null;
    }
    if (selectedRole !== "ceo") {
      return (
        runs.find((r) => r.role === selectedRole && r.status === "running") ??
        runs.find((r) => r.role === selectedRole) ??
        null
      );
    }
    return runs.find((r) => r.status === "running") ?? runs[0] ?? null;
  }, [selectedRunId, selectedHandoff, selectedRole, runs]);

  useEffect(() => {
    if (tab !== "mission") return;
    const selected = selectedRunId ? runs.find((r) => r.id === selectedRunId) : null;
    if (selected?.status === "running") return;

    const newestRunning = [...runningRuns].sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    )[0];
    if (!newestRunning) return;

    setSelectedRunId(newestRunning.id);
    setSelectedRole(newestRunning.role);
    if (newestRunning.handoffId) setSelectedHandoffId(newestRunning.handoffId);
  }, [runningRuns, selectedRunId, runs, tab]);

  // Poll in-flight run so transcript survives WS gaps / page refresh
  useEffect(() => {
    if (!activeRun || activeRun.status !== "running") return;
    const id = activeRun.id;
    const tick = () => {
      void api<{ run: ConversationRun }>(`/api/runs/${id}`)
        .then((res) => {
          setRuns((prev) => {
            const idx = prev.findIndex((r) => r.id === id);
            if (idx === -1) return [res.run, ...prev];
            const next = [...prev];
            next[idx] = res.run;
            return next;
          });
          if (res.run.resultText) {
            setLiveText((prev) => ({ ...prev, [id]: res.run.resultText ?? "" }));
          }
        })
        .catch(() => undefined);
    };
    tick();
    const handle = setInterval(tick, 2000);
    return () => clearInterval(handle);
  }, [activeRun?.id, activeRun?.status]);

  const submitGoal = async () => {
    if (!goalText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/goals", {
        method: "POST",
        body: JSON.stringify({ prompt: goalText.trim() }),
      });
      setGoalText("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    await api(paused ? "/api/swarm/resume" : "/api/swarm/pause", { method: "POST" });
    setPaused(!paused);
  };

  const applyTarget = async () => {
    if (!targetDraft.trim()) return;
    setRetargeting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{
        config: { targetRepo: string; githubSource?: string | null };
        brief: { summary: string };
        resolved: { cloned: boolean; pulled: boolean };
      }>("/api/config/target", {
        method: "POST",
        body: JSON.stringify({
          source: targetDraft.trim(),
          ...(refDraft.trim() ? { ref: refDraft.trim() } : {}),
        }),
      });
      setTargetRepo(res.config.targetRepo);
      setGithubSource(res.config.githubSource ?? null);
      setBriefSummary(res.brief.summary);
      const note = [
        res.resolved.cloned ? "cloned" : null,
        res.resolved.pulled ? "pulled" : null,
        "agents retargeted",
      ]
        .filter(Boolean)
        .join(" · ");
      setNotice(`Workspace updated (${note}).`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetargeting(false);
    }
  };

  const runOversight = async () => {
    setBusy(true);
    try {
      const res = await api<{ suggestions: Suggestion[] }>("/api/oversight/run", {
        method: "POST",
      });
      setSuggestions(res.suggestions);
      setTab("oversight");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="app-topbar">
        <div className="hero-brand-row">
          <h1 className="brand brand-compact">
            Corp <span>Swarm</span>
          </h1>
          <span className="status-pill status-pill-header">
            <span className={`status-dot ${paused ? "warn" : "on"}`} />
            {paused ? "Paused" : "Live"} · queue {queueDepth}
          </span>
        </div>

        <nav className="app-nav" aria-label="Main">
          {(
            [
              ["directive", "CEO directive"],
              ["mission", "Mission"],
              ["review", "CEO review"],
              ["requests", "CEO requests"],
              ["prompts", "Prompts"],
              ["metrics", "Metrics"],
              ["oversight", "Oversight"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`app-nav-pill ${tab === id ? "active" : ""}${id === "review" && needsReviewCount > 0 ? " app-nav-pill-alert" : ""}`}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
            >
              <span className="app-nav-pill-label">{label}</span>
              {id === "review" && needsReviewCount > 0 ? (
                <span className="app-nav-badge">{needsReviewCount}</span>
              ) : null}
            </button>
          ))}
        </nav>

        {!apiKeyPresent && (
          <div className="banner banner-compact">
            Set <code>CURSOR_API_KEY</code> in the repo root <code>.env</code> before agents
            can run.
          </div>
        )}
        {error && <div className="banner banner-compact">{error}</div>}
        {notice && <div className="banner banner-compact ok">{notice}</div>}
      </header>

      {tab === "directive" && (
        <CeoDirectivePanel
          goalText={goalText}
          busy={busy}
          paused={paused}
          ceoAutoApprove={ceoAutoApprove}
          onGoalTextChange={setGoalText}
          onSubmitGoal={() => void submitGoal()}
          onTogglePause={() => void togglePause()}
          onClearStuck={() =>
            void api<{ recoveredRuns: number }>("/api/swarm/recover", { method: "POST" })
              .then((r) => {
                setError(`Cleared stuck work (${r.recoveredRuns} runs). Refreshing…`);
                return refresh();
              })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }
          onRunOversight={() => void runOversight()}
        />
      )}

      {tab === "mission" && (
        <>
          <div className="mission-live-row">
          <section
            className={`panel active-now ${swarmIsActive ? "active-now-live" : "active-now-idle"}`}
          >
            <div className="active-now-header">
              <h2>Active now</h2>
              <span className={`active-now-pill ${swarmIsActive ? "live" : "idle"}`}>
                <span className={`status-dot ${swarmIsActive ? "on" : paused ? "warn" : "off"}`} />
                {paused ? "Paused" : swarmIsActive ? "Work in flight" : "Idle"}
                {queueDepth > 0 ? ` · ${queueDepth} queued` : ""}
              </span>
            </div>

            {activeGoal ? (
              <div className="active-now-goal">
                <span className="active-now-label">Goal</span>
                <strong>{activeGoal.title}</strong>
                <span className={`badge ${activeGoal.status === "executing" ? "busy" : ""}`}>
                  {activeGoal.status}
                </span>
              </div>
            ) : (
              <p className="active-now-empty">
                No goal is planning or executing.
                {goals[0] ? (
                  <>
                    {" "}
                    Latest: <strong>{goals[0].title}</strong> ({goals[0].status})
                  </>
                ) : null}
              </p>
            )}

            {busyRoles.length > 0 && (
              <div className="active-now-block">
                <span className="active-now-label">Busy agents</span>
                <div className="active-now-chips">
                  {busyRoles.map((r) => (
                    <button
                      key={r.role}
                      type="button"
                      className={`active-chip ${activeRun?.role === r.role && activeRun.status === "running" ? "active-chip-selected" : ""}`}
                      onClick={() => selectAgentStream({ role: r.role })}
                    >
                      {r.role}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeHandoffs.length > 0 ? (
              <div className="active-now-block">
                <span className="active-now-label">
                  In-flight handoffs ({activeHandoffs.length})
                </span>
                <div className="active-handoff-list">
                  {activeHandoffs.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      className={`handoff-card active-handoff-card ${activeRun?.handoffId === h.id || selectedHandoff?.id === h.id ? "active" : ""}`}
                      onClick={() => selectAgentStream({ handoffId: h.id })}
                    >
                      <div className="handoff-edge">
                        {h.fromRole} → {h.toRole} · {h.status}
                      </div>
                      <div className="handoff-obj">{h.objective}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="active-now-empty">No handoffs queued or in progress.</p>
            )}

            {runningRuns.length > 0 && (
              <div className="active-now-block">
                <span className="active-now-label">Running transcripts</span>
                <div className="active-now-chips">
                  {runningRuns.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`active-chip ${activeRun?.id === r.id ? "active-chip-selected" : ""}`}
                      onClick={() =>
                        selectAgentStream({
                          runId: r.id,
                          handoffId: r.handoffId ?? undefined,
                          role: r.role,
                        })
                      }
                    >
                      {r.role} · running
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="panel transcript-panel">
            <h2>Live stream</h2>
            <p className="panel-sub">
              {activeRun
                ? `${activeRun.role} · ${activeRun.status} — step summary, click to expand`
                : "Click an agent in Active now"}
            </p>
            <div className="transcript">
              {!activeRun && (
                <div className="transcript-empty">
                  Click a busy agent, handoff, or running chip to watch live thinking.
                </div>
              )}
              {activeRun && (
                <>
                  <LiveTranscript
                    text={
                      liveText[activeRun.id] ||
                      activeRun.resultText ||
                      activeRun.prompt.slice(0, 800)
                    }
                    isLive={activeRun.status === "running"}
                  />
                  {activeRun.failureMessage && (
                    <div className="banner">{activeRun.failureMessage}</div>
                  )}
                </>
              )}
            </div>
          </section>
          </div>

          <GoalTrackerPanel
            tracker={goalTracker}
            paused={paused}
            onSelectRole={(role) => selectAgentStream({ role: role as AgentRole })}
          />

          <div className="layout">
          <section className="panel">
            <h2>Organization</h2>
            <p className="panel-sub">Live status of the corporate agent tree</p>
            <div className="org-tree">
              {roles.map((role, i) => (
                <button
                  key={role.role}
                  className={`org-node ${role.role === "ceo" ? "ceo" : ""} ${activeRun?.role === role.role ? "active" : ""}`}
                  onClick={() =>
                    role.role === "ceo"
                      ? setSelectedRole("ceo")
                      : selectAgentStream({ role: role.role })
                  }
                >
                  <span className="org-indent" style={{ opacity: i === 0 ? 0 : 1 }} />
                  <span>
                    <div className="org-title">{role.title}</div>
                    <div className="org-meta">{role.role}</div>
                  </span>
                  <span className={`badge ${role.status}`}>{role.status}</span>
                </button>
              ))}
            </div>
            {goals[0] && (
              <p className="panel-sub" style={{ marginTop: "1rem" }}>
                {activeGoal ? (
                  <>
                    Active goal: <strong>{activeGoal.title}</strong> ({activeGoal.status})
                  </>
                ) : (
                  <>
                    Latest goal: <strong>{goals[0].title}</strong> ({goals[0].status})
                  </>
                )}
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Handoffs</h2>
            <p className="panel-sub">Full audit trail (active items also appear above)</p>
            <div className="handoff-list">
              {handoffs.length === 0 && (
                <div className="transcript-empty">No handoffs yet. Dispatch a CEO goal.</div>
              )}
              {handoffs.map((h) => (
                <button
                  key={h.id}
                  className={`handoff-card ${FAILED_HANDOFF_STATUSES.has(h.status) ? "handoff-card-failed" : ""} ${activeRun?.handoffId === h.id || selectedHandoff?.id === h.id ? "active" : ""}`}
                  onClick={() => selectAgentStream({ handoffId: h.id })}
                >
                  <div className="handoff-edge">
                    {FAILED_HANDOFF_STATUSES.has(h.status) ? (
                      <span className="badge badge-failed">{h.status}</span>
                    ) : null}{" "}
                    {h.fromRole} → {h.toRole}
                    {!FAILED_HANDOFF_STATUSES.has(h.status) ? ` · ${h.status}` : null}
                  </div>
                  <div className="handoff-obj">{h.objective}</div>
                  {FAILED_HANDOFF_STATUSES.has(h.status) && h.failureReason ? (
                    <p className="handoff-fail-snippet">{h.failureReason}</p>
                  ) : null}
                </button>
              ))}
            </div>
            {selectedHandoff && (
              <>
                <ul className="criteria">
                  {selectedHandoff.acceptanceCriteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                {selectedHandoff.failureReason && (
                  <div className="banner" style={{ marginTop: "0.75rem" }}>
                    {selectedHandoff.failureReason}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
        </>
      )}

      {tab === "review" && (
        <CeoReviewPanel
          failedGoals={failedGoals}
          failedHandoffs={failedHandoffs}
          failedRuns={failedRuns}
          errorRoles={errorRoles}
          goalTitleById={goalTitleById}
          selectedHandoffId={selectedHandoff?.id ?? null}
          onInspectHandoff={selectFailureForReview}
          onInspectRun={inspectRunFailure}
          onInspectErrorRole={inspectErrorRole}
          onRetryGoal={prefillRetryGoal}
        />
      )}

      {tab === "requests" &&
        (goalMetrics ? (
          <CeoRequestsPanel snapshot={goalMetrics} />
        ) : (
          <section className="panel ceo-requests">
            <h2>CEO requests</h2>
            <div className="transcript-empty">
              {error
                ? "Could not load CEO request metrics. Check that the server is running and refresh."
                : "Loading CEO request metrics…"}
            </div>
          </section>
        ))}

      {tab === "prompts" &&
        (promptPortal ? (
          <PromptPortalPanel snapshot={promptPortal} />
        ) : (
          <section className="panel prompt-portal">
            <h2>Agent prompt portal</h2>
            <div className="transcript-empty">
              {error
                ? "Could not load prompt portal. Restart the server and refresh."
                : "Loading agent prompts…"}
            </div>
          </section>
        ))}

      {tab === "metrics" &&
        (metrics ? (
        <section className="panel">
          <h2>Performance</h2>
          <p className="panel-sub">
            Success rates, failures, and handoff friction derived from conversation logs
          </p>
          <div className="metrics-grid">
            {metrics.byRole.map((m) => (
              <div key={m.role} className="metric-row">
                <strong>{m.role}</strong>
                <div className="bar">
                  <span style={{ width: `${Math.round(m.successRate * 100)}%` }} />
                </div>
                <span className="org-meta">
                  {(m.successRate * 100).toFixed(0)}% · {m.totalRuns} runs · {m.errors + m.startupErrors} fail
                </span>
              </div>
            ))}
          </div>
          <h2 style={{ marginTop: "1.5rem" }}>Handoff friction</h2>
          <div className="handoff-list" style={{ marginTop: "0.75rem" }}>
            {metrics.friction.length === 0 && (
              <div className="transcript-empty">No handoff pairs yet.</div>
            )}
            {metrics.friction.map((f) => (
              <div key={`${f.fromRole}-${f.toRole}`} className="handoff-card">
                <div className="handoff-edge">
                  {f.fromRole} → {f.toRole}
                </div>
                <div className="org-meta">
                  {f.total} total · {f.failed} failed · {f.rejected} rejected · {f.pingPong} ping-pong
                </div>
              </div>
            ))}
          </div>
        </section>
        ) : (
          <section className="panel">
            <h2>Performance</h2>
            <div className="transcript-empty">
              {error
                ? "Could not load metrics. Check that the server is running and refresh."
                : "Loading performance metrics…"}
            </div>
          </section>
        ))}

      {tab === "oversight" && (
        <section className="panel">
          <h2>Oversight inbox</h2>
          <p className="panel-sub">
            {ceoAutoApprove
              ? "CEO auto-approve is on — new suggestions are applied as role overrides immediately."
              : "Suggestions mined from failures and friction. Accept to apply as a role override."}
          </p>
          {suggestions.length === 0 && (
            <div className="transcript-empty">
              No suggestions yet. Click “Run oversight” after some agent activity.
            </div>
          )}
          {suggestions.map((s) => (
            <div key={s.id} className="suggestion">
              <h3>
                {s.targetRole} · {s.status}
              </h3>
              <p>{s.finding}</p>
              <p>
                <em>{s.proposedPromptChange}</em>
              </p>
              {s.status === "pending" && (
                <div className="ceo-actions">
                  <button
                    className="btn"
                    onClick={() =>
                      void api(`/api/suggestions/${s.id}/accept`, { method: "POST" }).then(
                        refresh,
                      )
                    }
                  >
                    Accept
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() =>
                      void api(`/api/suggestions/${s.id}/reject`, { method: "POST" }).then(
                        refresh,
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      <footer className="workspace-footer">
        <div className="workspace-bar workspace-bar-footer">
          <label htmlFor="target-source">Agent workspace</label>
          <div className="workspace-row">
            <input
              id="target-source"
              value={targetDraft}
              onChange={(e) => setTargetDraft(e.target.value)}
              placeholder="E:\path\to\repo  or  https://github.com/org/repo  or  org/repo"
              spellCheck={false}
            />
            <input
              className="ref-input"
              value={refDraft}
              onChange={(e) => setRefDraft(e.target.value)}
              placeholder="branch (optional)"
              spellCheck={false}
            />
            <button
              className="btn btn-ghost"
              disabled={retargeting || !targetDraft.trim()}
              onClick={() => void applyTarget()}
            >
              {retargeting ? "Switching…" : "Use workspace"}
            </button>
          </div>
          <p className="workspace-meta">
            Active: <code>{targetRepo || "…"}</code>
            {githubSource ? (
              <>
                {" "}
                · GitHub: <code>{githubSource}</code>
              </>
            ) : null}
          </p>
          {briefSummary ? (
            <pre className="brief-preview">{briefSummary}</pre>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
