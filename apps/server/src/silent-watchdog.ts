/** Prefix for failures aborted by the silent-run watchdog (enables auto-retry). */
export const SILENT_WATCHDOG_PREFIX = "[silent-watchdog]";

/** True when streamed output contains no assistant/tool/thinking content. */
export function isSilentAgentOutput(streamed: string): boolean {
  const body = streamed.replace(/\[orchestrator\][^\n]*\n?/g, "").trim();
  return body.length === 0;
}

export function isSilentStallMessage(message: string | null | undefined): boolean {
  return Boolean(message?.startsWith(SILENT_WATCHDOG_PREFIX));
}

export function formatSilentStallMessage(detail: string): string {
  return `${SILENT_WATCHDOG_PREFIX} ${detail}`;
}
