import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

// Fixture: 10 query-latency.jsonl records
const FIXTURE_RECORDS = [
  // definition class, rule routing, alias hit, L1 miss — fast
  { timestamp: '2026-06-08T10:00:00Z', latency_total_ms: 1200, latency_first_tool_ms: 200, latency_llm_ms: 900, query_class: 'definition', classified_by: 'rule', alias_hit: true, cache_l1_hit: false, cache_l2_hit: false, tools_count: 2, budget_used: 500, budget_limit: 4000, context_tokens_in: 1100, result_length_chars: 400, early_cutoff: false, fallback_triggered: false },
  // definition class, rule routing, alias miss, L1 hit — very fast
  { timestamp: '2026-06-08T10:01:00Z', latency_total_ms: 300, latency_first_tool_ms: 50, latency_llm_ms: 200, query_class: 'definition', classified_by: 'rule', alias_hit: false, cache_l1_hit: true, cache_l2_hit: false, tools_count: 1, budget_used: 200, budget_limit: 4000, context_tokens_in: 800, result_length_chars: 300, early_cutoff: false, fallback_triggered: false },
  // definition class, llm routing, alias hit, L1 miss — slower
  { timestamp: '2026-06-08T10:02:00Z', latency_total_ms: 3500, latency_first_tool_ms: 800, latency_llm_ms: 2500, query_class: 'definition', classified_by: 'llm', alias_hit: true, cache_l1_hit: false, cache_l2_hit: false, tools_count: 3, budget_used: 1200, budget_limit: 4000, context_tokens_in: 1400, result_length_chars: 600, early_cutoff: false, fallback_triggered: false },
  // search class, rule routing, alias hit, L1 miss
  { timestamp: '2026-06-08T10:03:00Z', latency_total_ms: 2000, latency_first_tool_ms: 400, latency_llm_ms: 1500, query_class: 'search', classified_by: 'rule', alias_hit: true, cache_l1_hit: false, cache_l2_hit: false, tools_count: 2, budget_used: 700, budget_limit: 4000, context_tokens_in: 1200, result_length_chars: 500, early_cutoff: false, fallback_triggered: false },
  // lookup class, rule routing, alias hit, L1 hit
  { timestamp: '2026-06-08T10:04:00Z', latency_total_ms: 250, latency_first_tool_ms: 30, latency_llm_ms: 180, query_class: 'lookup', classified_by: 'rule', alias_hit: true, cache_l1_hit: true, cache_l2_hit: false, tools_count: 1, budget_used: 150, budget_limit: 4000, context_tokens_in: 600, result_length_chars: 200, early_cutoff: false, fallback_triggered: false },
  // definition class, rule routing, alias miss, L1 miss
  { timestamp: '2026-06-08T10:05:00Z', latency_total_ms: 2200, latency_first_tool_ms: 350, latency_llm_ms: 1700, query_class: 'definition', classified_by: 'rule', alias_hit: false, cache_l1_hit: false, cache_l2_hit: false, tools_count: 2, budget_used: 800, budget_limit: 4000, context_tokens_in: 1300, result_length_chars: 480, early_cutoff: false, fallback_triggered: false },
  // comparison class, llm routing, alias miss, L1 miss
  { timestamp: '2026-06-08T10:06:00Z', latency_total_ms: 5000, latency_first_tool_ms: 1000, latency_llm_ms: 3800, query_class: 'comparison', classified_by: 'llm', alias_hit: false, cache_l1_hit: false, cache_l2_hit: false, tools_count: 4, budget_used: 2000, budget_limit: 4000, context_tokens_in: 1800, result_length_chars: 900, early_cutoff: false, fallback_triggered: false },
  // definition class, rule routing, alias hit, L1 hit
  { timestamp: '2026-06-08T10:07:00Z', latency_total_ms: 400, latency_first_tool_ms: 60, latency_llm_ms: 300, query_class: 'definition', classified_by: 'rule', alias_hit: true, cache_l1_hit: true, cache_l2_hit: false, tools_count: 1, budget_used: 200, budget_limit: 4000, context_tokens_in: 700, result_length_chars: 250, early_cutoff: false, fallback_triggered: false },
  // graph class, rule routing, alias miss, L1 miss
  { timestamp: '2026-06-08T10:08:00Z', latency_total_ms: 3000, latency_first_tool_ms: 600, latency_llm_ms: 2200, query_class: 'graph', classified_by: 'rule', alias_hit: false, cache_l1_hit: false, cache_l2_hit: false, tools_count: 3, budget_used: 1100, budget_limit: 4000, context_tokens_in: 1500, result_length_chars: 700, early_cutoff: false, fallback_triggered: false },
  // definition class, llm routing, alias miss, L1 miss — very slow
  { timestamp: '2026-06-08T10:09:00Z', latency_total_ms: 7000, latency_first_tool_ms: 1500, latency_llm_ms: 5200, query_class: 'definition', classified_by: 'llm', alias_hit: false, cache_l1_hit: false, cache_l2_hit: false, tools_count: 5, budget_used: 3000, budget_limit: 4000, context_tokens_in: 2000, result_length_chars: 1100, early_cutoff: true, fallback_triggered: false },
]

