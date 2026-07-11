import { useEffect, useMemo, useState } from "react";
import {
  buildStreamSteps,
  parseTranscriptLines,
  tailStreamSteps,
  type StreamStep,
} from "./transcript-format";

type Props = {
  text: string;
  isLive: boolean;
  maxSteps?: number;
};

function StepRow({
  step,
  expanded,
  isActive,
  isLive,
  onToggle,
}: {
  step: StreamStep;
  expanded: boolean;
  isActive: boolean;
  isLive: boolean;
  onToggle: () => void;
}) {
  const HeaderTag = step.expandable ? "button" : "div";

  return (
    <li
      className={`stream-step stream-step-${step.kind} ${isActive ? "stream-step-active" : ""} ${expanded ? "stream-step-expanded" : ""}`}
    >
      <HeaderTag
        type={step.expandable ? "button" : undefined}
        className="stream-step-header"
        onClick={step.expandable ? onToggle : undefined}
        aria-expanded={step.expandable ? expanded : undefined}
      >
        <span className="stream-step-rail" aria-hidden>
          <span className="stream-step-icon">{step.emoji}</span>
        </span>
        <span className="stream-step-main">
          <span className="stream-step-title-row">
            <span className="stream-step-title">{step.title}</span>
            {isActive && isLive ? (
              <span className="stream-step-live-tag">now</span>
            ) : null}
          </span>
          {!expanded ? (
            <span className="stream-step-summary">{step.summary}</span>
          ) : null}
        </span>
        {step.expandable ? (
          <span className="stream-step-chevron" aria-hidden>
            {expanded ? "▾" : "▸"}
          </span>
        ) : null}
      </HeaderTag>
      {expanded && step.detail ? (
        <div className="stream-step-detail">
          <p className="stream-step-detail-text">{step.detail}</p>
        </div>
      ) : null}
    </li>
  );
}

export function LiveTranscript({ text, isLive, maxSteps = 12 }: Props) {
  const steps = useMemo(
    () => tailStreamSteps(buildStreamSteps(parseTranscriptLines(text)), maxSteps),
    [text, maxSteps],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const lastStepId = steps.at(-1)?.id;

  useEffect(() => {
    if (!lastStepId || !isLive) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(lastStepId);
      return next;
    });
  }, [lastStepId, isLive]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!text.trim()) {
    return <div className="transcript-empty">Waiting for agent output…</div>;
  }

  return (
    <div className={`stream-panel ${isLive ? "stream-panel-live" : ""}`}>
      <div className="stream-panel-toolbar">
        <span className={`stream-panel-status ${isLive ? "live" : ""}`}>
          {isLive ? (
            <>
              <span className="status-dot on" />
              Live
            </>
          ) : (
            "Run log"
          )}
        </span>
        <span className="stream-panel-meta">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      </div>

      <ol className="stream-steps" aria-live="polite">
        {steps.map((step, i) => (
          <StepRow
            key={step.id}
            step={step}
            isActive={i === steps.length - 1}
            isLive={isLive}
            expanded={expanded.has(step.id)}
            onToggle={() => toggle(step.id)}
          />
        ))}
      </ol>
    </div>
  );
}
