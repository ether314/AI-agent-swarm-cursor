import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentRole,
  ConversationRun,
  Goal,
  Handoff,
  MetricsSnapshot,
  Suggestion,
  WsEvent,
} from "@corp-swarm/schema";

type OrgRole = {
  role: AgentRole;
  title: string;
  status: "idle" | "busy" | "error" | "paused";
  cursorAgentId: string | null;
  lastRunId: string | null;
};

type Tab = "mission" | "metrics" | "oversight";

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
      } else if (event.type === "goal_updated") {
        setGoals((prev) => {
          const idx = prev.findIndex((g) => g.id === event.goal.id);
          if (idx === -1) return [event.goal, ...prev];
          const next = [...prev];
          next[idx] = event.goal;
          return next;
        });
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

  const selectedHandoff = useMemo(
    () => handoffs.find((h) => h.id === selectedHandoffId) ?? handoffs[0] ?? null,
    [handoffs, selectedHandoffId],
  );

  const activeRun = useMemo(() => {
    if (selectedHandoff?.conversationRunIds?.length) {
      const id = selectedHandoff.conversationRunIds.at(-1)!;
      return runs.find((r) => r.id === id) ?? null;
    }
    if (selectedRole !== "ceo") {
      return runs.find((r) => r.role === selectedRole) ?? null;
    }
    return runs[0] ?? null;
  }, [selectedHandoff, selectedRole, runs]);

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
      <header className="hero">
        <h1 className="brand">
          Corp <span>Swarm</span>
        </h1>
        <p className="hero-sub">
          Local mission control for a corporate Cursor agent hierarchy. You are the CEO —
          issue goals, watch handoffs, and point the swarm at any local path or GitHub repo.
        </p>

        <div className="workspace-bar">
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
              className="btn"
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

        {!apiKeyPresent && (
          <div className="banner">
            Set <code>CURSOR_API_KEY</code> in the repo root <code>.env</code> before agents
            can run.
          </div>
        )}
        {error && <div className="banner">{error}</div>}
        {notice && <div className="banner ok">{notice}</div>}

        <div className="ceo-console">
          <label htmlFor="ceo-goal">CEO directive</label>
          <textarea
            id="ceo-goal"
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            placeholder="e.g. Add health-check endpoint and a smoke test for it"
          />
          <div className="ceo-actions">
            <button className="btn" disabled={busy || !goalText.trim()} onClick={() => void submitGoal()}>
              Dispatch to PM
            </button>
            <button className="btn btn-ghost" onClick={() => void togglePause()}>
              {paused ? "Resume swarm" : "Pause swarm"}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() =>
                void api<{ recoveredRuns: number }>("/api/swarm/recover", {
                  method: "POST",
                })
                  .then((r) => {
                    setError(
                      `Cleared stuck work (${r.recoveredRuns} runs). Refreshing…`,
                    );
                    return refresh();
                  })
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              }
            >
              Clear stuck
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void runOversight()}>
              Run oversight
            </button>
            <span className="status-pill">
              <span className={`status-dot ${paused ? "warn" : "on"}`} />
              {paused ? "Paused" : "Live"} · queue {queueDepth}
              {ceoAutoApprove ? " · auto-approve" : ""}
            </span>
          </div>
        </div>
      </header>

      <div className="tabs">
        {(
          [
            ["mission", "Mission"],
            ["metrics", "Metrics"],
            ["oversight", "Oversight"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`tab ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "mission" && (
        <div className="layout">
          <section className="panel">
            <h2>Organization</h2>
            <p className="panel-sub">Live status of the corporate agent tree</p>
            <div className="org-tree">
              {roles.map((role, i) => (
                <button
                  key={role.role}
                  className={`org-node ${role.role === "ceo" ? "ceo" : ""} ${selectedRole === role.role ? "active" : ""}`}
                  onClick={() => setSelectedRole(role.role)}
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
                Latest goal: <strong>{goals[0].title}</strong> ({goals[0].status})
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Handoffs</h2>
            <p className="panel-sub">Audit trail of work moving between roles</p>
            <div className="handoff-list">
              {handoffs.length === 0 && (
                <div className="transcript-empty">No handoffs yet. Dispatch a CEO goal.</div>
              )}
              {handoffs.map((h) => (
                <button
                  key={h.id}
                  className={`handoff-card ${selectedHandoff?.id === h.id ? "active" : ""}`}
                  onClick={() => setSelectedHandoffId(h.id)}
                >
                  <div className="handoff-edge">
                    {h.fromRole} → {h.toRole} · {h.status}
                  </div>
                  <div className="handoff-obj">{h.objective}</div>
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

          <section className="panel">
            <h2>Transcript</h2>
            <p className="panel-sub">
              {activeRun
                ? `${activeRun.role} · ${activeRun.status}`
                : "Select a handoff or agent"}
            </p>
            <div className="transcript">
              {!activeRun && (
                <div className="transcript-empty">Conversation logs appear as agents run.</div>
              )}
              {activeRun && (
                <>
                  <div className="live-chunk">
                    {liveText[activeRun.id] ||
                      activeRun.resultText ||
                      activeRun.prompt.slice(0, 1200)}
                  </div>
                  {activeRun.failureMessage && (
                    <div className="banner">{activeRun.failureMessage}</div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === "metrics" && metrics && (
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
      )}

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
    </div>
  );
}
