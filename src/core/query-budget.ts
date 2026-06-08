import type { QueryClass } from './query-classifier.ts'
import { assertToolAllowed } from './query-classifier.ts'

// 每種 query class 允許的最大工具呼叫次數
export const QUERY_BUDGET: Record<QueryClass, number> = {
  definition:  2,   // resolve_slugs + get_page
  lookup:      1,   // resolve_slugs only
  search:      4,   // search + get_page × 2 + 1 reserve
  comparison:  6,   // search + get_page × 4（平行兩邊）
  graph:       3,   // backlinks / traverse
  research:   10,   // query + get_chunks，有上限但寬鬆
  write:      15,   // 讀全域頁 + 驗證 + 寫入
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly queryClass: QueryClass,
    public readonly tool: string,
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`[QueryBudget] Tool "${tool}" rejected: budget exceeded for class "${queryClass}" (${used}/${limit})`)
    this.name = 'BudgetExceededError'
  }
}

export interface BudgetContext {
  queryClass: QueryClass
  used: number
  limit: number
}

// 建立一個新的 budget context
// queryClass: 正常使用；number: 測試用（直接指定 limit，queryClass 設為 'research'）
export function createBudgetContext(queryClass: QueryClass | number): BudgetContext {
  if (typeof queryClass === 'number') {
    return { queryClass: 'research', used: 0, limit: queryClass }
  }
  return {
    queryClass,
    used: 0,
    limit: QUERY_BUDGET[queryClass],
  }
}

// 使用一個工具呼叫（used++）
// 超出時 throw BudgetExceededError
// 同時整合 assertToolAllowed（forbidden tool 也在這裡攔截）
export function consumeBudget(ctx: BudgetContext, tool: string): void {
  // 1. forbidden tool check (stricter than budget)
  assertToolAllowed(ctx.queryClass, tool)

  // 2. budget check
  if (ctx.used >= ctx.limit) {
    throw new BudgetExceededError(ctx.queryClass, tool, ctx.used, ctx.limit)
  }

  ctx.used++
}

// 查看剩餘額度（不消耗）
export function remainingBudget(ctx: BudgetContext): number {
  return ctx.limit - ctx.used
}

// 重置 context（同一對話換 query class 時用）
export function resetBudgetContext(ctx: BudgetContext, newClass: QueryClass): void {
  ctx.queryClass = newClass
  ctx.used = 0
  ctx.limit = QUERY_BUDGET[newClass]
}
