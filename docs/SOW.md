# Harbor — Statement of Work

**Project:** Harbor — an autonomous deployment operator
**Event:** Agents for Humans Hackathon
**Status:** Draft v1
**Owner:** aarochu

---

## 1. Objective

Deliver a working agent that accepts a single goal — *"deploy this repository"* — and autonomously drives a GitHub repository to a healthy, publicly reachable production service, including diagnosing and repairing at least two classes of deployment failure without human input.

Success is measured by the agent completing the loop unattended, not by the breadth of frameworks or clouds supported.

## 2. Problem statement

Deployment is a continuous operational loop — inspect, configure, deploy, observe, diagnose, fix, redeploy — that humans are forced to babysit. The friction is not knowledge; it is the requirement that a person sit in the loop repeatedly observing and acting. Harbor automates that loop.

## 3. Solution summary

A Strands-based agent with a real tool surface across three domains (source control, deployment provider, runtime observation), a persistent state store, and a mission-control UI that renders the agent's plan, step timings, and live activity stream. The agent reasons over tool results and decides its own next action; the UI observes, it does not orchestrate.

## 4. In scope

### 4.1 Agent core
- Strands agent with a system prompt defining the operator role, the deploy loop, and escalation rules.
- Tool-calling loop with turn cap, wall-clock cap, and a per-deployment fix budget.
- Structured deployment plan produced before execution and persisted.
- Structured event emission for every reasoning step and tool call.

### 4.2 Repository intelligence
Detects, without user input:
- Language and framework (FastAPI, Express, Next.js)
- Package manager and lockfile (pip/poetry/uv, npm/pnpm/yarn)
- Build command and start command
- Listening port and how it is configured
- Dockerfile presence and validity
- Database requirement and driver
- Required environment variables (from code references, `.env.example`, config files)

### 4.3 Deployment execution
- Provision a Render web service from a GitHub repo.
- Provision a managed Postgres instance and wire `DATABASE_URL`.
- Set and update environment variables.
- Trigger deploys and poll status to terminal state.
- Retrieve build logs and runtime logs.
- Verify health via HTTP probe against the service URL.

### 4.4 Self-healing (the differentiator)

The agent must autonomously detect, diagnose, repair, and re-verify at least these failure classes:

| Class | Symptom | Repair |
|---|---|---|
| **A. Port mismatch** | Container runs, health check times out | Rebind app/config to the platform-provided `$PORT` |
| **B. Missing dependency** | Build fails on unresolved import | Identify the package from source imports, add to manifest, commit, redeploy |
| **C. Missing env var** | Runtime crash-loop on startup config | Detect the variable, set it, or escalate if it is a secret |
| **D. Wrong start command** | Process exits immediately | Re-derive start command from framework conventions and update service config |

Classes A and B are required for the demo. C and D are stretch.

### 4.5 Interface
- Mission-control dashboard: service card (status, URL, last deploy), current-operation step list with per-step timing and pass/fail, resolved-issue count.
- Live agent activity stream, timestamped, streaming during the run.
- Single input: a GitHub repo URL, and a START OPERATION control.

### 4.6 State and history
Persisted: deployments, plan steps, tool invocations, incidents (failure + diagnosis + fix + outcome), activity events, and the final service URL.

### 4.7 Guardrails
- Allowlisted tool set; no arbitrary shell execution against production.
- Repository content is treated as data, never as instructions to the agent.
- Fix budget (default 3 attempts) before escalation to the human.
- Fixes commit to a Harbor-managed branch; never force-push to a default branch.
- Secret values are write-only, redacted from logs, activity stream, and model context.
- Human approval required for paid resource creation, destructive migrations, and production data changes.

### 4.8 Demo assets
- Three seeded demo repositories: one clean, one with a missing dependency, one with a port mismatch.
- A five-minute recorded demo built around a *failing* deployment that the agent repairs.

## 5. Out of scope

