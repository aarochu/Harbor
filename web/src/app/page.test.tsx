import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveIncidents, deriveSteps, formatDuration, type HarborEvent } from "@/lib/harbor";
import MissionControl from "./page";

function event(
  partial: Partial<HarborEvent> & { seq: number; type: HarborEvent["type"] },
): HarborEvent {
  return {
    at: "2026-09-06T12:00:00.000Z",
    runId: "run-1",
    message: "",
    ...partial,
  };
}

/** Answers the two calls the page makes on mount. Nothing hits the network. */
function stubServer(options: { runs?: unknown[]; health?: unknown } = {}) {
  const health = options.health ?? { ready: true, persistence: "postgres" };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(input.includes("/api/health") ? health : { runs: options.runs ?? [] }),
        ),
      ),
    ),
  );
}

/** Every stream URL the page opened, so a test can assert what it subscribed to. */
const opened: string[] = [];

/** EventSource is constructed with `new`, so the stub has to be a class. */
class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    opened.push(url);
  }

  close(): void {
    // Nothing to tear down.
  }
}

beforeEach(() => {
  opened.length = 0;
  stubServer();
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("mission control", () => {
  it("asks for a repository and offers a single way to begin", () => {
    render(<MissionControl />);

    expect(screen.getByLabelText(/repository/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start operation/i })).toBeInTheDocument();
  });

  it("renders the observation panels", () => {
    render(<MissionControl />);

    expect(screen.getByRole("region", { name: /service/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /current operation/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /activity/i })).toBeInTheDocument();
  });

  // SOW §4: the UI observes and never orchestrates. Any control that resumes,
  // approves, or cancels a run belongs to the agent, not to a viewer. Opening a
  // past run is navigation and does not count.
  it("offers no control that steers a run", () => {
    render(<MissionControl />);

    for (const label of [/pause/i, /cancel/i, /approve/i, /retry/i, /stop/i, /rollback/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  // A secret typed into a form travels through the browser, sits in component
  // state, and lands in devtools. Harbor reads credentials from the environment
  // precisely so none of that happens.
  it("never asks for a credential", () => {
    render(<MissionControl />);

    const fields = screen.getAllByRole("textbox");
    expect(fields).toHaveLength(1);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    for (const label of [/api key/i, /token/i, /secret/i, /password/i]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
  });

  it("says plainly that nothing has happened yet", () => {
    render(<MissionControl />);
    expect(screen.getByText(/start an operation to watch it run/i)).toBeInTheDocument();
  });
});

describe("when the server has no credentials", () => {
  beforeEach(() => {
    stubServer({
      health: { ready: false, missing: "RENDER_API_KEY and RENDER_OWNER_ID", persistence: "memory" },
    });
  });

  it("names what is missing and where to put it", async () => {
    render(<MissionControl />);

    expect(await screen.findByText(/harbor has no render credentials/i)).toBeInTheDocument();
    expect(screen.getByText(/RENDER_API_KEY and RENDER_OWNER_ID/)).toBeInTheDocument();
    expect(screen.getByText(/agent\/\.env/)).toBeInTheDocument();
  });

  it("says the page will not take the credential itself", async () => {
    render(<MissionControl />);
    expect(await screen.findByText(/never accepts them through this page/i)).toBeInTheDocument();
  });

  it("disables starting, rather than failing after the click", async () => {
    render(<MissionControl />);

    await screen.findByText(/harbor has no render credentials/i);
    expect(screen.getByRole("button", { name: /start operation/i })).toBeDisabled();
  });
});

describe("history", () => {
  const run = {
    id: "run-1",
    repoUrl: "https://github.com/aarochu/harbor-demo-missing-dep",
    status: "succeeded",
    startedAt: "2026-09-06T12:00:00.000Z",
    issuesResolved: 1,
    lastSeq: 23,
  };

  beforeEach(() => {
    stubServer({ runs: [run] });
  });

  it("lists a past run with what it repaired", async () => {
    render(<MissionControl />);

    expect(await screen.findByText(/harbor-demo-missing-dep/)).toBeInTheDocument();
    expect(screen.getByText(/1 fixed/)).toBeInTheDocument();
  });

  // The gap the first live run exposed: a finished run could be seen in the
  // list but never opened again.
  it("can be opened to replay the run", async () => {
    render(<MissionControl />);

    const row = await screen.findByRole("button", { name: /harbor-demo-missing-dep/ });
    fireEvent.click(row);

    await waitFor(() => {
      expect(opened.some((url) => url.includes("/api/runs/run-1/events"))).toBe(true);
    });
  });
});

describe("deriveSteps", () => {
  it("keeps an unfinished step visible rather than dropping it", () => {
    const steps = deriveSteps([
      event({ seq: 1, type: "step_started", message: "Inspect repository" }),
      event({ seq: 2, type: "step_succeeded", message: "Inspect repository", durationMs: 700 }),
      event({ seq: 3, type: "step_started", message: "Create service" }),
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ status: "ok", durationMs: 700 });
    expect(steps[1]).toMatchObject({ label: "Create service", status: "running" });
  });

  it("marks a failed step as failed", () => {
    const steps = deriveSteps([
      event({ seq: 1, type: "step_started", message: "Health check" }),
      event({ seq: 2, type: "step_failed", message: "Health check", durationMs: 120000 }),
    ]);

    expect(steps[0]?.status).toBe("failed");
  });

  it("ignores events that are not steps", () => {
    expect(deriveSteps([event({ seq: 1, type: "reasoning", message: "thinking" })])).toEqual([]);
  });
});

describe("deriveIncidents", () => {
  it("pairs a fix with the incident it resolved", () => {
    const incidents = deriveIncidents([
      event({
        seq: 1,
        type: "incident_opened",
        message: 'The application imports "httpx", which is not installed.',
        detail: { failureClass: "missing_dependency" },
      }),
      event({
        seq: 2,
        type: "fix_applied",
        message: 'Add "httpx" to requirements.txt',
        detail: { diff: "+httpx" },
      }),
    ]);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.failureClass).toBe("missing_dependency");
    expect(incidents[0]?.fix).toBe('Add "httpx" to requirements.txt');
    expect(incidents[0]?.diff).toBe("+httpx");
  });

  it("leaves an unresolved incident without a fix", () => {
    const incidents = deriveIncidents([
      event({ seq: 1, type: "incident_opened", message: "Something broke" }),
    ]);

    expect(incidents[0]?.fix).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("never reports a real step as taking no time", () => {
    expect(formatDuration(400)).toBe("<1s");
  });

  it("reads in seconds and minutes", () => {
    expect(formatDuration(59000)).toBe("59s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("shows nothing for a step that has not finished", () => {
    expect(formatDuration(undefined)).toBe("");
  });
});
