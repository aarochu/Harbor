/**
 * SSE frame formatting.
 *
 * Deliberately unnamed events. An `event:` line makes the frame a *named* SSE
 * event, and named events do not reach `EventSource.onmessage` — a client must
 * register `addEventListener` for each name. That is a quiet failure: the
 * connection opens, reports itself healthy, and delivers nothing. It cost a
 * live run to find.
 *
 * The type is already inside the payload, so a client reads `event.type` and a
 * new event type needs no change on either side. Naming the frames would buy
 * per-type subscription that nothing wants, at the price of a listener list
 * that silently drops whatever it forgot to register.
 *
 * `id:` is kept: it is the resume cursor, and the browser returns it as
 * `Last-Event-ID` on reconnect.
 */
import type { HarborEvent } from './events.js'

export function formatEventFrame(event: HarborEvent): string {
  return `id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`
}

/** Comment frame. Keeps intermediaries from closing an idle stream. */
export const HEARTBEAT_FRAME = ': keep-alive\n\n'
