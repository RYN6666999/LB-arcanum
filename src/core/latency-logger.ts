import { mkdirSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

export type QueryClass = 'definition' | 'lookup' | 'search' | 'comparison' | 'graph' | 'research' | 'write'

export interface ToolCall {
  tool: string
  args_summary: string
  latency_ms: number
  result_size_bytes: number
  cache_hit: boolean
}

export interface QueryLatencyLog {
  request_id: string
  timestamp: string
  session_id?: string

  raw_input: string
  query_class: QueryClass
  classified_by: 'rule' | 'llm'

  alias_hit: boolean
  alias_term?: string
  canonical_slug?: string

  tools_called: ToolCall[]
  tools_count: number
  budget_used: number
  budget_limit: number

  cache_l1_hit: boolean
  cache_l2_hit: boolean

  latency_total_ms: number
  latency_classify_ms: number
  latency_alias_lookup_ms: number
  latency_first_tool_ms: number
  latency_llm_ms: number
  latency_cache_write_ms: number

  context_tokens_in: number
  result_length_chars: number
  early_cutoff: boolean
  fallback_triggered: boolean

  error?: string
  error_step?: string
}

export interface LogContext {
  _requestId: string
  _startMs: number
  _timestamp: string
  _sessionId?: string
  _rawInput: string
  _queryClass: QueryClass
  _classifiedBy: 'rule' | 'llm'
  _budgetLimit: number
  _budgetUsed: number

  _aliasHit: boolean
  _aliasTerm?: string
  _canonicalSlug?: string

  _toolsCalled: ToolCall[]
  _firstToolMs: number

  _cacheL1Hit: boolean
  _cacheL2Hit: boolean

  _latencyClassifyMs: number
  _latencyAliasLookupMs: number
  _latencyLlmMs: number
  _latencyCacheWriteMs: number

  _logPath: string
}

const DEFAULT_LOG_PATH = join(homedir(), '.gbrain', 'query-latency.jsonl')

export function startLog(input: {
  raw_input: string
  query_class: QueryClass
  classified_by: 'rule' | 'llm'
  session_id?: string
  budget_limit: number
  logPath?: string
  latency_classify_ms?: number
  latency_alias_lookup_ms?: number
  alias_hit?: boolean
  alias_term?: string
  canonical_slug?: string
}): LogContext {
  return {
    _requestId: crypto.randomUUID(),
    _startMs: Date.now(),
    _timestamp: new Date().toISOString(),
    _sessionId: input.session_id,
    _rawInput: input.raw_input.slice(0, 200),
    _queryClass: input.query_class,
    _classifiedBy: input.classified_by,
    _budgetLimit: input.budget_limit,
    _budgetUsed: 0,

    _aliasHit: input.alias_hit ?? false,
    _aliasTerm: input.alias_term,
    _canonicalSlug: input.canonical_slug,

    _toolsCalled: [],
    _firstToolMs: -1,

    _cacheL1Hit: false,
    _cacheL2Hit: false,

    _latencyClassifyMs: input.latency_classify_ms ?? 0,
    _latencyAliasLookupMs: input.latency_alias_lookup_ms ?? 0,
    _latencyLlmMs: 0,
    _latencyCacheWriteMs: 0,

    _logPath: input.logPath ?? DEFAULT_LOG_PATH,
  }
}

export function setAliasResult(ctx: LogContext, result: {
  alias_hit: boolean
  alias_term?: string
  canonical_slug?: string
  latency_alias_lookup_ms?: number
}): void {
  ctx._aliasHit = result.alias_hit
  ctx._aliasTerm = result.alias_term
  ctx._canonicalSlug = result.canonical_slug
  if (result.latency_alias_lookup_ms !== undefined) {
    ctx._latencyAliasLookupMs = result.latency_alias_lookup_ms
  }
}

export function setCacheHits(ctx: LogContext, l1: boolean, l2: boolean): void {
  ctx._cacheL1Hit = l1
  ctx._cacheL2Hit = l2
}

export function setLlmLatency(ctx: LogContext, ms: number): void {
  ctx._latencyLlmMs = ms
}

export function setCacheWriteLatency(ctx: LogContext, ms: number): void {
  ctx._latencyCacheWriteMs = ms
}

export function addBudgetUsed(ctx: LogContext, tokens: number): void {
  ctx._budgetUsed += tokens
}

export function recordTool(ctx: LogContext, call: {
  tool: string
  args_summary: string
  latency_ms: number
  result_size_bytes: number
  cache_hit?: boolean
}): void {
  const toolCall: ToolCall = {
    tool: call.tool,
    args_summary: call.args_summary.slice(0, 80),
    latency_ms: call.latency_ms,
    result_size_bytes: call.result_size_bytes,
    cache_hit: call.cache_hit ?? false,
  }
  ctx._toolsCalled.push(toolCall)

  if (ctx._firstToolMs === -1) {
    ctx._firstToolMs = Date.now() - ctx._startMs
  }
}

export function finishLog(ctx: LogContext, result: {
  result_length_chars: number
  context_tokens_in?: number
  early_cutoff?: boolean
  fallback_triggered?: boolean
  error?: string
  error_step?: string
}): void {
  const totalMs = Date.now() - ctx._startMs

  const entry: QueryLatencyLog = {
    request_id: ctx._requestId,
    timestamp: ctx._timestamp,
    ...(ctx._sessionId !== undefined && { session_id: ctx._sessionId }),

    raw_input: ctx._rawInput,
    query_class: ctx._queryClass,
    classified_by: ctx._classifiedBy,

    alias_hit: ctx._aliasHit,
    ...(ctx._aliasTerm !== undefined && { alias_term: ctx._aliasTerm }),
    ...(ctx._canonicalSlug !== undefined && { canonical_slug: ctx._canonicalSlug }),

    tools_called: ctx._toolsCalled,
    tools_count: ctx._toolsCalled.length,
    budget_used: ctx._budgetUsed,
    budget_limit: ctx._budgetLimit,

    cache_l1_hit: ctx._cacheL1Hit,
    cache_l2_hit: ctx._cacheL2Hit,

    latency_total_ms: totalMs,
    latency_classify_ms: ctx._latencyClassifyMs,
    latency_alias_lookup_ms: ctx._latencyAliasLookupMs,
    latency_first_tool_ms: ctx._firstToolMs >= 0 ? ctx._firstToolMs : 0,
    latency_llm_ms: ctx._latencyLlmMs,
    latency_cache_write_ms: ctx._latencyCacheWriteMs,

    context_tokens_in: result.context_tokens_in ?? 0,
    result_length_chars: result.result_length_chars,
    early_cutoff: result.early_cutoff ?? false,
    fallback_triggered: result.fallback_triggered ?? false,

    ...(result.error !== undefined && { error: result.error }),
    ...(result.error_step !== undefined && { error_step: result.error_step }),
  }

  const logPath = ctx._logPath
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // best-effort: never throw from logging
  }
}
