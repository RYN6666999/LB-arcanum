#!/bin/bash
# A/B Test Dashboard for gbrain query latency experiments
# Usage:
#   ./scripts/ab-report.sh                    # Full report (all experiments)
#   ./scripts/ab-report.sh --exp A            # Only Exp A
#   ./scripts/ab-report.sh --kpi              # KPI check
#   ./scripts/ab-report.sh --since 2026-06-01 # Filter by date

set -euo pipefail

LATENCY_LOG="${GBRAIN_LATENCY_LOG:-$HOME/.gbrain/query-latency.jsonl}"
KEEPALIVE_LOG="${GBRAIN_KEEPALIVE_LOG:-$HOME/.gbrain/keepalive.log}"

EXP=""
KPI_MODE=false
SINCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --exp) EXP="$2"; shift 2 ;;
    --kpi) KPI_MODE=true; shift ;;
    --since) SINCE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Build jq filter for date range
since_filter() {
  if [[ -n "$SINCE" ]]; then
    echo "select(.timestamp >= \"$SINCE\")"
  else
    echo "."
  fi
}

# Read log entries into a JSON array, applying date filter
read_log() {
  local log_file="$1"
  if [[ ! -f "$log_file" ]]; then
    echo "[]"
    return
  fi
  local sf
  sf=$(since_filter)
  jq -sc "[.[] | $sf]" "$log_file" 2>/dev/null || echo "[]"
}

exp_a() {
  local data
  data=$(read_log "$LATENCY_LOG")

  echo "=== Exp A: Rule vs LLM routing ==="

  echo "$data" | jq -r '
    . as $d |
    ($d | map(select(.classified_by == "rule"))) as $rule |
    ($d | map(select(.classified_by == "llm"))) as $llm |

    def pct(arr; p): arr | sort | if length == 0 then null else .[(length * p / 100 | floor) | if . >= length then length - 1 else . end] end;
    def fmt(v): if v == null then "N/A" else "\(v)ms" end;

    (pct($rule | map(.latency_total_ms); 50)) as $rp50 |
    (pct($rule | map(.latency_total_ms); 95)) as $rp95 |
    (pct($llm  | map(.latency_total_ms); 50)) as $lp50 |
    (pct($llm  | map(.latency_total_ms); 95)) as $lp95 |

    "classified_by=rule:  count=\($rule | length)  p50=\(fmt($rp50))  p95=\(fmt($rp95))",
    "classified_by=llm:   count=\($llm | length)  p50=\(fmt($lp50))  p95=\(fmt($lp95))",
    (
      if $rp50 != null and $lp50 != null and $lp50 > 0 then
        "差異：rule p50 比 llm 低 \((($lp50 - $rp50) / $lp50 * 100 | round))%"
      else
        "差異：（資料不足）"
      end
    )
  '
  echo ""
}

