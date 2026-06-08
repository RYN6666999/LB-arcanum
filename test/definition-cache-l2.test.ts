import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initL2,
  getL2,
  setL2,
  invalidateL2,
  sweepL2,
  _resetL2ForTest,
  getDefinitionFromCache,
} from '../src/core/definition-cache-l2.ts'
import { _resetL1, getL1 } from '../src/core/definition-cache.ts'
import type { DefinitionPayload } from '../src/core/definition-extractor.ts'

const TEST_DB = join(tmpdir(), `def-cache-l2-test-${process.pid}.db`)

function makePayload(slug: string): DefinitionPayload {
  return {
    slug,
    title: `Title for ${slug}`,
    one_liner: 'A short description.',
    short_def: 'Short definition text.',
    extended_def: 'Extended definition text.',
    updated_at: '2024-01-01T00:00:00Z',
    cache_hit: false,
    source: 'resolve',
  }
}

beforeEach(() => {
  initL2(TEST_DB)
  _resetL1()
})

afterEach(() => {
  _resetL2ForTest()
  _resetL1()
})

describe('definition-cache-l2', () => {
  test('1. initL2 creates table', () => {
    // If no error thrown and we can call getL2, the table exists
    expect(() => getL2('any-slug')).not.toThrow()
  })

  test('2. setL2 → getL2 normal hit', () => {
    const payload = makePayload('wiki/foo')
    setL2('wiki/foo', payload)
    const result = getL2('wiki/foo')
    expect(result).not.toBeUndefined()
    expect(result!.slug).toBe('wiki/foo')
    expect(result!.title).toBe('Title for wiki/foo')
  })

  test('3. TTL expired → getL2 returns undefined', () => {
    const payload = makePayload('wiki/expired')
    // Set with TTL in the past (-1 seconds)
    setL2('wiki/expired', payload, -1)
    const result = getL2('wiki/expired')
    expect(result).toBeUndefined()
  })

  test('4. invalidateL2 deletes key', () => {
    const payload = makePayload('wiki/bar')
    setL2('wiki/bar', payload)
    expect(getL2('wiki/bar')).not.toBeUndefined()
    invalidateL2('wiki/bar')
    expect(getL2('wiki/bar')).toBeUndefined()
  })

  test('5. sweepL2 clears expired entries and returns count', () => {
    setL2('wiki/a', makePayload('wiki/a'), 3600) // not expired
    setL2('wiki/b', makePayload('wiki/b'), -1)   // expired
    setL2('wiki/c', makePayload('wiki/c'), -2)   // expired
    const swept = sweepL2()
    expect(swept).toBe(2)
    expect(getL2('wiki/a')).not.toBeUndefined()
    expect(getL2('wiki/b')).toBeUndefined()
    expect(getL2('wiki/c')).toBeUndefined()
  })

  test('6. _resetL2ForTest cleans up (test isolation)', () => {
    setL2('wiki/x', makePayload('wiki/x'))
    _resetL2ForTest()
    // Re-init to a fresh DB to verify it was cleared
    initL2(TEST_DB)
    expect(getL2('wiki/x')).toBeUndefined()
  })

  test('7. getDefinitionFromCache: L1 miss + L2 hit → L1 backfill', () => {
    const payload = makePayload('wiki/backfill')
    setL2('wiki/backfill', payload)

    // L1 is empty
    expect(getL1('wiki/backfill', payload.updated_at)).toBeUndefined()

    const result = getDefinitionFromCache('wiki/backfill', payload.updated_at)
    expect(result).not.toBeUndefined()
    expect(result!.cache_hit).toBe(true)

    // L1 should now be populated
    const l1hit = getL1('wiki/backfill', payload.updated_at)
    expect(l1hit).not.toBeUndefined()
    expect(l1hit!.slug).toBe('wiki/backfill')
  })

  test('7b. getDefinitionFromCache: L2 miss returns undefined, no L1 backfill', () => {
    const result = getDefinitionFromCache('wiki/missing', '2024-01-01T00:00:00Z')
    expect(result).toBeUndefined()
    expect(getL1('wiki/missing', '2024-01-01T00:00:00Z')).toBeUndefined()
  })
})