- Cloud providers other than Render (AWS, Vercel, GCP, Azure, Fly.io).
- Kubernetes, Terraform, or any IaC generation.
- Custom domains, DNS, TLS/certificate management.
- Autoscaling, cost optimization, capacity planning.
- Multi-tenant accounts, org/team permissions, billing.
- Continuous monitoring and repair after the initial deployment succeeds — this is the post-hackathon vision, not the MVP.
- Frameworks beyond FastAPI, Express, and Next.js.
- Monorepos and multi-service repositories.

## 6. Deliverables

| ID | Deliverable | Acceptance |
|---|---|---|
| D1 | Harbor agent (Strands) with full tool surface | Agent selects and sequences tools with no hardcoded pipeline |
| D2 | Repository intelligence module | Correctly profiles all three demo repos, unattended |
| D3 | Render deployment integration | Creates service + Postgres, deploys, returns a live URL |
| D4 | Observation layer | Retrieves build logs, runtime logs, and health status |
| D5 | Self-healing loop | Repairs failure classes A and B end-to-end, unattended |
| D6 | Mission-control UI + activity stream | Renders plan, live steps, timings, and outcome |
| D7 | State store + deployment history | Full run reconstructable from persisted records |
| D8 | Guardrail enforcement | Fix budget, branch isolation, and secret redaction demonstrably active |
| D9 | Demo repositories | Three repos reproducing clean, missing-dep, and port-mismatch scenarios |
| D10 | Five-minute demo video | Follows the failure-first structure in §9 |
| D11 | Documentation | README, SOW, TODO, and architecture notes current at submission |

**Stretch:** deployment of Harbor itself to AWS AgentCore with tracing/observability; failure classes C and D; automatic rollback on repeated failure.

## 7. Milestones

Relative days; compress or expand to the actual event calendar.

| Milestone | Day | Exit criteria |
|---|---|---|
| **M0 — Foundations** | 1 | Repo scaffolded, Strands agent boots, one trivial tool round-trips, state store schema applied |
| **M1 — Inspect** | 1–2 | Agent profiles all three demo repos correctly with no hints |
| **M2 — Deploy (happy path)** | 2 | Agent deploys the clean repo to Render and returns a working URL |
| **M3 — Observe** | 2–3 | Agent reads build logs, runtime logs, and health status; failure is detected, not silently passed |
| **M4 — Self-heal** | 3–4 | Classes A and B repaired unattended; fix budget and branch isolation enforced |
| **M5 — Mission control** | 4 | Dashboard and activity stream render a full live run |
| **M6 — Harden** | 5 | Guardrails verified, timeouts and caps tuned, three consecutive clean end-to-end runs |
| **M7 — Demo** | 5 | Video recorded and submitted; docs final |

## 8. Acceptance criteria (definition of done)

Harbor is done when, from a cold start:

1. A user submits only a GitHub URL and touches nothing else.
2. The agent produces a deployment plan and executes it via tool calls.
3. An intentionally broken repo fails deployment.
4. The agent diagnoses the failure from logs, applies a fix, and redeploys — with zero human input.
5. A health check passes and a live URL is returned.
6. The dashboard shows the failure, the diagnosis, the fix, and the recovery.
7. The full run is reconstructable from the persisted history.
8. No secret value appears in any log, event, or UI surface.

## 9. Demo structure (5:00)

