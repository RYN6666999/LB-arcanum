import type { DefinitionPayload } from './definition-extractor.ts'

const TTL_MS = 5 * 60 * 1000
const MAX_SIZE = 500

interface CacheEntry {
  payload: DefinitionPayload
  expiresAt: number
}

// Map preserves insertion order; delete-then-reinsert promotes to MRU
const cache = new Map<string, CacheEntry>()

let hits = 0
let misses = 0
let evictions = 0

function makeKey(slug: string, updatedAt: string): string {
  return `def:${slug}:${updatedAt}`
}

export function getL1(slug: string, updatedAt: string): DefinitionPayload | undefined {
  const key = makeKey(slug, updatedAt)
  const entry = cache.get(key)
  if (!entry) {
    misses++
    return undefined
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    misses++
    return undefined
  }
  // Promote to MRU by reinserting
  cache.delete(key)
  cache.set(key, entry)
  hits++
  return entry.payload
}

export function setL1(slug: string, updatedAt: string, payload: DefinitionPayload): void {
  const key = makeKey(slug, updatedAt)
  // If key already exists, delete first so reinsertion goes to end (MRU)
  if (cache.has(key)) {
    cache.delete(key)
  } else if (cache.size >= MAX_SIZE) {
    // Evict LRU: first entry in Map
    const lruKey = cache.keys().next().value
    if (lruKey !== undefined) {
      cache.delete(lruKey)
      evictions++
    }
  }
  cache.set(key, { payload, expiresAt: Date.now() + TTL_MS })
}

export function invalidateL1(slug: string): void {
  const prefix = `def:${slug}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

export function getL1Stats(): { size: number; hits: number; misses: number; evictions: number } {
  return { size: cache.size, hits, misses, evictions }
}

// Exposed for testing only
export function _resetL1(): void {
  cache.clear()
  hits = 0
  misses = 0
  evictions = 0
}
