// Durable pause/resume for a single call.
//
// When a handler asks the consumer a question (`ctx.ask`) it does NOT wait for the answer — that
// could take days, and a waiting handler would hold a concurrency slot, die on every deploy, and pin
// the call to one process. Instead the SDK ends the turn with a `suspend` frame carrying the question
// and this journal. When the consumer answers (or skips, or the deadline passes), the platform
// dispatches the call again with the journal and the response, and the handler runs from the top:
// `ctx.step(key)` returns what it returned last time instead of doing the work again, and
// `ctx.ask(key)` returns the answer. The platform stores the journal and hands it back; it never
// reads it, and the SDK keeps no copy of its own.

import type { AskResponse, AskResult } from './types'

/** Uncompressed. The relay enforces the same cap. */
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024

export interface JournalData {
  v: 1
  /** Memoized step results, wrapped so `undefined` survives JSON. */
  steps: Record<string, { value?: unknown }>
  /** Every question's outcome so far, including 'unavailable', so a replay decides the same way. */
  answers: Record<string, AskResponse>
}

export interface PendingQuestion {
  key: string
  message: string
  schema: Record<string, unknown>
}

/**
 * Thrown by `ctx.ask` (and by any later `ctx.step`) once the run has decided to suspend. It exists
 * only to unwind the handler. Catching it changes nothing: the SDK suspends the run anyway, based on
 * the question recorded in the journal, and logs a warning that the handler swallowed it.
 */
export class SuspendSignal extends Error {
  constructor() {
    super('[z3t SDK] The run is suspended to ask the consumer a question — let this propagate.')
    this.name = 'SuspendSignal'
  }
}

export interface ResumeFrame {
  checkpoint: unknown
  response: AskResponse & { key: string }
}

function isJournal(v: unknown): v is JournalData {
  return !!v && typeof v === 'object' && (v as JournalData).v === 1
}

export class CallJournal {
  private readonly data: JournalData
  private readonly seen = new Set<string>()
  /** The question whose answer this turn delivers — reaching it ends the replay. */
  private readonly resumedKey: string | null
  private replayingFlag: boolean
  pending: PendingQuestion | null = null

  constructor(resume?: ResumeFrame) {
    this.data = isJournal(resume?.checkpoint)
      ? { v: 1, steps: { ...resume!.checkpoint.steps }, answers: { ...resume!.checkpoint.answers } }
      : { v: 1, steps: {}, answers: {} }

    if (resume?.response?.key) {
      const { key, ...response } = resume.response
      this.data.answers[key] = response as AskResponse
      this.resumedKey = key
    } else {
      this.resumedKey = null
    }
    this.replayingFlag = Object.keys(this.data.steps).length > 0 || Object.keys(this.data.answers).length > 0
  }

  /** True while re-running code that already ran in an earlier turn. Progress is suppressed then,
   *  or every resume would repeat the activity log's rows. */
  get replaying(): boolean {
    return this.replayingFlag
  }

  private claimKey(kind: string, key: string): void {
    if (typeof key !== 'string' || key.length === 0) throw new Error(`[z3t SDK] ${kind} needs a non-empty key`)
    if (this.seen.has(key)) {
      throw new Error(`[z3t SDK] Duplicate ${kind} key "${key}" — step and ask keys must be unique within a call`)
    }
    this.seen.add(key)
  }

  async step<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.pending) throw new SuspendSignal()
    this.claimKey('step', key)

    if (Object.prototype.hasOwnProperty.call(this.data.steps, key)) {
      return this.data.steps[key].value as T
    }

    this.replayingFlag = false
    const value = await fn()
    // Round-trip through JSON NOW, not only on replay: a Date that comes back as a string, or a class
    // instance that comes back as a plain object, must surprise the developer on the first run —
    // not days later, on the resume, in production.
    const stored = JSON.parse(JSON.stringify({ value })) as { value?: unknown }
    this.data.steps[key] = stored
    return stored.value as T
  }

  ask(key: string, question: Omit<PendingQuestion, 'key'>, canAsk: boolean): AskResult<Record<string, unknown>> {
    if (this.pending) throw new SuspendSignal()
    this.claimKey('ask', key)

    const known = this.data.answers[key]
    if (known) {
      if (key === this.resumedKey) this.replayingFlag = false
      return known as AskResult<Record<string, unknown>>
    }

    this.replayingFlag = false
    if (!canAsk) {
      // Recorded so a later turn replays the same decision even if asking has become possible.
      this.data.answers[key] = { action: 'unavailable' }
      return { action: 'unavailable' }
    }

    if (!question.message || typeof question.message !== 'string') {
      throw new Error(`[z3t SDK] ctx.ask("${key}") needs a message`)
    }
    if (question.schema?.type !== 'object') {
      throw new Error(`[z3t SDK] ctx.ask("${key}") needs an s.object(...) schema`)
    }
    this.pending = { key, ...question }
    throw new SuspendSignal()
  }

  /** The journal to hand the platform on suspend. Throws if it exceeds the cap — better a clear
   *  failure in the agent than a rejection at the relay. */
  checkpoint(): JournalData {
    const encoded = JSON.stringify(this.data)
    const size = Buffer.byteLength(encoded, 'utf8')
    if (size > MAX_CHECKPOINT_BYTES) {
      throw new Error(
        `[z3t SDK] Checkpoint is ${size} bytes, over the ${MAX_CHECKPOINT_BYTES}-byte limit. ` +
          `Keep step results small — upload large artifacts with ctx.files.upload and journal the URI.`,
      )
    }
    // A copy, not the live journal: a step still running in parallel with the ask may finish after
    // the suspend, and must not change what the retries re-send.
    return JSON.parse(encoded) as JournalData
  }
}