| Time | Beat |
|---|---|
| 0:00–0:30 | The manual loop: build fails, read logs, fix, commit, redeploy, wait, repeat |
| 0:30–1:00 | Give Harbor the goal — one URL, START OPERATION, then hands off the keyboard |
| 1:00–2:30 | Build fails; agent investigates and fixes a missing dependency. Health check fails; agent detects and corrects a port mismatch |
| 2:30–3:00 | Deployed, database connected, health passing — open the live URL |
| 3:00–4:00 | Architecture: reason -> tools -> real infrastructure -> observe -> reason -> act. Harbor operates the lifecycle; it does not emit a script |
| 4:00–5:00 | Why it matters: developers are the glue between code, infra, and logs. Harbor removes that coordination tax. You give it a desired state; it works until that state holds |

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Render free-tier build times blow the demo clock | High | Pre-warm services; record with cuts; keep demo apps minimal |
| Provider API rate limits or flakiness mid-demo | High | Cache status polls, exponential backoff, pre-recorded fallback run |
| Agent loops without converging | High | Hard fix budget, turn cap, wall-clock cap, then escalate |
| Agent makes a destructive repo change | Medium | Managed branch only; no force-push; diff logged before commit |
| Scope creep into multi-cloud | High | The out-of-scope list in §5 is binding for the hackathon |
| Model non-determinism produces an off-script demo run | Medium | Deterministic demo repos, pinned model, rehearsed runs, recorded backup |
| Secret leakage into logs or model context | High | Write-only env handling plus a redaction filter on every event sink |
| **Free-tier cold starts read as failures** | **High** | Render free web services spin down after 15 minutes idle. A cold start delays the first response, so a naive health check times out and Harbor "diagnoses" a bug that does not exist — burning fix budget and credits on a phantom. The health probe must use a cold-start-tolerant timeout and distinguish *slow* from *down* |
| AWS credits exhausted before the demo | High | Prompt caching, output-token cap, turn caps, truncated logs; monitor the credit balance; Haiku fallback for routine steps |
| Render free Postgres expires 30 days after creation | Medium | Create the demo database close to the event; treat it as disposable and re-provisionable |

## 11. Assumptions and budget

**Hard constraint: this project ships at zero out-of-pocket cost.** Every component must sit on a free tier or on the $100 AWS credit balance.

| Component | Cost | Notes |
|---|---|---|
| Model inference | AWS credits | Claude on Bedrock. The only metered spend in the project |
| Render web service | Free | 512 MB / 0.1 CPU, 750 instance-hours per workspace per month |
| Render Postgres | Free | 1 GB, **expires 30 days after creation** |
| GitHub | Free | Public repos |
| Harbor's own state store | Free | Local Postgres during development |
| AWS AgentCore (stretch) | Metered | Only attempt if credits are comfortably underspent |

**Inference budget.** At Bedrock on-demand rates for Claude Sonnet 4.6 ($3/M input, $15/M output), a full deploy loop — roughly 15 model turns over a growing transcript — lands near $0.85. That is on the order of 100 full runs inside $100: ample for the hackathon, but not unlimited. Therefore:

- Prompt caching is enabled on every model call (`cacheConfig`), since the loop re-sends the repo profile and log excerpts each turn.
- Output tokens are capped (`HARBOR_MAX_TOKENS`, default 4096).
- Log payloads are truncated and summarized before entering model context.
- Turn caps and the fix budget are cost controls as much as safety controls — an unbounded self-heal loop is the single largest spend risk.
- Claude Haiku 4.5 ($1/M in, $5/M out) is the fallback for routine classification steps if burn runs high.

**Other assumptions**

- A GitHub token with repo read/write on the demo repositories is available.
- A Render account with API access and free-tier web service + Postgres is available.
- Demo repositories are single-service and public.
- The AWS IAM principal has Bedrock invoke permission (see [bedrock-policy.json](bedrock-policy.json)) and model access enabled in the target region.
- Judging weights end-to-end autonomous work over framework breadth.

## 12. Tech stack

| Layer | Choice |
|---|---|
| Agent framework | Strands Agents SDK (TypeScript, `@strands-agents/sdk`) |
| Runtime | Node.js 22+ / TypeScript (ESM, NodeNext) |
| Model | Claude — Anthropic direct or Amazon Bedrock, selected by env |
| Backend | TypeScript HTTP service (Node) |
| Streaming | Server-sent events, fed by the SDK's `agent.stream()` async iterator |
| State store | PostgreSQL |
| Frontend | Next.js mission-control dashboard |
| Deployment target (of user apps) | Render — web services + managed Postgres |
| Hosting (of Harbor itself) | AWS AgentCore (stretch), otherwise Render |
