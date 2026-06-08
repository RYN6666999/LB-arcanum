import { describe, it, expect, mock } from 'bun:test'
import {
  runDefinitionRoute,
  type DefinitionRouteEngine,
} from '../src/core/routes/definition-route.ts'
import { createBudgetContext, BudgetExceededError } from '../src/core/query-budget.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DUMMY_PAGE = {
  slug: 'wiki/concepts/test',
  title: 'Test Concept',
  compiled_truth: 'A test concept. More detail here.',
  updated_at: '2025-01-01T00:00:00Z',
}

function makeEngine(overrides: Partial<DefinitionRouteEngine> = {}): DefinitionRouteEngine {
  return {
    lookupAlias: mock(() => undefined),
    resolveSlugs: mock(async () => null),
    getPage: mock(async () => DUMMY_PAGE),
    search: mock(async () => []),
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runDefinitionRoute', () => {

  it('alias hit → early_cutoff=true, source=alias, search not called', async () => {
    const searchFn = mock(async () => [])
    const engine = makeEngine({
      lookupAlias: mock(() => ({ canonical_slug: 'wiki/concepts/test' })),
      search: searchFn,
    })
    const budget = createBudgetContext(10)
    const result = await runDefinitionRoute('test', engine, budget)

    expect(result.source).toBe('alias')
    expect(result.early_cutoff).toBe(true)
    expect(result.fallback_triggered).toBe(false)
    expect(result.payload).not.toBeNull()
    expect(result.payload?.source).toBe('alias')
    expect(searchFn).not.toHaveBeenCalled()
    expect(result.steps_taken).toContain('alias_hit')
  })

  it('resolve high score (0.97) → early_cutoff=true, source=resolve, search not called', async () => {
    const searchFn = mock(async () => [])
    const engine = makeEngine({
      resolveSlugs: mock(async () => ({ slug: 'wiki/concepts/test', score: 0.97 })),
      search: searchFn,
    })
    const budget = createBudgetContext(10)
    const result = await runDefinitionRoute('test', engine, budget)

    expect(result.source).toBe('resolve')
    expect(result.early_cutoff).toBe(true)
    expect(result.fallback_triggered).toBe(false)
    expect(result.payload?.source).toBe('resolve')
    expect(searchFn).not.toHaveBeenCalled()
    expect(result.steps_taken).toContain('resolve_hit_high_score')
  })

  it('resolve low score (0.80) → fallback_triggered=true, search called', async () => {
    const searchFn = mock(async () => [{ slug: 'wiki/concepts/test', score: 0.93 }])
    const engine = makeEngine({
      resolveSlugs: mock(async () => ({ slug: 'wiki/concepts/test', score: 0.80 })),
      search: searchFn,
    })
    const budget = createBudgetContext(10)
    const result = await runDefinitionRoute('test', engine, budget)

    expect(result.fallback_triggered).toBe(true)
    expect(searchFn).toHaveBeenCalled()
    expect(result.steps_taken).toContain('resolve_hit_low_score')
  })

  it('resolve miss → search hit (0.92) → source=search, early_cutoff=false', async () => {
    const engine = makeEngine({
      resolveSlugs: mock(async () => null),
      search: mock(async () => [{ slug: 'wiki/concepts/test', score: 0.92 }]),
    })
    const budget = createBudgetContext(10)
    const result = await runDefinitionRoute('test', engine, budget)

    expect(result.source).toBe('search')
    expect(result.early_cutoff).toBe(false)
    expect(result.fallback_triggered).toBe(true)
    expect(result.payload?.source).toBe('search')
    expect(result.steps_taken).toContain('resolve_miss')
    expect(result.steps_taken).toContain('search_hit')
  })

  it('all miss → not_found, payload=null', async () => {
    const engine = makeEngine({
      resolveSlugs: mock(async () => null),
      search: mock(async () => [{ slug: 'wiki/concepts/low', score: 0.50 }]),
    })
    const budget = createBudgetContext(10)
    const result = await runDefinitionRoute('test', engine, budget)

    expect(result.source).toBe('not_found')
    expect(result.payload).toBeNull()
    expect(result.early_cutoff).toBe(false)
    expect(result.steps_taken).toContain('search_miss')
  })

  it('BudgetExceededError propagates (not swallowed)', async () => {
    const engine = makeEngine({
      // alias miss = no budget consumed yet
      // resolveSlugs consume(1) → should throw with limit=0
      resolveSlugs: mock(async () => null),
    })
    const budget = createBudgetContext(0) // zero budget → first consume throws
    await expect(runDefinitionRoute('test', engine, budget)).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('steps_taken correctly records visited nodes', async () => {
    const engine = makeEngine({
      resolveSlugs: mock(async () => ({ slug: 'wiki/concepts/test', score: 0.70 })),
      search: mock(async () => [{ slug: 'wiki/concepts/test', score: 0.95 }]),
    })
    const budget = createBudgetContext(10)
    const result = await runDefinitionRoute('test', engine, budget)

    expect(result.steps_taken).toEqual(
      expect.arrayContaining(['alias_miss', 'resolve_hit_low_score', 'search_hit', 'page_fetched'])
    )
    // resolve_hit_high_score should NOT be in the steps
    expect(result.steps_taken).not.toContain('resolve_hit_high_score')
  })

})
