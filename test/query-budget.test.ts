import { describe, expect, test } from 'bun:test'
import {
  QUERY_BUDGET,
  BudgetExceededError,
  createBudgetContext,
  consumeBudget,
  remainingBudget,
  resetBudgetContext,
} from '../src/core/query-budget.ts'

describe('createBudgetContext', () => {
  test('initializes with correct queryClass, used=0, and limit from QUERY_BUDGET', () => {
    const ctx = createBudgetContext('definition')
    expect(ctx.queryClass).toBe('definition')
    expect(ctx.used).toBe(0)
    expect(ctx.limit).toBe(QUERY_BUDGET['definition'])
    expect(ctx.limit).toBe(2)
  })

  test('initializes correctly for each query class', () => {
    for (const [cls, limit] of Object.entries(QUERY_BUDGET)) {
      const ctx = createBudgetContext(cls as any)
      expect(ctx.queryClass).toBe(cls)
      expect(ctx.used).toBe(0)
      expect(ctx.limit).toBe(limit)
    }
  })
})

describe('consumeBudget', () => {
  test('increments used on each call', () => {
    const ctx = createBudgetContext('search') // limit=4
    consumeBudget(ctx, 'search')
    expect(ctx.used).toBe(1)
    consumeBudget(ctx, 'get_page')
    expect(ctx.used).toBe(2)
  })

  test('throws BudgetExceededError when limit reached', () => {
    const ctx = createBudgetContext('definition') // limit=2
    consumeBudget(ctx, 'resolve_slugs')
    consumeBudget(ctx, 'get_page')
    expect(() => consumeBudget(ctx, 'get_page')).toThrow(BudgetExceededError)
  })

  test('BudgetExceededError carries correct queryClass/tool/used/limit', () => {
    const ctx = createBudgetContext('definition') // limit=2
    consumeBudget(ctx, 'resolve_slugs')
    consumeBudget(ctx, 'get_page')
    // used=2, limit=2 — next call should fail
    try {
      consumeBudget(ctx, 'get_page')
      throw new Error('expected BudgetExceededError')
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError)
      const e = err as BudgetExceededError
      expect(e.queryClass).toBe('definition')
      expect(e.tool).toBe('get_page')
      expect(e.used).toBe(2)
      expect(e.limit).toBe(2)
    }
  })

  test('definition route: 3rd tool call is blocked', () => {
    const ctx = createBudgetContext('definition') // limit=2
    consumeBudget(ctx, 'resolve_slugs') // used=1
    consumeBudget(ctx, 'get_page')      // used=2
    expect(() => consumeBudget(ctx, 'get_page')).toThrow(BudgetExceededError)
  })

  test('forbidden tool for definition throws before budget check', () => {
    const ctx = createBudgetContext('definition') // limit=2, query is forbidden
    // Even with fresh budget, 'query' should throw
    expect(() => consumeBudget(ctx, 'query')).toThrow(
      `[QueryBudget] Tool "query" is forbidden for query class "definition"`,
    )
    // used should NOT have incremented
    expect(ctx.used).toBe(0)
  })

  test('BudgetExceededError has correct error name', () => {
    const ctx = createBudgetContext('lookup') // limit=1
    consumeBudget(ctx, 'resolve_slugs')
    try {
      consumeBudget(ctx, 'resolve_slugs')
    } catch (err) {
      expect((err as Error).name).toBe('BudgetExceededError')
    }
  })
})

describe('remainingBudget', () => {
  test('returns full limit when unused', () => {
    const ctx = createBudgetContext('search') // limit=4
    expect(remainingBudget(ctx)).toBe(4)
  })

  test('decrements as tools are consumed', () => {
    const ctx = createBudgetContext('search') // limit=4
    consumeBudget(ctx, 'search')
    expect(remainingBudget(ctx)).toBe(3)
    consumeBudget(ctx, 'get_page')
    expect(remainingBudget(ctx)).toBe(2)
  })

  test('returns 0 at limit', () => {
    const ctx = createBudgetContext('lookup') // limit=1
    consumeBudget(ctx, 'resolve_slugs')
    expect(remainingBudget(ctx)).toBe(0)
  })

  test('does not consume budget', () => {
    const ctx = createBudgetContext('search')
    remainingBudget(ctx)
    remainingBudget(ctx)
    expect(ctx.used).toBe(0)
  })
})

describe('resetBudgetContext', () => {
  test('resets used to 0 and updates class and limit', () => {
    const ctx = createBudgetContext('definition') // limit=2
    consumeBudget(ctx, 'resolve_slugs')
    consumeBudget(ctx, 'get_page')
    expect(ctx.used).toBe(2)

    resetBudgetContext(ctx, 'research') // limit=10
    expect(ctx.queryClass).toBe('research')
    expect(ctx.used).toBe(0)
    expect(ctx.limit).toBe(QUERY_BUDGET['research'])
    expect(ctx.limit).toBe(10)
  })

  test('allows consuming budget again after reset', () => {
    const ctx = createBudgetContext('lookup') // limit=1
    consumeBudget(ctx, 'resolve_slugs')
    expect(() => consumeBudget(ctx, 'resolve_slugs')).toThrow(BudgetExceededError)

    resetBudgetContext(ctx, 'search') // limit=4
    // Should not throw now
    expect(() => consumeBudget(ctx, 'search')).not.toThrow()
    expect(ctx.used).toBe(1)
  })
})
