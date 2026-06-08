export interface DefinitionPayload {
  slug: string
  title: string
  one_liner: string
  short_def: string
  extended_def: string
  updated_at: string
  cache_hit: boolean
  source: 'alias' | 'resolve' | 'search'
}

const SENTENCE_ENDINGS = /[。！？.!?]/

function extractOneLiner(text: string): string {
  const match = SENTENCE_ENDINGS.exec(text)
  if (match) {
    const candidate = text.slice(0, match.index + 1).trim()
    if (candidate.length <= 80) return candidate
  }
  return text.slice(0, 80).trim()
}

function extractTitle(page: {
  slug: string
  title?: string
  compiled_truth?: string
  content?: string
}): string {
  if (page.title) return page.title

  const body = page.compiled_truth ?? page.content ?? ''
  const firstLine = body.split('\n')[0] ?? ''
  if (firstLine.startsWith('# ')) return firstLine.slice(2).trim()

  const parts = page.slug.split('/')
  return parts[parts.length - 1] ?? page.slug
}

export function extractDefinitionPayload(
  page: {
    slug: string
    title?: string
    compiled_truth?: string
    content?: string
    updated_at?: string
  },
  source: DefinitionPayload['source']
): DefinitionPayload {
  const body = page.compiled_truth ?? page.content ?? ''

  return {
    slug: page.slug,
    title: extractTitle(page),
    one_liner: extractOneLiner(body),
    short_def: body.slice(0, 300),
    extended_def: body.slice(0, 800),
    updated_at: page.updated_at ?? '',
    cache_hit: false,
    source,
  }
}
