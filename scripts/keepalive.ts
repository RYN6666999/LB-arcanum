#!/usr/bin/env bun
/**
 * gbrain Railway keepalive daemon
 *
 * Usage:
 *   bun scripts/keepalive.ts           # run daemon (pings every 10 min)
 *   bun scripts/keepalive.ts --install  # install macOS launchd agent
 *   bun scripts/keepalive.ts --once     # single ping and exit
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const BASE_URL = process.env.GBRAIN_BASE_URL ?? 'https://gbrain-production-18fa.up.railway.app';
const INTERVAL_MS = parseInt(process.env.GBRAIN_KEEPALIVE_INTERVAL_MS ?? '600000', 10);
const LOG_DIR = join(homedir(), '.gbrain');
const LOG_FILE = join(LOG_DIR, 'keepalive.log');

export interface KeepaliveLog {
  timestamp: string;
  status: number;
  latency_ms: number;
  warm: boolean | null;
  error?: string;
  warmed_up?: boolean;
}

export async function pingHealth(
  baseUrl: string = BASE_URL,
  logFile: string = LOG_FILE,
): Promise<KeepaliveLog> {
  const timestamp = new Date().toISOString();
  const start = Date.now();
  let status = 0;
  let warm: boolean | null = null;
  let error: string | undefined;
  let warmed_up: boolean | undefined;

  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
    status = res.status;

    if (res.ok) {
      try {
        const body = (await res.json()) as { warm?: boolean };
        warm = body.warm ?? null;
      } catch {
        warm = null;
      }

      const latency_ms = Date.now() - start;

      // If not warm, fire a cheap /search?q=ping to wake up the embedding layer
      if (warm === false) {
        try {
          await fetch(`${baseUrl}/search?q=ping`, { signal: AbortSignal.timeout(15000) });
          warmed_up = true;
        } catch {
          warmed_up = false;
        }
      }

      const entry: KeepaliveLog = {
        timestamp,
        status,
        latency_ms,
        warm,
        ...(warmed_up !== undefined && { warmed_up }),
      };
      appendLog(entry, logFile);
      return entry;
    }

    const latency_ms = Date.now() - start;
    const entry: KeepaliveLog = { timestamp, status, latency_ms, warm };
    appendLog(entry, logFile);
    return entry;
  } catch (err) {
    const latency_ms = Date.now() - start;
    error = err instanceof Error ? err.message : String(err);
    const entry: KeepaliveLog = { timestamp, status, latency_ms, warm, error };
    appendLog(entry, logFile);
    return entry;
  }
}

export function appendLog(entry: KeepaliveLog, logFile: string = LOG_FILE): void {
  try {
    mkdirSync(join(logFile, '..'), { recursive: true });
    appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[keepalive] failed to write log:', err);
  }
}

function printEntry(entry: KeepaliveLog): void {
  const warmStr = entry.warm === null ? 'null' : String(entry.warm);
  const extras: string[] = [];
  if (entry.warmed_up !== undefined) extras.push(`warmed_up:${entry.warmed_up}`);
  if (entry.error) extras.push(`error:${entry.error}`);
  const suffix = extras.length ? ` | ${extras.join(' ')}` : '';
  console.log(
    `[keepalive] ${entry.timestamp} status:${entry.status} latency:${entry.latency_ms}ms warm:${warmStr}${suffix}`,
  );
}

async function runOnce(): Promise<KeepaliveLog> {
  const entry = await pingHealth();
  printEntry(entry);
  return entry;
}

function installLaunchd(): void {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.gbrain.keepalive.plist');
  const scriptPath = new URL(import.meta.url).pathname;
  const intervalSeconds = Math.floor(INTERVAL_MS / 1000);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gbrain.keepalive</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>run</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/keepalive-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/keepalive-launchd.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GBRAIN_BASE_URL</key>
    <string>${BASE_URL}</string>
    <key>GBRAIN_KEEPALIVE_INTERVAL_MS</key>
    <string>${INTERVAL_MS}</string>
  </dict>
</dict>
</plist>
`;

  const laAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(laAgentsDir, { recursive: true });

  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
    } catch {
      /* ok — not loaded */
    }
  }

  writeFileSync(plistPath, plist, 'utf8');
  execSync(`launchctl load "${plistPath}"`);
  console.log(`[keepalive] installed launchd agent: ${plistPath}`);
  console.log(`[keepalive] will ping every ${intervalSeconds}s`);
  console.log(`[keepalive] logs: ${LOG_DIR}/keepalive-launchd.log`);
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--install')) {
  installLaunchd();
  process.exit(0);
}

if (args.includes('--once')) {
  const entry = await runOnce();
  console.log(JSON.stringify({ status: entry.status, latency_ms: entry.latency_ms, warm: entry.warm }));
  process.exit(entry.error ? 1 : 0);
}

// Daemon mode
console.log(`[keepalive] starting daemon — ${BASE_URL} every ${INTERVAL_MS / 1000}s`);
console.log(`[keepalive] log: ${LOG_FILE}`);

await runOnce();

const timer = setInterval(async () => {
  await runOnce();
}, INTERVAL_MS);

process.on('SIGINT', () => {
  console.log('\n[keepalive] shutting down');
  clearInterval(timer);
  process.exit(0);
});

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
