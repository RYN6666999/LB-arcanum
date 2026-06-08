#!/bin/bash
# Record latency baseline for A/B test control group
# Usage: ./scripts/latency-baseline.sh [base_url] [token]
# Output: baseline.json (p50/p95 + per-query latency)

set -euo pipefail

BASE_URL="${1:-https://gbrain-production-18fa.up.railway.app}"
TOKEN="${2:-}"
OUTPUT="${GBRAIN_BASELINE_OUTPUT:-baseline.json}"

QUERIES=("房多多" "gbrain" "認知分層" "SPIN" "定錨效應" "OKR" "第一性原理" "費曼技巧" "心理安全感" "複利思維")

results=()

for query in "${QUERIES[@]}"; do
  encoded=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$query")
  url="$BASE_URL/search?q=$encoded${TOKEN:+&token=$TOKEN}"

  start=$(date +%s%3N)
  http_status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  end=$(date +%s%3N)

  latency=$((end - start))
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  entry="{\"query\":\"$query\",\"latency_ms\":$latency,\"http_status\":$http_status,\"timestamp\":\"$ts\"}"
  results+=("$entry")
  echo "$entry" >&2
done

# Combine and compute stats
printf '%s\n' "${results[@]}" | jq -sc '
  . as $all |
  ($all | map(.latency_ms) | sort) as $sorted |
  def pct(arr; p): arr | if length == 0 then null else .[(length * p / 100 | floor) | if . >= length then length - 1 else . end] end;
  {
    baseline: $all,
    count: ($all | length),
    p50: pct($sorted; 50),
    p95: pct($sorted; 95),
    avg: (($all | map(.latency_ms) | add) / ($all | length) | round),
    min: ($sorted | first),
    max: ($sorted | last),
    recorded_at: (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
  }
' > "$OUTPUT"

echo "Baseline written to $OUTPUT" >&2
cat "$OUTPUT"
