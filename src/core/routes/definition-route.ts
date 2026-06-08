import { extractDefinitionPayload } from '../definition-extractor.ts'
import type { DefinitionPayload } from '../definition-extractor.ts'
import { consumeBudget } from '../query-budget.ts'
import type { BudgetContext } from '../query-budget.ts'

export type RouteSource = 'alias' | 'resolve' | 'search' | 'not_found'

export interface DefinitionRouteResult {
  payload: DefinitionPayload | null
  source: RouteSource
  early_cutoff: boolean       // returned at an intermediate node
  fallback_triggered: boolean // had to fall through to search
  steps_taken: string[]       // debug trail
}

export interface DefinitionRouteEngine {
  lookupAlias(term: string): { canonical_slug: string } | undefined
  resolveSlugs(term: string): Promise<{ slug: string; score?: number } | null>
  getPage(slug: string): Promise<{
    slug: string
    title?: string
    compiled_truth?: string
    content?: string
    updated_at?: string
  } | null>
  search(term: string, limit: number): Promise<Array<{ slug: string; score: number }>>
}

const RESOLVE_HIGH_SCORE = 0.95
const SEARCH_MIN_SCORE = 0.90

export async function runDefinitionRoute(
  term: string,
  engine: DefinitionRouteEngine,
  budgetCtx: BudgetContext,
): Promise<DefinitionRouteResult> {
  const steps: string[] = []

  // ─── Node 1: alias table (synchronous, no budget cost) ───────────────────
  const aliasHit = engine.lookupAlias(term)
  if (aliasHit) {
    steps.push('alias_hit')
    consumeBudget(budgetCtx, 'get_page')
    const page = await engine.getPage(aliasHit.canonical_slug)
    if (page) {
      steps.push('page_fetched')
      return {
        payload: extractDefinitionPayload(page, 'alias'),
        source: 'alias',
        early_cutoff: true,
        fallback_triggered: false,
        steps_taken: steps,
      }
    }
    steps.push('alias_page_miss')
    // fall through — alias pointed at a missing page
  } else {
    steps.push('alias_miss')
  }

  // ─── Node 2: resolve_slugs ────────────────────────────────────────────────
  consumeBudget(budgetCtx, 'resolve_slugs')
  const resolved = await engine.resolveSlugs(term)

  if (resolved && (resolved.score ?? 1) >= RESOLVE_HIGH_SCORE) {
    steps.push('resolve_hit_high_score')
    consumeBudget(budgetCtx, 'get_page')
    const page = await engine.getPage(resolved.slug)
    if (page) {
      steps.push('page_fetched')
      return {
        payload: extractDefinitionPayload(page, 'resolve'),
        source: 'resolve',
        early_cutoff: true,
        fallback_triggered: false,
        steps_taken: steps,
      }
    }
    steps.push('resolve_page_miss')
    // fall through to search
  } else if (resolved) {
    steps.push('resolve_hit_low_score')
  } else {
    steps.push('resolve_miss')
  }

  // ─── Node 3: search fallback ──────────────────────────────────────────────
  const fallback_triggered = true
  consumeBudget(budgetCtx, 'search')
  const results = await engine.search(term, 3)

  const top = results[0]
  if (top && top.score >= SEARCH_MIN_SCORE) {
    steps.push('search_hit')
    consumeBudget(budgetCtx, 'get_page')
    const page = await engine.getPage(top.slug)
    if (page) {
      steps.push('page_fetched')
      return {
        payload: extractDefinitionPayload(page, 'search'),
        source: 'search',
        early_cutoff: false,
        fallback_triggered,
        steps_taken: steps,
      }
    }
    steps.push('search_page_miss')
  } else {
    steps.push('search_miss')
  }

  return {
    payload: null,
    source: 'not_found',
    early_cutoff: false,
    fallback_triggered,
    steps_taken: steps,
  }
}
