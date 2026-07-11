type Props = {
  goalText: string;
  busy: boolean;
  paused: boolean;
  ceoAutoApprove: boolean;
  onGoalTextChange: (value: string) => void;
  onSubmitGoal: () => void;
  onTogglePause: () => void;
  onClearStuck: () => void;
  onRunOversight: () => void;
};

export function CeoDirectivePanel({
  goalText,
  busy,
  paused,
  ceoAutoApprove,
  onGoalTextChange,
  onSubmitGoal,
  onTogglePause,
  onClearStuck,
  onRunOversight,
}: Props) {
  return (
    <section className="panel ceo-directive-page">
      <header className="ceo-directive-header">
        <h2>CEO directive</h2>
        <p className="panel-sub">
          Describe the outcome you want and dispatch it to the PM. The swarm plans phased handoffs
          and routes work to specialist agents.
        </p>
      </header>

      <div className="ceo-console ceo-console-primary ceo-directive-console">
        <label htmlFor="ceo-goal">Your prompt</label>
        <textarea
          id="ceo-goal"
          className="ceo-goal-input"
          value={goalText}
          onChange={(e) => onGoalTextChange(e.target.value)}
          placeholder="Describe the outcome you want — e.g. deploy the latest blog post with Firebase redirects and a smoke test"
          rows={8}
        />
        <div className="ceo-actions">
          <button
            className="btn btn-dispatch"
            disabled={busy || !goalText.trim()}
            onClick={onSubmitGoal}
          >
            {busy ? "Dispatching…" : "Dispatch to PM"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onTogglePause}>
            {paused ? "Resume swarm" : "Pause swarm"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onClearStuck}>
            Clear stuck
          </button>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={onRunOversight}>
            Run oversight
          </button>
          {ceoAutoApprove ? <span className="ceo-console-hint">Auto-approve on</span> : null}
        </div>
      </div>
    </section>
  );
}