exp_b() {
  local data
  data=$(read_log "$LATENCY_LOG")

  echo "=== Exp B: Alias table hit rate ==="

  echo "$data" | jq -r '
    . as $d |
    ($d | map(select(.alias_hit == true))) as $hit |
    ($d | map(select(.alias_hit == false or .alias_hit == null))) as $miss |
    ($d | length) as $total |

    def avg(arr; field): if (arr | length) == 0 then null else (arr | map(.[field] // 0) | add) / length | round end;
    def fmt(v): if v == null then "N/A" else "\(v)ms" end;

    "alias_hit=true:  count=\($hit | length)  avg latency_first_tool_ms=\(fmt(avg($hit; "latency_first_tool_ms")))",
    "alias_hit=false: count=\($miss | length)  avg latency_first_tool_ms=\(fmt(avg($miss; "latency_first_tool_ms")))",
    (
      if $total > 0 then
        "alias 命中率：\(($hit | length) * 100 / $total | round)%"
      else
        "alias 命中率：（無資料）"
      end
    )
  '
  echo ""
}

exp_c() {
  local data
  data=$(read_log "$LATENCY_LOG")

  echo "=== Exp C: Payload slim ==="

  echo "$data" | jq -r '
    . as $d |
    if ($d | length) == 0 then
      "（無資料）"
    else
      (($d | map(.context_tokens_in // 0) | add) / ($d | length) | round) as $avg_tokens |
      (($d | map(.latency_llm_ms // 0) | add) / ($d | length) | round) as $avg_llm |
      "avg context_tokens_in: \($avg_tokens) tokens",
      "avg latency_llm_ms: \($avg_llm)ms",
      "（基準比較需手動填入 before 數值）"
    end
  '
  echo ""
}

exp_d() {
  local data
  data=$(read_log "$LATENCY_LOG")

  echo "=== Exp D: L1 cache hit rate ==="

  echo "$data" | jq -r '
    . as $d |
    ($d | map(select(.cache_l1_hit == true))) as $hit |
    ($d | map(select(.cache_l1_hit == false or .cache_l1_hit == null))) as $miss |
    ($d | length) as $total |

    def avg(arr; field): if (arr | length) == 0 then null else (arr | map(.[field] // 0) | add) / length | round end;
    def fmt(v): if v == null then "N/A" else "\(v)ms" end;

    "L1 hit:  count=\($hit | length)  avg latency_total_ms=\(fmt(avg($hit; "latency_total_ms")))",
    "L1 miss: count=\($miss | length)  avg latency_total_ms=\(fmt(avg($miss; "latency_total_ms")))",
    (
      if $total > 0 then
        "命中率：\(($hit | length) * 100 / $total | round)%"
      else
        "命中率：（無資料）"
      end
    )
  '
  echo ""
}

exp_e() {
  echo "=== Exp E: Cold start latency ==="

  if [[ ! -f "$KEEPALIVE_LOG" ]]; then
    echo "（keepalive.log 不存在：$KEEPALIVE_LOG）"
    echo ""
    return
  fi

  # keepalive.log format: JSON lines with .warm (bool) and .latency_ms (int)
  jq -sc '.' "$KEEPALIVE_LOG" 2>/dev/null | jq -r '
    . as $entries |
    ($entries | map(select(.warm == true))) as $warm |
    ($entries | map(select(.warm == false))) as $cold |

    def avg(arr): if (arr | length) == 0 then null else (arr | map(.latency_ms) | add) / length | round end;

    "warm=true:  avg latency_ms=\(if ($warm | length) == 0 then "N/A" else "\(avg($warm))ms" end)",
    "warm=false: avg latency_ms=\(if ($cold | length) == 0 then "N/A" else "\(avg($cold))ms" end)",
    (
      if (avg($warm)) != null and (avg($cold)) != null and (avg($warm)) > 0 then
        "冷/熱比：\((avg($cold) / avg($warm) * 10 | round) / 10)x"
      else
        "冷/熱比：（資料不足）"
      end
    )
  ' || echo "（keepalive.log 解析失敗）"
  echo ""
}

kpi_check() {
  local data
  data=$(read_log "$LATENCY_LOG")

  echo "=== KPI Check ==="

  # Note: "label" is a reserved word in jq, so we use "lbl" as the parameter name.
  local jq_filter
  jq_filter='
    . as $d |
    ($d | map(select(.query_class == "definition"))) as $def |

    def pct(arr; p): arr | sort | if length == 0 then null else .[(length * p / 100 | floor) | if . >= length then length - 1 else . end] end;
    def avg(arr; field): if (arr | length) == 0 then null else (arr | map(.[field] // 0) | add) / length | round end;

    (pct($def | map(.latency_total_ms); 50)) as $p50_def |
    (pct($def | map(.latency_total_ms); 95)) as $p95_def |
    (avg($def; "tools_count")) as $avg_tools |
    (avg($d; "context_tokens_in")) as $avg_tokens |
    (($d | map(select(.alias_hit == true)) | length) * 100 / (if ($d | length) == 0 then 1 else ($d | length) end) | round) as $alias_pct |
    (($d | map(select(.cache_l1_hit == true)) | length) * 100 / (if ($d | length) == 0 then 1 else ($d | length) end) | round) as $l1_pct |

    def kcheck(lbl; val; target; cmp; unit):
      if val == null then
        "[SKIP] \(lbl): N/A (無資料)"
      elif cmp == "lte" then
        if val <= target then "[PASS] \(lbl): \(val)\(unit) (目標 ≤ \(target)\(unit))"
        else "[FAIL] \(lbl): \(val)\(unit) (目標 ≤ \(target)\(unit))"
        end
      elif cmp == "gte" then
        if val >= target then "[PASS] \(lbl): \(val)\(unit) (目標 ≥ \(target)\(unit))"
        else "[FAIL] \(lbl): \(val)\(unit) (目標 ≥ \(target)\(unit))"
        end
      else "[SKIP] \(lbl): \(val)\(unit)"
      end;

    kcheck("P50 definition latency"; $p50_def; 3000; "lte"; "ms"),
    kcheck("P95 definition latency"; $p95_def; 6000; "lte"; "ms"),
    kcheck("Avg tools_count (definition)"; $avg_tools; 2; "lte"; ""),
    kcheck("Avg context_tokens_in"; $avg_tokens; 1500; "lte"; ""),
    kcheck("Alias hit rate"; $alias_pct; 60; "gte"; "%"),
    kcheck("L1 cache hit rate"; $l1_pct; 40; "gte"; "%")
  '

  echo "$data" | jq -r "$jq_filter"

  echo ""

  # Exit 1 if any FAIL
  local fail_count
  fail_count=$(echo "$data" | jq '
    . as $d |
    ($d | map(select(.query_class == "definition"))) as $def |
    def pct(arr; p): arr | sort | if length == 0 then null else .[(length * p / 100 | floor) | if . >= length then length - 1 else . end] end;
    def avg(arr; field): if (arr | length) == 0 then null else (arr | map(.[field] // 0) | add) / length | round end;
    (pct($def | map(.latency_total_ms); 50)) as $p50_def |
    (pct($def | map(.latency_total_ms); 95)) as $p95_def |
    (avg($def; "tools_count")) as $avg_tools |
    (avg($d; "context_tokens_in")) as $avg_tokens |
    (($d | map(select(.alias_hit == true)) | length) * 100 / (if ($d | length) == 0 then 1 else ($d | length) end) | round) as $alias_pct |
    (($d | map(select(.cache_l1_hit == true)) | length) * 100 / (if ($d | length) == 0 then 1 else ($d | length) end) | round) as $l1_pct |
    [
      (if $p50_def != null and $p50_def > 3000 then 1 else 0 end),
      (if $p95_def != null and $p95_def > 6000 then 1 else 0 end),
      (if $avg_tools != null and $avg_tools > 2 then 1 else 0 end),
      (if $avg_tokens != null and $avg_tokens > 1500 then 1 else 0 end),
      (if $alias_pct < 60 then 1 else 0 end),
      (if $l1_pct < 40 then 1 else 0 end)
    ] | add
  ')

  if [[ "$fail_count" -gt 0 ]]; then
    return 1
  fi
  return 0
}

# Main dispatch
if $KPI_MODE; then
  kpi_check
  exit $?
fi

case "$EXP" in
  A) exp_a ;;
  B) exp_b ;;
  C) exp_c ;;
  D) exp_d ;;
  E) exp_e ;;
  "")
    exp_a
    exp_b
    exp_c
    exp_d
    exp_e
    ;;
  *) echo "Unknown experiment: $EXP (valid: A B C D E)" >&2; exit 1 ;;
esac
