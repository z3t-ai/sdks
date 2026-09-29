import { describe, it, expect, vi } from 'vitest'
import { CallJournal, SuspendSignal, MAX_CHECKPOINT_BYTES } from './journal'

const question = { message: 'Which contract does invoice 3 refer to?', schema: { type: 'object', properties: { n: { type: 'string' } } } }

describe('CallJournal.step', () => {
  it('runs the step on the first turn and records its result', async () => {
    const journal = new CallJournal()
    const fn = vi.fn().mockResolvedValue({ parties: 2 })

    expect(await journal.step('case-file', fn)).toEqual({ parties: 2 })
    expect(fn).toHaveBeenCalledOnce()
    expect(journal.checkpoint().steps['case-file']).toEqual({ value: { parties: 2 } })
  })

  it('returns the recorded result on a resumed turn WITHOUT running the step again', async () => {
    const first = new CallJournal()
    await first.step('case-file', async () => ({ parties: 2 }))
    const resumed = new CallJournal({ checkpoint: first.checkpoint(), response: { key: 'gaps', action: 'declined' } })
    const fn = vi.fn()

    expect(await resumed.step('case-file', fn)).toEqual({ parties: 2 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns the JSON form on the FIRST run too, so a non-serializable result surprises you immediately', async () => {
    const journal = new CallJournal()
    const when = new Date('2026-09-29T10:00:00Z')

    expect(await journal.step('when', () => ({ when }))).toEqual({ when: '2026-09-29T10:00:00.000Z' })
  })

  it('remembers an undefined result', async () => {
    const first = new CallJournal()
    await first.step('nothing', () => undefined)
    const resumed = new CallJournal({ checkpoint: first.checkpoint(), response: { key: 'q', action: 'declined' } })
    const fn = vi.fn()

    expect(await resumed.step('nothing', fn)).toBeUndefined()
    expect(fn).not.toHaveBeenCalled()
  })

  it('refuses a duplicate key — two steps sharing a key would replay each other\'s results', async () => {
    const journal = new CallJournal()
    await journal.step('a', () => 1)

    await expect(journal.step('a', () => 2)).rejects.toThrow(/Duplicate step key "a"/)
  })

  it('does no further work once the run has decided to suspend', async () => {
    const journal = new CallJournal()
    expect(() => journal.ask('q', question, true)).toThrow(SuspendSignal)
    const fn = vi.fn()

    await expect(journal.step('after', fn)).rejects.toBeInstanceOf(SuspendSignal)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('CallJournal.ask', () => {
  it('records the question and suspends when nothing is known yet', () => {
    const journal = new CallJournal()

    expect(() => journal.ask('gaps', question, true)).toThrow(SuspendSignal)
    expect(journal.pending).toEqual({ key: 'gaps', ...question })
  })

  it('returns `unavailable` without suspending when the run cannot ask — and replays that decision', () => {
    const journal = new CallJournal()

    expect(journal.ask('gaps', question, false)).toEqual({ action: 'unavailable' })
    expect(journal.pending).toBeNull()

    // A later turn replays the same outcome even if asking became possible.
    const resumed = new CallJournal({ checkpoint: journal.checkpoint(), response: { key: 'other', action: 'declined' } })
    expect(resumed.ask('gaps', question, true)).toEqual({ action: 'unavailable' })
  })

  it('returns the response a resume delivers', () => {
    const journal = new CallJournal({
      checkpoint: { v: 1, steps: {}, answers: {} },
      response: { key: 'gaps', action: 'answered', answers: { n: 'CX-12' }, respondedAt: '2026-09-29T10:00:00Z' } as any,
    })

    expect(journal.ask('gaps', question, true)).toMatchObject({ action: 'answered', answers: { n: 'CX-12' } })
  })

  it.each([
    ['no message', { ...question, message: '' }],
    ['a schema that is not an object form', { ...question, schema: { type: 'string' } }],
  ])('rejects %s instead of suspending', (_label, q) => {
    const journal = new CallJournal()

    expect(() => journal.ask('gaps', q as any, true)).toThrow(/needs/)
    expect(journal.pending).toBeNull()
  })
})

describe('CallJournal.replaying', () => {
  it('is false on a fresh call', () => {
    expect(new CallJournal().replaying).toBe(false)
  })

  it('stays true through recorded steps and ends at the question this turn answers', async () => {
    const first = new CallJournal()
    await first.step('extract', () => 'facts')
    try { first.ask('gaps', question, true) } catch { /* suspend */ }

    const resumed = new CallJournal({ checkpoint: first.checkpoint(), response: { key: 'gaps', action: 'declined' } })
    expect(resumed.replaying).toBe(true)
    await resumed.step('extract', () => 'never')
    expect(resumed.replaying).toBe(true)
    resumed.ask('gaps', question, true)
    expect(resumed.replaying).toBe(false)
  })

  it('ends at the first step the journal has never seen', async () => {
    const resumed = new CallJournal({ checkpoint: { v: 1, steps: { a: { value: 1 } }, answers: {} }, response: { key: 'q', action: 'declined' } })

    await resumed.step('new-work', () => 2)

    expect(resumed.replaying).toBe(false)
  })
})

describe('CallJournal.checkpoint', () => {
  it('refuses a journal over the size limit with an actionable message', async () => {
    const journal = new CallJournal()
    await journal.step('huge', () => 'x'.repeat(MAX_CHECKPOINT_BYTES))

    expect(() => journal.checkpoint()).toThrow(/over the .* limit.*ctx\.files\.upload/)
  })

  it('returns a snapshot, not the live journal', async () => {
    const journal = new CallJournal()
    await journal.step('a', () => 1)
    const snapshot = journal.checkpoint()

    await journal.step('b', () => 2) // e.g. a parallel step finishing after the suspend

    expect(snapshot.steps).toEqual({ a: { value: 1 } })
  })

  it('ignores a checkpoint it does not recognise rather than trusting it', async () => {
    const journal = new CallJournal({ checkpoint: { steps: { a: { value: 'forged' } } }, response: { key: 'q', action: 'declined' } })
    const fn = vi.fn().mockReturnValue('real')

    expect(await journal.step('a', fn)).toBe('real')
    expect(fn).toHaveBeenCalledOnce()
  })
})
