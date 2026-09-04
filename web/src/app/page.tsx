/**
 * Harbor mission control — static shell.
 *
 * Layout only. The step list and activity stream render placeholder data until
 * the agent's SSE event stream lands in M5 (see docs/TODO.md).
 */

type StepStatus = 'ok' | 'fail' | 'pending'

interface Step {
  label: string
  status: StepStatus
  duration?: string
}

const STEPS: Step[] = [
  { label: 'Inspect repository', status: 'pending' },
  { label: 'Detect framework', status: 'pending' },
  { label: 'Install dependencies', status: 'pending' },
  { label: 'Build', status: 'pending' },
  { label: 'Deploy', status: 'pending' },
  { label: 'Health check', status: 'pending' },
]

const STATUS_MARK: Record<StepStatus, string> = {
  ok: '✓',
  fail: '✕',
  pending: '·',
}

const STATUS_CLASS: Record<StepStatus, string> = {
  ok: 'text-emerald-400',
  fail: 'text-red-400',
  pending: 'text-neutral-600',
}

export default function Home() {
  return (
    <main className="min-h-screen bg-neutral-950 p-8 font-mono text-neutral-200">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-baseline justify-between border-b border-neutral-800 pb-4">
          <h1 className="text-xl font-semibold tracking-widest">HARBOR</h1>
          <span className="text-xs tracking-wider text-neutral-500">IDLE</span>
        </header>

        <section className="mt-8" aria-labelledby="operation-heading">
          <h2
            id="operation-heading"
            className="text-xs tracking-widest text-neutral-500"
          >
            CURRENT OPERATION
          </h2>

          <ul className="mt-4 space-y-1">
            {STEPS.map((step) => (
              <li
                key={step.label}
                className="flex items-center justify-between border-b border-neutral-900 py-2 text-sm"
              >
                <span className="flex items-center gap-3">
                  <span aria-hidden className={STATUS_CLASS[step.status]}>
                    {STATUS_MARK[step.status]}
                  </span>
                  {step.label}
                </span>
                <span className="text-neutral-600">{step.duration ?? '—'}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10" aria-labelledby="activity-heading">
          <h2
            id="activity-heading"
            className="text-xs tracking-widest text-neutral-500"
          >
            AGENT ACTIVITY
          </h2>
          <p className="mt-4 text-sm text-neutral-600">
            No operation running. Submit a repository to begin.
          </p>
        </section>
      </div>
    </main>
  )
}
