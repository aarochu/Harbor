/**
 * Reading a Harbor run.
 *
 * Everything here observes. There is one call that starts a run and no call
 * that steers one — the UI has no pause, no retry, no approve. That boundary is
 * the agent's, and duplicating a control here would quietly move it.
 *
 * The derivations are pure functions over the event log rather than separate
 * state the UI keeps in step by hand. A reconnecting client replays the events
 * it missed and arrives at the same screen, because the screen is a function of
 * the log.
 */

export type EventType =
  | "run_started"
  | "plan_created"
  | "step_started"
  | "step_succeeded"
  | "step_failed"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "incident_opened"
  | "fix_applied"
  | "escalated"
  | "run_succeeded"
  | "run_failed"
  | "budget_warning";

export interface HarborEvent {
  seq: number;
  at: string;
  runId: string;
  type: EventType;
  message: string;
  detail?: Record<string, unknown>;
  durationMs?: number;
}

export type RunStatus = "running" | "succeeded" | "failed" | "escalated";

export interface RunSummary {
  id: string;
  repoUrl: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  serviceUrl?: string;
  issuesResolved: number;
  escalation?: string;
  lastSeq: number;
}

export const API_BASE = process.env.NEXT_PUBLIC_HARBOR_API ?? "http://127.0.0.1:4000";

export type StepStatus = "running" | "ok" | "failed";

export interface Step {
  label: string;
  status: StepStatus;
  durationMs?: number;
}

/**
 * Fold the event log into the current step list.
 *
 * A step that started and never finished stays `running` rather than being
 * dropped, which is what makes an interrupted run legible: the last line tells
 * you where it stopped instead of the list simply ending.
 */
export function deriveSteps(events: readonly HarborEvent[]): Step[] {
  const order: string[] = [];
  const byLabel = new Map<string, Step>();

  for (const event of events) {
    if (
      event.type !== "step_started" &&
      event.type !== "step_succeeded" &&
      event.type !== "step_failed"
    ) {
      continue;
    }

    const label = event.message;
    if (!byLabel.has(label)) {
      order.push(label);
      byLabel.set(label, { label, status: "running" });
    }

    const step = byLabel.get(label);
    if (step === undefined) continue;

    if (event.type === "step_succeeded") {
      step.status = "ok";
      if (event.durationMs !== undefined) step.durationMs = event.durationMs;
    } else if (event.type === "step_failed") {
      step.status = "failed";
      if (event.durationMs !== undefined) step.durationMs = event.durationMs;
    }
  }

  return order.flatMap((label) => {
    const step = byLabel.get(label);
    return step === undefined ? [] : [step];
  });
}

export interface Incident {
  seq: number;
  symptom: string;
  failureClass?: string;
  fix?: string;
  diff?: string;
}

/** Incidents, each paired with the fix that followed it. */
export function deriveIncidents(events: readonly HarborEvent[]): Incident[] {
  const incidents: Incident[] = [];

  for (const event of events) {
    if (event.type === "incident_opened") {
      const failureClass = event.detail?.["failureClass"];
      incidents.push({
        seq: event.seq,
        symptom: event.message,
        ...(typeof failureClass === "string" ? { failureClass } : {}),
      });
      continue;
    }

    if (event.type === "fix_applied") {
      const open = incidents.at(-1);
      if (open === undefined) continue;
      open.fix = event.message;
      const diff = event.detail?.["diff"];
      if (typeof diff === "string" && diff !== "") open.diff = diff;
    }
  }

  return incidents;
}

/** Human-readable duration. Sub-second values round up rather than to "0s". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(seconds % 60)}s`;
}

export function formatClock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export async function startRun(repoUrl: string): Promise<{ id: string }> {
  const response = await fetch(`${API_BASE}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Harbor refused the request (${String(response.status)})`);
  }
  return (await response.json()) as { id: string };
}

/**
 * Reads degrade rather than throw.
 *
 * A refused connection is an ordinary state — the operator started the web app
 * before the agent — and letting it reject leaves an unhandled promise in the
 * console while the page renders as though nothing is wrong. `getHealth`
 * reports the unreachable case; these just return empty.
 */
export async function listRuns(): Promise<RunSummary[]> {
  try {
    const response = await fetch(`${API_BASE}/api/runs`);
    if (!response.ok) return [];
    const body = (await response.json()) as { runs?: RunSummary[] };
    return body.runs ?? [];
  } catch {
    return [];
  }
}

export async function getRun(id: string): Promise<RunSummary | undefined> {
  try {
    const response = await fetch(`${API_BASE}/api/runs/${id}`);
    if (!response.ok) return undefined;
    return (await response.json()) as RunSummary;
  } catch {
    return undefined;
  }
}

export interface HarborHealth {
  ready: boolean;
  /** Which credentials are absent, when they are. */
  missing?: string;
  persistence: "memory" | "postgres";
  /** True when the agent server could not be reached at all. */
  unreachable?: boolean;
}

/**
 * Ask whether Harbor can actually deploy anything.
 *
 * Checked before the operator clicks rather than after, so a missing key reads
 * as a setup step instead of a failed run.
 */
export async function getHealth(): Promise<HarborHealth> {
  try {
    const response = await fetch(`${API_BASE}/api/health`);
    if (!response.ok) {
      return { ready: false, persistence: "memory", unreachable: true };
    }
    return (await response.json()) as HarborHealth;
  } catch {
    // Nothing is listening. Silence here reads to the operator as "idle", which
    // is the one thing it is not.
    return { ready: false, persistence: "memory", unreachable: true };
  }
}

export function eventStreamUrl(runId: string, afterSeq: number): string {
  return `${API_BASE}/api/runs/${runId}/events?after=${String(afterSeq)}`;
}
