import { render, screen } from "@testing-library/react";
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

beforeEach(() => {
  // The page lists prior runs on mount; nothing here exercises the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runs: [] })))),
  );
  vi.stubGlobal(
    "EventSource",
    vi.fn(() => ({ close: vi.fn() })),
  );
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
  // approves, or cancels a run belongs to the agent, not to a viewer.
  it("offers no control that steers a run", () => {
    render(<MissionControl />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    for (const label of [/pause/i, /cancel/i, /approve/i, /retry/i, /stop/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  it("says plainly that nothing has happened yet", () => {
    render(<MissionControl />);
    expect(screen.getByText(/start an operation to watch it run/i)).toBeInTheDocument();
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
