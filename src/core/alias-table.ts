import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

export interface AliasEntry {
  aliases: string[]       // trigger keywords (lowercase comparison)
  canonical_slug: string  // target page slug
  confirmed: boolean      // true = manually verified
  updated_at: string      // ISO-8601
}

const DEFAULT_FILE = `${homedir()}/.gbrain/alias-table.jsonl`

// In-memory index: lowercased alias → entry
const index = new Map<string, AliasEntry>()
let loaded = false

function buildIndex(entries: AliasEntry[]): void {
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      index.set(alias.toLowerCase(), entry)
    }
  }
}

export async function loadAliasTable(filePath?: string): Promise<void> {
  const path = filePath ?? DEFAULT_FILE
  index.clear()
  loaded = false

  if (!existsSync(path)) {
    loaded = true
    return
  }

  const text = await readFile(path, 'utf8')
  const lines = text.split('\n').filter(l => l.trim())
  const entries: AliasEntry[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AliasEntry)
    } catch {
      // skip malformed lines
    }
  }
  buildIndex(entries)
  loaded = true
}

export function lookupAlias(term: string): AliasEntry | undefined {
  return index.get(term.toLowerCase())
}

export async function appendAlias(entry: AliasEntry, filePath?: string): Promise<void> {
  const path = filePath ?? DEFAULT_FILE
  await mkdir(dirname(path), { recursive: true })
  const line = JSON.stringify(entry) + '\n'
  await appendFile(path, line, 'utf8')
  // update in-memory index
  for (const alias of entry.aliases) {
    index.set(alias.toLowerCase(), entry)
  }
}

export function getAllAliases(): AliasEntry[] {
  // deduplicate by canonical_slug (entries may be indexed under multiple aliases)
  const seen = new Map<string, AliasEntry>()
  for (const entry of index.values()) {
    seen.set(entry.canonical_slug, entry)
  }
  return Array.from(seen.values())
}

export function isLoaded(): boolean {
  return loaded
}
