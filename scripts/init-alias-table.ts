#!/usr/bin/env bun
/**
 * Copy assets/alias-table-initial.jsonl → ~/.gbrain/alias-table.jsonl
 * Safe: does NOT overwrite an existing file unless --force is passed.
 *
 * Usage:
 *   bun run scripts/init-alias-table.ts
 *   bun run scripts/init-alias-table.ts --force
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const force = process.argv.includes('--force')

const src = join(import.meta.dir, '..', 'assets', 'alias-table-initial.jsonl')
const dest = join(homedir(), '.gbrain', 'alias-table.jsonl')

if (!existsSync(src)) {
  console.error(`Source file not found: ${src}`)
  process.exit(1)
}

if (existsSync(dest) && !force) {
  console.log(`alias-table.jsonl already exists at ${dest}`)
  console.log('Pass --force to overwrite.')
  process.exit(0)
}

await mkdir(dirname(dest), { recursive: true })
await copyFile(src, dest)
console.log(`Copied alias table → ${dest}`)
