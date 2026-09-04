import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Home from './page'

describe('mission control shell', () => {
  it('identifies itself and shows an operational status', () => {
    render(<Home />)
    expect(screen.getByRole('heading', { level: 1, name: 'HARBOR' })).toBeDefined()
    expect(screen.getByText('IDLE')).toBeDefined()
  })

  it('renders the deploy loop as an ordered step list', () => {
    render(<Home />)
    const operation = screen.getByRole('region', { name: /current operation/i })
    const steps = within(operation).getAllByRole('listitem')

    expect(steps).toHaveLength(6)
    expect(steps[0]?.textContent).toContain('Inspect repository')
    expect(steps.at(-1)?.textContent).toContain('Health check')
  })

  it('explains the idle state rather than showing an empty panel', () => {
    render(<Home />)
    const activity = screen.getByRole('region', { name: /agent activity/i })
    expect(within(activity).getByText(/no operation running/i)).toBeDefined()
  })
})
