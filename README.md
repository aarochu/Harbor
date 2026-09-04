# Harbor

**An autonomous software operator.** You give Harbor a desired outcome — "deploy this repo" — and it owns the entire deployment loop until that outcome is achieved.

> Built for the Agents for Humans Hackathon.

---

## The problem

Deployment isn't hard because developers don't know how to deploy. It's hard because deployment is a **continuous operational loop that humans are forced to babysit**:

```
inspect repo -> install deps -> figure out build/start commands -> configure env
-> configure ports -> provision a database -> deploy -> read build logs
-> diagnose failure -> fix config -> redeploy -> check health -> repeat
```

Every step in that loop is observe -> diagnose -> act. That is exactly the shape of work an agent should own.

## What Harbor is

Harbor takes a repository and turns it into a running, healthy application. It inspects the code, plans the deployment, configures infrastructure, deploys, monitors the result, diagnoses failures, fixes what it can, and redeploys — surfacing to the developer only when a decision genuinely requires human judgment.

Harbor is **not** a chatbot with a deploy button, and it is **not** a generator of deployment scripts. It operates the deployment lifecycle.

## The loop

```
                  USER
                    |  "Deploy this repo"
                    v
            +---------------+
            |    HARBOR     |
            |  Agent Brain  |
            +-------+-------+
                    v
              +----------+
              | INSPECT  |  framework, deps, config, ports, DB
              +----+-----+
                   v
              +----------+
              |   PLAN   |  build -> deploy -> verify
              +----+-----+
                   v
              +----------+
              |   ACT    |  build, configure, deploy
              +----+-----+
                   v
              +----------+
              | OBSERVE  |  logs, health checks, errors
              +----+-----+
                   v
              +---------+
              |SUCCESS? |
              +--+---+--+
             yes |   | no
                 v   v
              DONE   DIAGNOSE -> FIX -> REDEPLOY --+
                        ^                          |
                        +--------------------------+
```

## Capabilities

| # | Capability | What it means |
|---|---|---|
| 1 | **Repository intelligence** | Detects framework, language, package manager, build/start commands, port, database, required env vars, Dockerfile — without being told |
| 2 | **Deployment planning** | Produces an explicit, inspectable plan before acting |
| 3 | **Execution** | Clones, installs, tests, builds, configures, deploys via real provider APIs |
| 4 | **Observation** | Reads build logs, runtime logs, health endpoints |
| 5 | **Self-healing** | Diagnoses a failure, applies a fix, redeploys, re-verifies — autonomously |
| 6 | **Escalation** | Asks the human only when a decision needs judgment (secrets, cost, destructive change) |

## The centerpiece: self-healing deployments

A green-on-first-try deployment is just CI/CD. Harbor's real demonstration is the failure path:

```
GitHub -> Deploy -> FAIL -> investigate -> fix -> redeploy -> SUCCESS
```

Example — the app listens on `8000`, the deployment expects `8080`:

```
DEPLOYMENT FAILED - health check failed, container running, no response on :8080

  Inspecting application...            FastAPI app found
  Inspecting server configuration...   listening on port 8000
  Deployment expects...                port 8080
  Mismatch detected                    updating configuration
  Redeploying...
  Health check                         PASS
```

Harbor does not stop and ask "the deployment failed, what should I do?" It investigates.

## Interface

A mission-control dashboard, not a chat window.

```
+--------------------------------------------------------------+
| HARBOR                                     * OPERATIONAL     |
+--------------------------------------------------------------+
|  [live] my-next-app        Production                        |
|         https://my-next-app.onrender.com                     |
|         Last deployment  2 min ago     Status  HEALTHY       |
|                                                              |
|  CURRENT OPERATION                                           |
|  OK  Inspect repository                         12s          |
|  OK  Detect framework                            4s          |
|  OK  Install dependencies                       31s          |
|  OK  Build                                      24s          |
|  X   Health check                                8s          |
|  OK  Diagnose                                   14s          |
|  OK  Apply fix                                   9s          |
|  OK  Redeploy                                   32s          |
|  OK  Verify                                     11s          |
|                                                              |
|             DEPLOYMENT SUCCESSFUL                            |
|   Harbor automatically resolved 1 deployment issue.          |
+--------------------------------------------------------------+
```

Alongside it, a live activity stream makes the agent's reasoning visible:

```
14:32:01  Analyzing repository
14:32:04  Detected Next.js application
14:32:52  Build failed
14:33:01  Error appears related to a missing dependency
14:33:08  Dependency identified: date-fns
14:33:10  Updating package.json
14:33:20  Redeploying
14:33:51  Health check passed
14:33:52  DEPLOYMENT COMPLETE
```

## Architecture

```
        USER --"Deploy repo"-->  HARBOR AGENT (Strands SDK)
                                   planning / reasoning
                                          |
       +------------------+---------------+---------------+
       v                  v                               v
  GitHub tools     Deployment tools                Runtime tools
  clone/read       deploy/status/logs              logs/health/metrics
  branch/commit    env/database                    rollback
       |                  |                               |
       +------------------+---------------+---------------+
                                          v
                              STATE STORE (Postgres)
                              deployments, steps,
                              incidents, activity log
```

The LLM chooses which tools to call and in what order. The tools — not the UI — are the product.

## Tool surface

```
github_clone_repo()        detect_framework()          deploy_application()
github_read_files()        inspect_package_json()      get_deployment_status()
github_create_branch()     inspect_dockerfile()        get_deployment_logs()
github_commit_changes()    inspect_environment()       get_runtime_logs()
                           run_tests()                 check_health()
set_environment_variable() run_build()                 rollback_deployment()
configure_database()                                   notify_user()
```

## Scope (MVP)

Deliberately narrow. Depth over breadth.

**Supported app types:** Python/FastAPI, Node/Express, Next.js
**Deployment target:** Render (web service + managed Postgres)

```
GitHub -> Harbor -> Render -> PostgreSQL
```

Later: AWS, Vercel, Fly.io.

## Guardrails

Harbor takes real actions against real infrastructure, so autonomy is bounded:

- **Allowlisted tools only.** No arbitrary shell execution against production.
- **Repo content is data, not instructions.** README or comment text inside a target repo never redirects the agent.
- **Fix budget.** A capped number of self-heal attempts per deployment before escalating to a human.
- **Blast radius.** Fixes land on a Harbor-managed branch, never a force-push to `main`.
- **Secrets are referenced, never printed.** Env var values are write-only and redacted from logs and the activity stream.
- **Human-in-the-loop for judgment calls.** Paid resources, destructive migrations, and production data changes require explicit approval.

## The bigger vision

Deployment is the first capability, not the product.

```
Today:      "Deploy my application."
Eventually: "Keep my application healthy."

              SOFTWARE
                 |
             +---+---+
             |HARBOR |
             +---+---+
        +--------+--------+
     Deploy   Monitor   Repair
        |        |        |
     Scale    Detect     Fix
        +--------+--------+
             PRODUCTION
```

**Harbor is an agent that maintains the desired state of your software without requiring a human to continuously operate it.**

## Documentation

- [Statement of Work](docs/SOW.md) — scope, deliverables, milestones, acceptance criteria
- [TODO](docs/TODO.md) — build checklist

## License

See [LICENSE](LICENSE).
