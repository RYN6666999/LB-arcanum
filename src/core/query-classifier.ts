export type QueryClass =
  | 'definition'
  | 'lookup'
  | 'search'
  | 'comparison'
  | 'graph'
  | 'research'
  | 'write'

export interface ClassifyResult {
  class: QueryClass
  classified_by: 'rule' | 'llm'
  confidence: 'high' | 'low'
  matched_pattern?: string
}

// Ordered rule table — first match wins
const RULES: Array<{
  class: QueryClass
  pattern: RegExp
  label: string
}> = [
  // 1. write (highest priority)
  {
    class: 'write',
    pattern: /更新|寫入|補連結|put_page|新增頁面|記錄|儲存/,
    label: 'write:keywords',
  },
  // 2. lookup
  {
    class: 'lookup',
    pattern: /在哪|的 ?slug|找.{1,10}頁面/,
    label: 'lookup:pattern',
  },
  // 3. graph (before definition — "的投資人是誰" should be graph, not definition)
  {
    class: 'graph',
    pattern: /的關係|連到哪|的投資人|認識誰|的同事|的朋友/,
    label: 'graph:pattern',
  },
  // 4. definition
  {
    class: 'definition',
    pattern: /是什麼|的定義|介紹一下|腦庫裡有|是誰$/,
    label: 'definition:pattern',
  },
  // 5. comparison
  {
    class: 'comparison',
    pattern: /和.{1,20}的差異|比較|vs\.?|跟.{1,20}(差|比|不同)/i,
    label: 'comparison:pattern',
  },
  // 6. research
  {
    class: 'research',
    pattern: /彙整|分析|完整報告|總結|深入研究/,
    label: 'research:pattern',
  },
  // 7. search (有哪些/相關/搜尋)
  {
    class: 'search',
    pattern: /有哪些|相關的|搜尋/,
    label: 'search:pattern',
  },
]

// Simple verb / operator presence check for the short-noun fallback
const VERB_PATTERN =
  /[嗎呢吧啊了過著]|是|有|找|做|給|說|看|用|去|來|到|被|把|讓|叫|問/

export function classifyQuery(input: string): ClassifyResult {
  const trimmed = input.trim()

  // Walk ordered rule table
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        class: rule.class,
        classified_by: 'rule',
        confidence: 'high',
        matched_pattern: rule.label,
      }
    }
  }

  // 8. Short noun fallback → definition (low confidence); skip empty strings
  if (trimmed.length > 0 && trimmed.length < 10 && !VERB_PATTERN.test(trimmed)) {
    return {
      class: 'definition',
      classified_by: 'rule',
      confidence: 'low',
      matched_pattern: 'definition:short-noun-fallback',
    }
  }

  // 9. Final fallback → search, flag for LLM assist
  return {
    class: 'search',
    classified_by: 'llm',
    confidence: 'low',
  }
}

// ---------------------------------------------------------------------------
// Forbidden-tool guard
// ---------------------------------------------------------------------------

const FORBIDDEN_TOOLS: Partial<Record<QueryClass, string[]>> = {
  definition: ['query', 'get_chunks'],
  lookup: ['search', 'query'],
}

export function assertToolAllowed(queryClass: QueryClass, tool: string): void {
  const forbidden = FORBIDDEN_TOOLS[queryClass] ?? []
  if (forbidden.includes(tool)) {
    throw new Error(
      `[QueryBudget] Tool "${tool}" is forbidden for query class "${queryClass}"`,
    )
  }
}
