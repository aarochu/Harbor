"use client";

/**
 * Harbor mission control.
 *
 * An operations console, not a chat. The operator supplies a repository URL and
 * then reads: what Harbor planned, which step it is on, what broke, what it
 * changed, and whether the service is answering. There is no control here that
 * steers the agent mid-run, because the agent owns that decision.
 *
 * Everything on screen is derived from the event log, so a dropped connection
 * reconnects from the last sequence number it saw and rebuilds the same view
 * rather than starting over or silently missing the middle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deriveIncidents,
  deriveSteps,
  eventStreamUrl,
  formatClock,
  formatDuration,
  getHealth,
  getRun,
  listRuns,
  startRun,
  type HarborEvent,
  type HarborHealth,
  type Incident,
  type RunSummary,
  type Step,
  type StepStatus,
} from "@/lib/harbor";

const DEMO_REPO = "https://github.com/aarochu/harbor-demo-missing-dep";

type Connection = "idle" | "live" | "reconnecting";

export default function MissionControl() {
  const [repoUrl, setRepoUrl] = useState(DEMO_REPO);
  const [runId, setRunId] = useState<string | undefined>();
  const [events, setEvents] = useState<HarborEvent[]>([]);
  const [summary, setSummary] = useState<RunSummary | undefined>();
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [connection, setConnection] = useState<Connection>("idle");
  const [error, setError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const [health, setHealth] = useState<HarborHealth | undefined>();

  const streamRef = useRef<HTMLDivElement | null>(null);
  const lastSeqRef = useRef(0);

  const refreshHistory = useCallback(() => {
    void listRuns().then(setHistory);
  }, []);

  useEffect(() => {
    refreshHistory();
    void getHealth().then(setHealth);
  }, [refreshHistory]);

  /** Open a finished run. The server replays it from the database. */
  const openRun = useCallback((id: string) => {
    lastSeqRef.current = 0;
    setEvents([]);
    setSummary(undefined);
    setRunId(id);
    void getRun(id).then((found) => {
      if (found !== undefined) setSummary(found);
    });
  }, []);

  // Reconnects from the last sequence seen, so a dropped stream resumes rather
  // than replaying from zero or losing what happened while it was down.
  useEffect(() => {
    if (runId === undefined) return;

    let closed = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      source = new EventSource(eventStreamUrl(runId, lastSeqRef.current));

      source.onopen = () => {
        setConnection("live");
      };

      source.onmessage = (message: MessageEvent<string>) => {
        const event = JSON.parse(message.data) as HarborEvent;
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
        setEvents((current) =>
          current.some((seen) => seen.seq === event.seq) ? current : [...current, event],
        );

        if (
          event.type === "run_succeeded" ||
          event.type === "run_failed" ||
          event.type === "escalated"
        ) {
          void getRun(runId).then((next) => {
            if (next !== undefined) setSummary(next);
          });
          refreshHistory();

          // The server keeps the stream open after a run ends, so the socket is
          // still healthy and the badge would read "live" indefinitely on a
          // finished run. What the operator wants to know is whether the run is
          // going, not whether a connection is.
          setConnection("idle");
        }
      };

      source.onerror = () => {
        source?.close();
        if (closed) return;

        // EventSource cannot tell a dropped connection from a stream the server
        // closed on purpose, and a finished run's replay always ends. Asking
        // whether the run is still going is the difference between reconnecting
        // and retrying a completed run every two seconds forever.
        void getRun(runId).then((current) => {
          if (closed) return;
          if (current !== undefined) setSummary(current);

          if (current !== undefined && current.status !== "running") {
            setConnection("idle");
            return;
          }
          setConnection("reconnecting");
          retry = setTimeout(connect, 2000);
        });
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [runId, refreshHistory]);

  // Follow the tail while a run is live.
  useEffect(() => {
    const node = streamRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [events]);

  const onStart = (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    setError(undefined);
    setStarting(true);

    void startRun(repoUrl.trim())
      .then((started) => {
        lastSeqRef.current = 0;
        setEvents([]);
        setSummary(undefined);
        setRunId(started.id);
      })
      .catch((thrown: unknown) => {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      })
      .finally(() => {
        setStarting(false);
      });
  };

  const steps = deriveSteps(events);
  const incidents = deriveIncidents(events);
  const status = summary?.status ?? (runId === undefined ? undefined : "running");

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="font-mono text-xl font-medium tracking-tight">Harbor</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Give it a repository. It deploys, watches, and repairs what it can.
        </p>
      </header>

      {health !== undefined && !health.ready && <SetupNotice health={health} />}

      <form onSubmit={onStart} className="mb-8">
        <label htmlFor="repo" className="mb-2 block text-sm font-medium">
          Repository
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="repo"
            name="repo"
            type="url"
            required
            value={repoUrl}
            onChange={(changed) => {
              setRepoUrl(changed.target.value);
            }}
            placeholder="https://github.com/owner/repo"
            className="min-h-11 flex-1 rounded-md border border-border bg-card px-3 font-mono text-sm text-card-foreground placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={starting || health?.ready === false}
            className="min-h-11 cursor-pointer rounded-md bg-primary px-5 text-sm font-semibold text-on-primary transition-opacity duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {starting ? "Starting" : "Start operation"}
          </button>
        </div>
        {error !== undefined && (
          <p role="alert" className="mt-3 text-sm text-destructive-text">
            {error}
          </p>
        )}
      </form>

      {status !== undefined && (
        <TerminalBanner status={status} summary={summary} connection={connection} />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-6">
          <ServiceCard summary={summary} repoUrl={repoUrl} status={status} />
          <StepList steps={steps} />
          {incidents.length > 0 && <IncidentList incidents={incidents} />}
        </div>

        <ActivityStream events={events} connection={connection} scrollRef={streamRef} />
      </div>

      <HistoryList runs={history} onOpen={openRun} openId={runId} />
    </main>
  );
}

/**
 * What is missing, and what to do about it.
 *
 * A missing credential is a setup step, not a failure, so it is stated before
 * the operator clicks rather than surfaced as an error after a run refuses to
 * start. The page never offers to collect the key: a secret typed into a form
 * travels through the browser, sits in component state, and lands in devtools,
 * which is exactly what reading it from the environment avoids.
 */
function SetupNotice({ health }: { health: HarborHealth }) {
  return (
    <section
      role="status"
      className="mb-6 rounded-md border border-pending bg-pending/10 px-4 py-4 text-sm"
    >
      <p className="font-medium text-pending">Harbor has no Render credentials</p>
      <p className="mt-1">
        Set <code className="font-mono text-xs">{health.missing ?? "the required variables"}</code>{" "}
        in <code className="font-mono text-xs">agent/.env</code>, then restart the server with{" "}
        <code className="font-mono text-xs">npm run serve</code>.
      </p>
      <p className="mt-2 text-muted-foreground">
        Credentials are read from the environment. Harbor never accepts them through this page.
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- banner -- */

function TerminalBanner({
  status,
  summary,
  connection,
}: {
  status: RunSummary["status"];
  summary: RunSummary | undefined;
  connection: Connection;
}) {
  if (status === "running") {
    return (
      <div role="status" className="mb-6 rounded-md border border-border bg-card px-4 py-3 text-sm">
        <span className="font-medium text-pending">Operation in progress</span>
        {connection === "reconnecting" && (
          <span className="ml-2 text-muted-foreground">
            Stream dropped, reconnecting. It resumes where it stopped.
          </span>
        )}
      </div>
    );
  }

  const failed = status !== "succeeded";
  const resolved = summary?.issuesResolved ?? 0;

  return (
    <section
      role="status"
      aria-live="polite"
      className={`mb-6 rounded-md border px-4 py-4 ${
        failed ? "border-destructive bg-destructive/10" : "border-primary bg-primary/10"
      }`}
    >
      <p className={`font-mono text-sm font-medium ${failed ? "text-destructive-text" : "text-primary"}`}>
        {status === "succeeded" ? "Succeeded" : status === "escalated" ? "Escalated" : "Failed"}
      </p>

      {resolved > 0 && (
        <p className="mt-1 text-sm">
          Harbor automatically resolved {resolved} {resolved === 1 ? "issue" : "issues"}.
        </p>
      )}

      {/* An escalation is a question put to a person, so it reads as one. */}
      {summary?.escalation !== undefined && (
        <div className="mt-3 rounded border border-border bg-card p-3">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Needs a decision from you
          </p>
          <p className="mt-1 text-sm">{summary.escalation}</p>
        </div>
      )}

      {summary?.serviceUrl !== undefined && status === "succeeded" && (
        <a
          href={summary.serviceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block cursor-pointer font-mono text-sm text-primary underline underline-offset-4"
        >
          {summary.serviceUrl}
        </a>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- service -- */

function ServiceCard({
  summary,
  repoUrl,
  status,
}: {
  summary: RunSummary | undefined;
  repoUrl: string;
  status: RunSummary["status"] | undefined;
}) {
  return (
    <section
      aria-labelledby="service-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="service-heading" className="mb-3 text-sm font-semibold">
        Service
      </h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="flex items-center gap-2">
          <StatusDot status={status} />
          <span>{status ?? "No operation started"}</span>
        </dd>

        <dt className="text-muted-foreground">Repository</dt>
        <dd className="truncate font-mono text-xs">{summary?.repoUrl ?? repoUrl}</dd>

        <dt className="text-muted-foreground">URL</dt>
        <dd className="truncate font-mono text-xs">
          {summary?.serviceUrl ?? <span className="text-muted-foreground">Not assigned yet</span>}
        </dd>

        <dt className="text-muted-foreground">Started</dt>
        <dd className="font-mono text-xs">
          {summary?.startedAt === undefined ? "—" : formatClock(summary.startedAt)}
        </dd>
      </dl>
    </section>
  );
}

function StatusDot({ status }: { status: RunSummary["status"] | undefined }) {
  const tone =
    status === "succeeded"
      ? "bg-primary"
      : status === "running"
        ? "bg-pending"
        : status === undefined
          ? "bg-muted-foreground"
          : "bg-destructive";

  return <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${tone}`} />;
}

/* ----------------------------------------------------------------- steps -- */

function StepList({ steps }: { steps: readonly Step[] }) {
  return (
    <section aria-labelledby="steps-heading" className="rounded-md border border-border bg-card p-4">
      <h2 id="steps-heading" className="mb-3 text-sm font-semibold">
        Current operation
      </h2>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No steps yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center gap-3 text-sm">
              <StepIcon status={step.status} />
              <span className="flex-1">{step.label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {formatDuration(step.durationMs)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** SVG rather than emoji: emoji render differently per platform and read badly aloud. */
function StepIcon({ status }: { status: StepStatus }) {
  const label = status === "ok" ? "passed" : status === "failed" ? "failed" : "in progress";
  const tone =
    status === "ok" ? "text-primary" : status === "failed" ? "text-destructive-text" : "text-pending";

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      className={`h-4 w-4 shrink-0 ${tone}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {status === "ok" && <path d="M3 8.5l3.5 3.5L13 4.5" />}
      {status === "failed" && <path d="M4 4l8 8M12 4l-8 8" />}
      {status === "running" && <circle cx="8" cy="8" r="4" />}
    </svg>
  );
}

/* ------------------------------------------------------------- incidents -- */

function IncidentList({ incidents }: { incidents: readonly Incident[] }) {
  return (
    <section
      aria-labelledby="incidents-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="incidents-heading" className="mb-3 text-sm font-semibold">
        Incidents
      </h2>
      <ul className="flex flex-col gap-4">
        {incidents.map((incident) => (
          <li key={incident.seq} className="text-sm">
            <p>{incident.symptom}</p>
            {incident.failureClass !== undefined && (
              <p className="mt-1 font-mono text-xs text-muted-foreground">{incident.failureClass}</p>
            )}
            {incident.fix !== undefined && <p className="mt-2 text-primary">{incident.fix}</p>}
            {/* The diff is what makes a fix auditable rather than merely reported. */}
            {incident.diff !== undefined && (
              <pre className="mt-2 max-h-48 overflow-auto rounded border border-border bg-muted p-2 font-mono text-xs">
                {incident.diff}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- stream -- */

function ActivityStream({
  events,
  connection,
  scrollRef,
}: {
  events: readonly HarborEvent[];
  connection: Connection;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <section
      aria-labelledby="activity-heading"
      className="flex min-h-96 flex-col rounded-md border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 id="activity-heading" className="text-sm font-semibold">
          Activity
        </h2>
        <span className="font-mono text-xs text-muted-foreground">{connection}</span>
      </div>

      <div
        ref={scrollRef}
        aria-live="polite"
        aria-relevant="additions"
        className="flex-1 overflow-y-auto p-4"
      >
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Start an operation to watch it run.
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {events.map((event) => (
              <li key={event.seq} className="flex gap-3 font-mono text-xs leading-relaxed">
                <time dateTime={event.at} className="shrink-0 text-muted-foreground">
                  {formatClock(event.at)}
                </time>
                <span className={toneFor(event.type)}>{event.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function toneFor(type: HarborEvent["type"]): string {
  if (type === "run_failed" || type === "step_failed" || type === "incident_opened") {
    return "text-destructive-text";
  }
  if (type === "run_succeeded" || type === "step_succeeded" || type === "fix_applied") {
    return "text-primary";
  }
  if (type === "escalated" || type === "budget_warning") return "text-pending";
  return "text-card-foreground";
}

/* --------------------------------------------------------------- history -- */

function HistoryList({
  runs,
  onOpen,
  openId,
}: {
  runs: readonly RunSummary[];
  onOpen: (id: string) => void;
  openId: string | undefined;
}) {
  if (runs.length === 0) return null;

  return (
    <section aria-labelledby="history-heading" className="mt-8">
      <h2 id="history-heading" className="mb-3 text-sm font-semibold">
        Previous operations
      </h2>
      <ul className="flex flex-col gap-2">
        {runs.map((run) => (
          <li key={run.id}>
            {/* Opening a past run is navigation, not orchestration: it replays
                what already happened and cannot change it. */}
            <button
              type="button"
              onClick={() => {
                onOpen(run.id);
              }}
              aria-current={run.id === openId ? "true" : undefined}
              className={`flex min-h-11 w-full cursor-pointer flex-wrap items-center gap-3 rounded-md border bg-card px-4 py-3 text-left text-sm transition-colors duration-200 hover:border-muted-foreground ${
                run.id === openId ? "border-primary" : "border-border"
              }`}
            >
              <StatusDot status={run.status} />
              <span className="truncate font-mono text-xs">{run.repoUrl}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {formatClock(run.startedAt)}
              </span>
              {run.issuesResolved > 0 && (
                <span className="font-mono text-xs text-primary">{run.issuesResolved} fixed</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
