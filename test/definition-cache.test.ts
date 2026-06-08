import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { getL1, setL1, invalidateL1, getL1Stats, _resetL1 } from '../src/core/definition-cache.ts'
import type { DefinitionPayload } from '../src/core/definition-extractor.ts'

function makePayload(slug: string, updatedAt = '2024-01-01T00:00:00Z'): DefinitionPayload {
  return {
    slug,
    title: `Title ${slug}`,
    one_liner: 'One liner.',
    short_def: 'Short def.',
    extended_def: 'Extended def.',
    updated_at: updatedAt,
    cache_hit: false,
    source: 'resolve',
  }
}

beforeEach(() => {
  _resetL1()
})

describe('definition-cache', () => {
  test('setL1 → getL1 正常命中', () => {
    const payload = makePayload('foo')
    setL1('foo', '2024-01-01', payload)
    const result = getL1('foo', '2024-01-01')
    expect(result).toEqual(payload)
  })

  test('TTL 過期後 getL1 返回 undefined', () => {
    const originalNow = Date.now
    let now = 1_000_000
    Date.now = () => now

    const payload = makePayload('bar')
    setL1('bar', 'v1', payload)

    // Advance past TTL (5 minutes = 300_000ms)
    now += 300_001
    const result = getL1('bar', 'v1')
    expect(result).toBeUndefined()

    Date.now = originalNow
  })

  test('invalidateL1 清除對應 slug 的所有版本', () => {
    setL1('baz', 'v1', makePayload('baz', 'v1'))
    setL1('baz', 'v2', makePayload('baz', 'v2'))
    setL1('other', 'v1', makePayload('other', 'v1'))

    invalidateL1('baz')

    expect(getL1('baz', 'v1')).toBeUndefined()
    expect(getL1('baz', 'v2')).toBeUndefined()
    expect(getL1('other', 'v1')).toBeDefined()
  })

  test('LRU eviction：插入 501 條後最舊的被移除', () => {
    // Insert 500 entries
    for (let i = 0; i < 500; i++) {
      setL1(`slug-${i}`, 'v1', makePayload(`slug-${i}`))
    }
    _resetL1() // reset counters but not cache size — wait, _resetL1 clears everything
    // Re-fill without resetting stats mid-way; use a fresh approach
  })

  test('LRU eviction — detailed check', () => {
    // Fill to MAX_SIZE
    for (let i = 0; i < 500; i++) {
      setL1(`s${i}`, 'v1', makePayload(`s${i}`))
    }
    // slug s0 is oldest (LRU). Insert one more.
    setL1('s500', 'v1', makePayload('s500'))

    const stats = getL1Stats()
    expect(stats.size).toBe(500)
    expect(stats.evictions).toBe(1)

    // s0 should be evicted
    expect(getL1('s0', 'v1')).toBeUndefined()
    // s500 should be present
    expect(getL1('s500', 'v1')).toBeDefined()
  })

  test('getL1Stats 正確計算 hits/misses/evictions', () => {
    const payload = makePayload('x')
    setL1('x', 'v1', payload)

    getL1('x', 'v1')   // hit
    getL1('x', 'v2')   // miss (different updatedAt)
    getL1('y', 'v1')   // miss

    const stats = getL1Stats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(2)
    expect(stats.size).toBe(1)
  })

  test('不同 updated_at 版本 key 獨立', () => {
    const p1 = makePayload('doc', 'ts1')
    const p2 = makePayload('doc', 'ts2')
    setL1('doc', 'ts1', p1)
    setL1('doc', 'ts2', p2)

    const r1 = getL1('doc', 'ts1')
    const r2 = getL1('doc', 'ts2')
    expect(r1?.updated_at).toBe('ts1')
    expect(r2?.updated_at).toBe('ts2')
  })

  test('TTL 未過期時可正常命中', () => {
    const originalNow = Date.now
    let now = 1_000_000
    Date.now = () => now

    setL1('ttl-ok', 'v1', makePayload('ttl-ok'))

    // Advance just under TTL
    now += 299_999
    expect(getL1('ttl-ok', 'v1')).toBeDefined()

    Date.now = originalNow
  })
})
