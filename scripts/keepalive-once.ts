#!/usr/bin/env bun
/**
 * Single keepalive ping — exits after one request.
 *
 * Usage:
 *   bun scripts/keepalive-once.ts
 *   # outputs: { status: 200, latency_ms: 123, warm: true }
 */

import { pingHealth } from './keepalive.ts';
import { join } from 'path';
import { homedir } from 'os';

const LOG_FILE = join(homedir(), '.gbrain', 'keepalive.log');
const BASE_URL = process.env.GBRAIN_BASE_URL ?? 'https://gbrain-production-18fa.up.railway.app';

const entry = await pingHealth(BASE_URL, LOG_FILE);
console.log(JSON.stringify({ status: entry.status, latency_ms: entry.latency_ms, warm: entry.warm }));
process.exit(entry.error ? 1 : 0);
