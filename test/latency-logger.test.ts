import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  startLog,
  recordTool,
  finishLog,
  addBudgetUsed,
  setCacheHits,
  setLlmLatency,
  setCacheWriteLatency,
  setAliasResult,
  type QueryLatencyLog,
} from '../src/core/latency-logger'

const TMP_LOG = join(tmpdir(), `gbrain-test-latency-${Date.now()}.jsonl`)
const TMP_DIR_LOG = join(tmpdir(), `gbrain-test-latency-nonexistent-${Date.now()}`, 'nested', 'query-latency.jsonl')

function readLastLine(path: string): QueryLatencyLog {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

function cleanup(...paths: string[]) {
  for (const p of paths) {
    try { unlinkSync(p) } catch {}
  }
}

describe('latency-logger', () => {
  afterEach(() => {
    cleanup(TMP_LOG, TMP_DIR_LOG)
    // clean up nested dir if created
    try { rmdirSync(join(tmpdir(), `gbrain-test-latency-nonexistent-${Date.now().toString().slice(0, -3)}0`, 'nested'), { recursive: true } as any) } catch {}
  })

  test('startLog → finishLog writes valid JSONL', () => {
    const ctx = startLog({
      raw_input: 'What is React?',
      query_class: 'definition',
      classified_by: 'rule',
      budget_limit: 50,
      logPath: TMP_LOG,
    })

    finishLog(ctx, {
      result_length_chars: 300,
      context_tokens_in: 100,
    })

    expect(existsSync(TMP_LOG)).toBe(true)
    const entry = readLastLine(TMP_LOG)

    expect(entry.request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.raw_input).toBe('What is React?')
    expect(entry.query_class).toBe('definition')
    expect(entry.classified_by).toBe('rule')
    expect(entry.budget_limit).toBe(50)
    expect(entry.result_length_chars).toBe(300)
    expect(entry.context_tokens_in).toBe(100)
    expect(entry.early_cutoff).toBe(false)
    expect(entry.fallback_triggered).toBe(false)
    expect(entry.tools_called).toEqual([])
    expect(entry.tools_count).toBe(0)
    expect(entry.latency_total_ms).toBeGreaterThanOrEqual(0)
  })

  test('recordTool accumulates correctly', () => {
    const ctx = startLog({
      raw_input: 'lookup alice',
      query_class: 'lookup',
      classified_by: 'rule',
      budget_limit: 30,
      logPath: TMP_LOG,
    })

    recordTool(ctx, { tool: 'get_page', args_summary: 'people/alice', latency_ms: 12, result_size_bytes: 512 })
    recordTool(ctx, { tool: 'get_backlinks', args_summary: 'people/alice', latency_ms: 8, result_size_bytes: 256, cache_hit: true })

    finishLog(ctx, { result_length_chars: 200 })

    const entry = readLastLine(TMP_LOG)
    expect(entry.tools_count).toBe(2)
    expect(entry.tools_called).toHaveLength(2)
    expect(entry.tools_called[0].tool).toBe('get_page')
    expect(entry.tools_called[0].latency_ms).toBe(12)
    expect(entry.tools_called[0].cache_hit).toBe(false)
    expect(entry.tools_called[1].tool).toBe('get_backlinks')
    expect(entry.tools_called[1].cache_hit).toBe(true)
  })

  test('tools_count and budget_used are calculated correctly', () => {
    const ctx = startLog({
      raw_input: 'compare X and Y',
      query_class: 'comparison',
      classified_by: 'llm',
      budget_limit: 100,
      logPath: TMP_LOG,
    })

    recordTool(ctx, { tool: 'search', args_summary: 'X', latency_ms: 20, result_size_bytes: 1000 })
    recordTool(ctx, { tool: 'search', args_summary: 'Y', latency_ms: 25, result_size_bytes: 1200 })
    recordTool(ctx, { tool: 'get_page', args_summary: 'X', latency_ms: 10, result_size_bytes: 800 })

    addBudgetUsed(ctx, 15)
    addBudgetUsed(ctx, 20)

    finishLog(ctx, { result_length_chars: 500 })

    const entry = readLastLine(TMP_LOG)
    expect(entry.tools_count).toBe(3)
    expect(entry.budget_used).toBe(35)
    expect(entry.budget_limit).toBe(100)
  })

  test('auto-creates directory if it does not exist', () => {
    const ctx = startLog({
      raw_input: 'test dir creation',
      query_class: 'search',
      classified_by: 'rule',
      budget_limit: 10,
      logPath: TMP_DIR_LOG,
    })

    finishLog(ctx, { result_length_chars: 50 })

    expect(existsSync(TMP_DIR_LOG)).toBe(true)
    const entry = readLastLine(TMP_DIR_LOG)
    expect(entry.raw_input).toBe('test dir creation')

    // cleanup nested dir
    try { unlinkSync(TMP_DIR_LOG) } catch {}
    try { rmdirSync(join(TMP_DIR_LOG, '..'), { recursive: true } as any) } catch {}
    try { rmdirSync(join(TMP_DIR_LOG, '..', '..'), { recursive: true } as any) } catch {}
  })

  test('error fields are recorded correctly', () => {
    const ctx = startLog({
      raw_input: 'broken query',
      query_class: 'research',
      classified_by: 'rule',
      budget_limit: 20,
      logPath: TMP_LOG,
    })

    finishLog(ctx, {
      result_length_chars: 0,
      error: 'DB connection failed',
      error_step: 'tool_call',
    })

    const entry = readLastLine(TMP_LOG)
    expect(entry.error).toBe('DB connection failed')
    expect(entry.error_step).toBe('tool_call')
  })

  test('raw_input is truncated to 200 chars', () => {
    const longInput = 'x'.repeat(300)
    const ctx = startLog({
      raw_input: longInput,
      query_class: 'search',
      classified_by: 'rule',
      budget_limit: 10,
      logPath: TMP_LOG,
    })
    finishLog(ctx, { result_length_chars: 0 })

    const entry = readLastLine(TMP_LOG)
    expect(entry.raw_input.length).toBe(200)
  })

  test('args_summary is truncated to 80 chars', () => {
    const ctx = startLog({
      raw_input: 'test',
      query_class: 'lookup',
      classified_by: 'rule',
      budget_limit: 10,
      logPath: TMP_LOG,
    })
    recordTool(ctx, {
      tool: 'get_page',
      args_summary: 'a'.repeat(100),
      latency_ms: 5,
      result_size_bytes: 100,
    })
    finishLog(ctx, { result_length_chars: 50 })

    const entry = readLastLine(TMP_LOG)
    expect(entry.tools_called[0].args_summary.length).toBe(80)
  })

  test('session_id is optional and included when provided', () => {
    const ctx = startLog({
      raw_input: 'test',
      query_class: 'lookup',
      classified_by: 'rule',
      budget_limit: 10,
      session_id: 'sess-abc123',
      logPath: TMP_LOG,
    })
    finishLog(ctx, { result_length_chars: 50 })

    const entry = readLastLine(TMP_LOG)
    expect(entry.session_id).toBe('sess-abc123')
  })

  test('cache hits and latency fields propagate', () => {
    const ctx = startLog({
      raw_input: 'cached query',
      query_class: 'lookup',
      classified_by: 'rule',
      budget_limit: 10,
      logPath: TMP_LOG,
      latency_classify_ms: 5,
      latency_alias_lookup_ms: 2,
    })
    setCacheHits(ctx, true, false)
    setLlmLatency(ctx, 150)
    setCacheWriteLatency(ctx, 3)

    finishLog(ctx, { result_length_chars: 100 })

    const entry = readLastLine(TMP_LOG)
    expect(entry.cache_l1_hit).toBe(true)
    expect(entry.cache_l2_hit).toBe(false)
    expect(entry.latency_classify_ms).toBe(5)
    expect(entry.latency_alias_lookup_ms).toBe(2)
    expect(entry.latency_llm_ms).toBe(150)
    expect(entry.latency_cache_write_ms).toBe(3)
  })

  test('setAliasResult updates alias fields', () => {
    const ctx = startLog({
      raw_input: 'react hooks',
      query_class: 'definition',
      classified_by: 'rule',
      budget_limit: 10,
      logPath: TMP_LOG,
    })
    setAliasResult(ctx, {
      alias_hit: true,
      alias_term: 'react hooks',
      canonical_slug: 'tech/react-hooks',
      latency_alias_lookup_ms: 4,
    })
    finishLog(ctx, { result_length_chars: 200 })

    const entry = readLastLine(TMP_LOG)
    expect(entry.alias_hit).toBe(true)
    expect(entry.alias_term).toBe('react hooks')
    expect(entry.canonical_slug).toBe('tech/react-hooks')
    expect(entry.latency_alias_lookup_ms).toBe(4)
  })

  test('multiple finishLog calls append multiple lines', () => {
    for (let i = 0; i < 3; i++) {
      const ctx = startLog({
        raw_input: `query ${i}`,
        query_class: 'search',
        classified_by: 'rule',
        budget_limit: 10,
        logPath: TMP_LOG,
      })
      finishLog(ctx, { result_length_chars: i * 100 })
    }

    const lines = readFileSync(TMP_LOG, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    const last = JSON.parse(lines[2]) as QueryLatencyLog
    expect(last.raw_input).toBe('query 2')
    expect(last.result_length_chars).toBe(200)
  })
})
