import { describe, expect, it } from 'vitest'
import { Jobs, SerialGate } from './jobs'

describe('Jobs', () => {
  it('drops late tasks so cancellation cannot publish stale output', () => {
    const jobs = new Jobs()
    const first = jobs.start()
    const second = jobs.start()
    expect(() => jobs.check(first)).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    )
    jobs.check(second)
    jobs.cancel()
    expect(() => jobs.check(second)).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    )
  })
})

describe('SerialGate', () => {
  it('survives errors and does not overlap jobs', async () => {
    const gate = new SerialGate()
    let active = 0
    let max = 0
    await Promise.all(
      [1, 2, 3].map((i) =>
        gate
          .run(async () => {
            active++
            max = Math.max(max, active)
            await new Promise((r) => setTimeout(r, 2))
            active--
            if (i === 2) throw Error('expected')
          })
          .catch(() => {}),
      ),
    )
    expect(max).toBe(1)
  })
})
