import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventBus } from './events.js'
import { HEARTBEAT_FRAME, formatEventFrame } from './sse.js'

void describe('formatEventFrame', () => {
  const bus = new EventBus('run-1')
  const event = bus.emit('run_started', 'Deploying', { repoUrl: 'https://github.com/a/b' })

  // The bug this guards: a named SSE event never reaches EventSource.onmessage,
  // so the stream connects, reports itself live, and delivers nothing.
  void it('emits no event: line, so frames reach onmessage', () => {
    assert.ok(!formatEventFrame(event).includes('event:'))
  })

  void it('uses seq as the SSE id, which is the resume cursor', () => {
    assert.match(formatEventFrame(event), /^id: 1\n/)
  })

  void it('carries the type in the payload instead', () => {
    const frame = formatEventFrame(event)
    const data = /^data: (.+)$/m.exec(frame)?.[1] ?? ''
    assert.equal((JSON.parse(data) as { type: string }).type, 'run_started')
  })

  void it('terminates the frame with a blank line', () => {
    assert.ok(formatEventFrame(event).endsWith('\n\n'))
  })

  void it('keeps the payload on one line so a newline cannot split the frame', () => {
    const multiline = bus.emit('fix_applied', 'Add "httpx"', { diff: 'a\nb\nc' })
    const body = formatEventFrame(multiline).split('\n').filter((line) => line !== '')
    assert.equal(body.length, 2, 'exactly an id line and a data line')
  })

  void it('heartbeats as a comment frame', () => {
    assert.ok(HEARTBEAT_FRAME.startsWith(':'))
  })
})
