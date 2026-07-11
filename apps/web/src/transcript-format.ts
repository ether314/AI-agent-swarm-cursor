export type TranscriptLineKind = "thinking" | "tool" | "orchestrator" | "text";

export type TranscriptLine = {
  kind: TranscriptLineKind;
  emoji: string;
  label: string | null;
  body: string;
};

export type StreamStep = {
  id: string;
  kind: TranscriptLineKind;
  title: string;
  summary: string;
  detail: string;
  emoji: string;
  expandable: boolean;
};

const TOOL_EMOJI: Record<string, string> = {
  Shell: "💻",
  Read: "📖",
  Write: "✏️",
  StrReplace: "✏️",
  Grep: "🔍",
  Glob: "📂",
  Delete: "🗑️",
  Task: "🤖",
  WebSearch: "🌐",
  WebFetch: "🌐",
  GenerateImage: "🎨",
  EditNotebook: "📓",
  CallMcpTool: "🔌",
  GetMcpTools: "🔌",
  FetchMcpResource: "🔌",
  SwitchMode: "🔀",
  AskQuestion: "❓",
  TodoWrite: "📋",
  Await: "⏳",
};

const KIND_EMOJI: Record<TranscriptLineKind, string> = {
  thinking: "🧠",
  tool: "🛠️",
  orchestrator: "⚙️",
  text: "💬",
};

function toolEmoji(name: string): string {
  const base = name.replace(/…$/, "").trim();
  return TOOL_EMOJI[base] ?? KIND_EMOJI.tool;
}

function summarize(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return "";
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function classifyLine(line: string): TranscriptLine {
  const thinking = line.match(/^\[thinking\]\s*(.*)$/);
  if (thinking) {
    return {
      kind: "thinking",
      emoji: KIND_EMOJI.thinking,
      label: "thinking",
      body: thinking[1] ?? "",
    };
  }

  const tool = line.match(/^\[tool\]\s*(.+)$/);
  if (tool) {
    const name = tool[1] ?? "tool";
    return {
      kind: "tool",
      emoji: toolEmoji(name),
      label: name.replace(/…$/, "").trim(),
      body: "",
    };
  }

  const orch = line.match(/^\[orchestrator\]\s*(.*)$/);
  if (orch) {
    return {
      kind: "orchestrator",
      emoji: KIND_EMOJI.orchestrator,
      label: "orchestrator",
      body: orch[1] ?? "",
    };
  }

  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "text", emoji: "", label: null, body: "" };
  }

  return {
    kind: "text",
    emoji: KIND_EMOJI.text,
    label: null,
    body: trimmed,
  };
}

/** Parse streamed agent output into display lines (empty lines dropped). */
export function parseTranscriptLines(raw: string): TranscriptLine[] {
  return raw
    .split("\n")
    .map(classifyLine)
    .filter((line) => line.body || line.label);
}

function singleLineStep(line: TranscriptLine, idx: number): StreamStep {
  if (line.kind === "tool") {
    const name = line.label ?? "tool";
    return {
      id: `step-${idx}`,
      kind: "tool",
      title: name,
      summary: `Used ${name}`,
      detail: "",
      emoji: line.emoji,
      expandable: false,
    };
  }

  const detail = line.body;
  return {
    id: `step-${idx}`,
    kind: "orchestrator",
    title: "Orchestrator",
    summary: summarize(detail) || "System event",
    detail,
    emoji: line.emoji,
    expandable: detail.length > 80,
  };
}

function joinDetail(parts: string[]): string {
  return parts
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

function groupStep(kind: TranscriptLineKind, lines: TranscriptLine[], idx: number): StreamStep {
  const detail = joinDetail(lines.map((l) => l.body));

  if (kind === "thinking") {
    return {
      id: `step-${idx}`,
      kind: "thinking",
      title: "Thought",
      summary: summarize(detail) || "Reasoning…",
      detail,
      emoji: KIND_EMOJI.thinking,
      expandable: detail.length > 0,
    };
  }

  return {
    id: `step-${idx}`,
    kind: "text",
    title: "Response",
    summary: summarize(detail) || "Assistant output",
    detail,
    emoji: KIND_EMOJI.text,
    expandable: detail.length > 80,
  };
}

/** Collapse raw lines into Cursor-style logical steps. */
export function buildStreamSteps(lines: TranscriptLine[]): StreamStep[] {
  const steps: StreamStep[] = [];
  let buffer: TranscriptLine[] = [];
  let bufferKind: TranscriptLineKind | null = null;

  const flush = () => {
    if (!buffer.length || !bufferKind) return;
    steps.push(groupStep(bufferKind, buffer, steps.length));
    buffer = [];
    bufferKind = null;
  };

  for (const line of lines) {
    if (line.kind === "tool" || line.kind === "orchestrator") {
      flush();
      steps.push(singleLineStep(line, steps.length));
      continue;
    }

    if (line.kind !== bufferKind) {
      flush();
      bufferKind = line.kind;
    }
    buffer.push(line);
  }
  flush();

  return steps;
}

/** Keep the tail of steps for the live summary view. */
export function tailStreamSteps(steps: StreamStep[], maxSteps = 12): StreamStep[] {
  if (steps.length <= maxSteps) return steps;
  return steps.slice(-maxSteps);
}

/** @deprecated use tailStreamSteps(buildStreamSteps(...)) */
export function tailTranscriptLines(lines: TranscriptLine[], maxLines = 14): TranscriptLine[] {
  if (lines.length <= maxLines) return lines;
  return lines.slice(-maxLines);
}
