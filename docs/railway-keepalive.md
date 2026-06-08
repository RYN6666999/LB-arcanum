# Railway Keepalive 設置

Railway 服務在閒置後可能休眠，導致第一個請求延遲 +3–10 秒。
定期 ping `/health`（不需要 token）可以保活服務。

## 選項 A：Railway Cron Job（推薦）

在 Railway 專案設定中加入 cron job，每 8 分鐘觸發：

- **Command:** `curl -s https://gbrain-production-18fa.up.railway.app/health > /dev/null`
- **Schedule:** `*/8 * * * *`

Railway Dashboard → 你的服務 → Settings → Cron Jobs → Add Cron Job

## 選項 B：本機常駐腳本

```bash
bun scripts/keepalive.ts &
```

每 10 分鐘 ping 一次。環境變數：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `GBRAIN_BASE_URL` | `https://gbrain-production-18fa.up.railway.app` | 目標 URL |
| `GBRAIN_KEEPALIVE_INTERVAL_MS` | `600000` (10 分鐘) | ping 間隔（毫秒） |

log 寫入 `~/.gbrain/keepalive.log`（每行一條 JSON）：

```json
{"timestamp":"2026-06-08T10:00:00.000Z","status":200,"latency_ms":87,"warm":true}
{"timestamp":"2026-06-08T10:10:00.000Z","status":200,"latency_ms":3241,"warm":false,"warmed_up":true}
```

## 選項 C：launchd（macOS 開機自動啟動）

```bash
bun scripts/keepalive.ts --install
```

生成並載入 `~/Library/LaunchAgents/com.gbrain.keepalive.plist`，開機後自動執行。

**手動卸載：**

```bash
launchctl unload ~/Library/LaunchAgents/com.gbrain.keepalive.plist
rm ~/Library/LaunchAgents/com.gbrain.keepalive.plist
```

## 單次 ping（CI / 手動觸發）

```bash
bun scripts/keepalive-once.ts
# 輸出：{"status":200,"latency_ms":123,"warm":true}
```

exit code 0 = 成功，exit code 1 = 請求失敗。

## warm:false 的處理

`/health` 返回 `warm:false` 表示服務剛啟動、嵌入層尚未暖機。
keepalive 腳本會額外打一次 `GET /search?q=ping` 來觸發嵌入初始化，
並在 log 中記錄 `warmed_up:true`。

之後的真實搜尋請求延遲會恢復正常（通常 <200ms）。