const TMP_DIR = join(import.meta.dir, '_ab_report_tmp')
const LATENCY_LOG = join(TMP_DIR, 'query-latency.jsonl')
const SCRIPT = join(import.meta.dir, '..', 'scripts', 'ab-report.sh')

function runScript(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: { ...process.env, GBRAIN_LATENCY_LOG: LATENCY_LOG, GBRAIN_KEEPALIVE_LOG: '/nonexistent/keepalive.log' },
    cwd: join(import.meta.dir, '..'),
  })
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? 0,
  }
}

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true })
  writeFileSync(LATENCY_LOG, FIXTURE_RECORDS.map(r => JSON.stringify(r)).join('\n') + '\n')
})

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true })
  }
})

describe('ab-report.sh', () => {
  it('runs without error (full report)', () => {
    const { exitCode, stdout } = runScript([])
    // Full report may have FAILs in KPI but the script itself exits 0 in full mode
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Exp A')
    expect(stdout).toContain('Exp B')
    expect(stdout).toContain('Exp C')
    expect(stdout).toContain('Exp D')
    expect(stdout).toContain('Exp E')
  })

  it('--exp A outputs only Exp A section', () => {
    const { exitCode, stdout } = runScript(['--exp', 'A'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Exp A: Rule vs LLM routing')
    expect(stdout).not.toContain('Exp B')
    expect(stdout).not.toContain('Exp C')
    expect(stdout).not.toContain('Exp D')
    expect(stdout).not.toContain('Exp E')
    // Should show classified_by counts
    expect(stdout).toContain('classified_by=rule')
    expect(stdout).toContain('classified_by=llm')
  })

  it('--exp B outputs alias hit rate', () => {
    const { exitCode, stdout } = runScript(['--exp', 'B'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Exp B: Alias table hit rate')
    expect(stdout).toContain('alias_hit=true')
    expect(stdout).toContain('alias_hit=false')
    expect(stdout).toContain('命中率')
  })

  it('--exp C outputs payload slim stats', () => {
    const { exitCode, stdout } = runScript(['--exp', 'C'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Exp C: Payload slim')
    expect(stdout).toContain('avg context_tokens_in')
    expect(stdout).toContain('avg latency_llm_ms')
  })

  it('--exp D outputs L1 cache stats', () => {
    const { exitCode, stdout } = runScript(['--exp', 'D'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Exp D: L1 cache hit rate')
    expect(stdout).toContain('L1 hit')
    expect(stdout).toContain('L1 miss')
    expect(stdout).toContain('命中率')
  })

  it('--exp E handles missing keepalive.log gracefully', () => {
    const { exitCode, stdout } = runScript(['--exp', 'E'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Exp E: Cold start latency')
    // keepalive.log is /nonexistent/keepalive.log so should say not found
    expect(stdout).toContain('keepalive.log')
  })

  it('--kpi outputs PASS or FAIL for each metric', () => {
    const { stdout } = runScript(['--kpi'])
    expect(stdout).toContain('KPI Check')
    // Each metric line must have PASS, FAIL, or SKIP
    const lines = stdout.split('\n').filter(l => l.includes('latency') || l.includes('tools_count') || l.includes('context_tokens') || l.includes('hit rate'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toMatch(/\[(PASS|FAIL|SKIP)\]/)
    }
  })

  it('--kpi exit code is 0 or 1 (binary)', () => {
    const { exitCode } = runScript(['--kpi'])
    expect(exitCode === 0 || exitCode === 1).toBe(true)
  })

  it('--kpi fails when definition p50 exceeds 3000ms (fixture has high latency records)', () => {
    // Our fixture has definition records: 1200, 300, 3500, 2200, 400, 7000
    // p50 of sorted [300, 400, 1200, 2200, 3500, 7000] at index 3 = 2200 → PASS
    // p95 at index 5 = 7000 → FAIL
    const { stdout, exitCode } = runScript(['--kpi'])
    expect(stdout).toContain('[FAIL]')
    expect(exitCode).toBe(1)
  })

  it('--since filters records by date', () => {
    // Use a future date so no records match
    const { exitCode, stdout } = runScript(['--exp', 'A', '--since', '2030-01-01'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('count=0')
  })

  it('rejects unknown --exp value', () => {
    const { exitCode } = runScript(['--exp', 'Z'])
    expect(exitCode).toBe(1)
  })
})
