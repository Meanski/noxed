// State updaters for queues of prompts that main answers by request id
// (host keys, MCP approvals): removal by id, so a double click or a late
// dismissal never consumes the wrong prompt, and restore after a failed answer.

interface Queued {
  requestId: string
}

export const withoutRequest = (requestId: string) => <T extends Queued>(queue: T[]): T[] =>
  queue.filter((p) => p.requestId !== requestId)

/** Puts a prompt back at the front unless it's already queued. */
export const withRequest = <T extends Queued>(prompt: T) => (queue: T[]): T[] =>
  queue.some((p) => p.requestId === prompt.requestId) ? queue : [prompt, ...queue]
