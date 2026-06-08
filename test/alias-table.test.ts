import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadAliasTable,
  lookupAlias,
  appendAlias,
  getAllAliases,
  isLoaded,
  type AliasEntry,
} from '../src/core/alias-table'

let tmpDir: string
let tmpFile: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'alias-table-test-'))
  tmpFile = join(tmpDir, 'alias-table.jsonl')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AliasEntry> = {}): AliasEntry {
  return {
    aliases: ['foo', 'bar'],
    canonical_slug: 'wiki/foo',
    confirmed: false,
    updated_at: '2026-06-08',
    ...overrides,
  }
}

async function writeLines(entries: AliasEntry[]): Promise<void> {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(tmpFile, content, 'utf8')
}

// ── tests ────────────────────────────────────────────────────────────────────

test('loadAliasTable: loads entries from JSONL', async () => {
  const entry = makeEntry({ aliases: ['apple', 'APPLE'], canonical_slug: 'wiki/apple' })
  await writeLines([entry])

  await loadAliasTable(tmpFile)
  expect(isLoaded()).toBe(true)
  expect(getAllAliases()).toHaveLength(1)
})

test('lookupAlias: exact match', async () => {
  const entry = makeEntry({ aliases: ['apple'], canonical_slug: 'wiki/apple' })
  await writeLines([entry])
  await loadAliasTable(tmpFile)

  const result = lookupAlias('apple')
  expect(result).toBeDefined()
  expect(result?.canonical_slug).toBe('wiki/apple')
})

test('lookupAlias: case-insensitive match', async () => {
  const entry = makeEntry({ aliases: ['Apple'], canonical_slug: 'wiki/apple' })
  await writeLines([entry])
  await loadAliasTable(tmpFile)

  expect(lookupAlias('APPLE')?.canonical_slug).toBe('wiki/apple')
  expect(lookupAlias('apple')?.canonical_slug).toBe('wiki/apple')
  expect(lookupAlias('aPpLe')?.canonical_slug).toBe('wiki/apple')
})

test('lookupAlias: miss returns undefined', async () => {
  const entry = makeEntry({ aliases: ['apple'] })
  await writeLines([entry])
  await loadAliasTable(tmpFile)

  expect(lookupAlias('banana')).toBeUndefined()
})

test('appendAlias: writes to JSONL and updates memory', async () => {
  // start with empty file (no pre-existing file)
  await loadAliasTable(tmpFile)

  const entry = makeEntry({ aliases: ['pear'], canonical_slug: 'wiki/pear' })
  await appendAlias(entry, tmpFile)

  // in-memory lookup works immediately
  expect(lookupAlias('pear')?.canonical_slug).toBe('wiki/pear')

  // file was written
  const written = await readFile(tmpFile, 'utf8')
  const parsed = JSON.parse(written.trim()) as AliasEntry
  expect(parsed.canonical_slug).toBe('wiki/pear')
  expect(parsed.aliases).toContain('pear')
})

test('appendAlias: multiple appends accumulate', async () => {
  await loadAliasTable(tmpFile)

  await appendAlias(makeEntry({ aliases: ['a'], canonical_slug: 'wiki/a' }), tmpFile)
  await appendAlias(makeEntry({ aliases: ['b'], canonical_slug: 'wiki/b' }), tmpFile)

  expect(lookupAlias('a')?.canonical_slug).toBe('wiki/a')
  expect(lookupAlias('b')?.canonical_slug).toBe('wiki/b')

  const lines = (await readFile(tmpFile, 'utf8')).trim().split('\n')
  expect(lines).toHaveLength(2)
})

test('loadAliasTable: empty file (edge case)', async () => {
  await writeFile(tmpFile, '', 'utf8')
  await loadAliasTable(tmpFile)

  expect(isLoaded()).toBe(true)
  expect(getAllAliases()).toHaveLength(0)
  expect(lookupAlias('anything')).toBeUndefined()
})

test('loadAliasTable: non-existent file does not throw', async () => {
  const missing = join(tmpDir, 'does-not-exist.jsonl')
  await loadAliasTable(missing)

  expect(isLoaded()).toBe(true)
  expect(getAllAliases()).toHaveLength(0)
})

test('getAllAliases: deduplicates by canonical_slug', async () => {
  // same slug, two alias entries (simulates appending a second alias for same page)
  const e1 = makeEntry({ aliases: ['foo'], canonical_slug: 'wiki/same' })
  const e2 = makeEntry({ aliases: ['bar'], canonical_slug: 'wiki/same' })
  await writeLines([e1, e2])
  await loadAliasTable(tmpFile)

  // both aliases resolve
  expect(lookupAlias('foo')?.canonical_slug).toBe('wiki/same')
  expect(lookupAlias('bar')?.canonical_slug).toBe('wiki/same')

  // getAllAliases deduplicates — only one entry per slug
  expect(getAllAliases()).toHaveLength(1)
})

test('loadAliasTable: skips malformed lines', async () => {
  const good = makeEntry({ aliases: ['good'], canonical_slug: 'wiki/good' })
  const content = 'not valid json\n' + JSON.stringify(good) + '\n'
  await writeFile(tmpFile, content, 'utf8')

  await loadAliasTable(tmpFile)
  expect(getAllAliases()).toHaveLength(1)
  expect(lookupAlias('good')?.canonical_slug).toBe('wiki/good')
})
