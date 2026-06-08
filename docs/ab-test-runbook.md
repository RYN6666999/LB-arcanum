# A/B Test Runbook

How to run latency experiments and verify KPI targets for gbrain query performance Phase 3.

## KPI Targets

| Metric | Target |
|--------|--------|
| P50 definition latency | ≤ 3000ms |
| P95 definition latency | ≤ 6000ms |
| Avg tools_count (definition) | ≤ 2 |
| Avg context_tokens_in | ≤ 1500 tokens |
| Alias hit rate | ≥ 60% |
| L1 cache hit rate | ≥ 40% |

## Prerequisites

- `jq` installed (`brew install jq`)
- `gbrain` running with latency logging enabled (`~/.gbrain/query-latency.jsonl`)
- Scripts are executable: `chmod +x scripts/ab-report.sh scripts/latency-baseline.sh`

## Step 1: Record Baseline

Before enabling any optimization, capture the control group latency:

```bash
./scripts/latency-baseline.sh https://your-gbrain-url your-token
```

This runs 10 definition queries and writes `baseline.json` with p50/p95/avg. Keep this file as the "before" reference.

## Step 2: Enable Features

Turn on the optimization under test. Each experiment corresponds to a flag or config:

| Experiment | Feature | How to enable |
|------------|---------|---------------|
| A | Rule-based routing | `GBRAIN_ROUTING=rule` env var |
| B | Alias table | `gbrain init-alias-table` (see `scripts/init-alias-table.ts`) |
| C | Payload slim | Reduce `MAX_CONTEXT_TOKENS` in config |
| D | L1 cache | `GBRAIN_L1_CACHE=1` env var |
| E | Keepalive warm | Set keepalive interval in deployment config |

## Step 3: Run Queries

Generate at least 20 queries to get statistically meaningful data. The latency logger writes to `~/.gbrain/query-latency.jsonl` automatically on each query.

You can also replay a saved query set:

```bash
# Example: replay 5 definition queries
for q in "房多多" "gbrain是什麼" "認知分層" "SPIN技巧" "定錨效應"; do
  curl -s "https://your-gbrain-url/search?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$q'))")&token=your-token" > /dev/null
done
```

## Step 4: Run the Report

View results per experiment:

```bash
# Full report
./scripts/ab-report.sh

# Single experiment
./scripts/ab-report.sh --exp A
./scripts/ab-report.sh --exp B
./scripts/ab-report.sh --exp C
./scripts/ab-report.sh --exp D
./scripts/ab-report.sh --exp E

# Filter by date (ISO-8601 prefix match)
./scripts/ab-report.sh --since 2026-06-01

# KPI check (exits 0 if all pass, 1 if any fail)
./scripts/ab-report.sh --kpi
```

## Step 5: Verify KPI

```bash
./scripts/ab-report.sh --kpi
```

Expected output when all targets are met:

```
=== KPI Check ===
[PASS] P50 definition latency: 1800ms (目標 ≤ 3000ms)
[PASS] P95 definition latency: 4200ms (目標 ≤ 6000ms)
[PASS] Avg tools_count (definition): 2 (目標 ≤ 2)
[PASS] Avg context_tokens_in: 1200 (目標 ≤ 1500)
[PASS] Alias hit rate: 72% (目標 ≥ 60%)
[PASS] L1 cache hit rate: 55% (目標 ≥ 40%)
```

Exit code is `0` on all PASS, `1` if any FAIL. Suitable for CI:

```bash
./scripts/ab-report.sh --kpi || { echo "KPI not met"; exit 1; }
```

## Log Format Reference

`~/.gbrain/query-latency.jsonl` — one JSON object per line:

```json
{
  "timestamp": "2026-06-08T10:00:00Z",
  "latency_total_ms": 2100,
  "latency_first_tool_ms": 300,
  "latency_llm_ms": 1800,
  "query_class": "definition",
  "classified_by": "rule",
  "alias_hit": true,
  "cache_l1_hit": false,
  "cache_l2_hit": false,
  "tools_count": 2,
  "budget_used": 800,
  "budget_limit": 4000,
  "context_tokens_in": 1100,
  "result_length_chars": 450,
  "early_cutoff": false,
  "fallback_triggered": false
}
```

`~/.gbrain/keepalive.log` — one JSON object per line (for Exp E):

```json
{"warm": true, "latency_ms": 120, "timestamp": "2026-06-08T10:00:00Z"}
```

## Comparing Before / After

Exp C (payload slim) requires a manual before value. Record it from `baseline.json`:

```bash
cat baseline.json | jq '.avg'
```

Then compare with the current `avg context_tokens_in` from `--exp C` output.

## Troubleshooting

**No data in report:** Check that `~/.gbrain/query-latency.jsonl` exists and has entries matching the `--since` filter if provided.

**`[SKIP]`in KPI output:** The metric has no data. Run more queries of the relevant `query_class`.

**Exp E shows N/A:** Keepalive logging is not enabled or `~/.gbrain/keepalive.log` is absent.
