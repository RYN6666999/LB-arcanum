#!/bin/bash
# 用法：./scripts/latency-report.sh [slow|alias-miss|summary]
LOGFILE="$HOME/.gbrain/query-latency.jsonl"

if [ ! -f "$LOGFILE" ]; then
  echo "No log file found at $LOGFILE" >&2
  exit 1
fi

case "${1:-summary}" in
  slow)
    # 慢查詢 > 3s
    cat "$LOGFILE" | jq 'select(.latency_total_ms > 3000)' | tail -20
    ;;
  alias-miss)
    # alias 未命中的 definition 查詢
    cat "$LOGFILE" | jq 'select(.alias_hit == false and .query_class == "definition") | {timestamp, raw_input, latency_total_ms}'
    ;;
  summary)
    # P50 / P95 / 總數
    cat "$LOGFILE" | jq -s 'map(.latency_total_ms) | sort | {
      count: length,
      p50: .[length * 0.5 | floor],
      p95: .[length * 0.95 | floor],
      p99: .[length * 0.99 | floor]
    }'
    ;;
  *)
    echo "Usage: $0 [slow|alias-miss|summary]" >&2
    exit 1
    ;;
esac
