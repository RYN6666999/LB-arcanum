import { Database } from 'bun:sqlite'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { DefinitionPayload } from './definition-extractor.ts'
import { getL1, setL1 } from './definition-cache.ts'

const DEFAULT_DB_PATH = join(homedir(), '.gbrain', 'definition-cache.db')
const DEFAULT_TTL_SECONDS = 24 * 60 * 60 // 24 hours
const KEY_PREFIX = 'gbrain:def:v1:'

let db: Database | null = null
let currentDbPath: string = DEFAULT_DB_PATH

function makeKey(slug: string): string {
  return `${KEY_PREFIX}${slug}`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function initL2(dbPath?: string): void {
  if (db) {
    db.close()
    db = null
  }
  currentDbPath = dbPath ?? DEFAULT_DB_PATH
  mkdirSync(dirname(currentDbPath), { recursive: true })
  db = new Database(currentDbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS definition_cache (
      cache_key TEXT PRIMARY KEY,
      payload   TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expires_at ON definition_cache(expires_at);
  `)
}

function ensureInit(): void {
  if (!db) initL2()
}

export function getL2(slug: string): DefinitionPayload | undefined {
  ensureInit()
  const key = makeKey(slug)
  const now = nowSeconds()
  const row = db!.query<{ payload: string; expires_at: number }, [string]>(
    'SELECT payload, expires_at FROM definition_cache WHERE cache_key = ?'
  ).get(key)

  if (!row) return undefined

  if (row.expires_at <= now) {
    db!.run('DELETE FROM definition_cache WHERE cache_key = ?', [key])
    return undefined
  }

  return JSON.parse(row.payload) as DefinitionPayload
}

export function setL2(slug: string, payload: DefinitionPayload, ttlSeconds?: number): void {
  ensureInit()
  const key = makeKey(slug)
  const expiresAt = nowSeconds() + (ttlSeconds ?? DEFAULT_TTL_SECONDS)
  db!.run(
    'INSERT OR REPLACE INTO definition_cache (cache_key, payload, expires_at) VALUES (?, ?, ?)',
    [key, JSON.stringify(payload), expiresAt]
  )
}

export function invalidateL2(slug: string): void {
  ensureInit()
  db!.run('DELETE FROM definition_cache WHERE cache_key = ?', [makeKey(slug)])
}

export function sweepL2(): number {
  ensureInit()
  const result = db!.run('DELETE FROM definition_cache WHERE expires_at <= ?', [nowSeconds()])
  return result.changes
}

export function _resetL2ForTest(): void {
  if (db) {
    db.close()
    db = null
  }
  try {
    unlinkSync(currentDbPath)
  } catch {
    // File may not exist; that's fine
  }
  db = null
}

// L1 miss → L2 lookup → L1 backfill
export function getDefinitionFromCache(
  slug: string,
  updatedAt: string,
): DefinitionPayload | undefined {
  const l2hit = getL2(slug)
  if (!l2hit) return undefined

  // Only backfill L1 if the cached entry's updatedAt matches
  if (l2hit.updated_at === updatedAt) {
    setL1(slug, updatedAt, { ...l2hit, cache_hit: true })
  }

  return { ...l2hit, cache_hit: true }
}
