import { describe, it, expect } from 'bun:test'
import { classifyQuery, assertToolAllowed } from '../src/core/query-classifier'

describe('classifyQuery — write class', () => {
  it('更新 keyword', () => {
    const r = classifyQuery('更新這個頁面的內容')
    expect(r.class).toBe('write')
    expect(r.classified_by).toBe('rule')
    expect(r.confidence).toBe('high')
  })

  it('寫入 keyword', () => {
    const r = classifyQuery('寫入 wiki/people/alice')
    expect(r.class).toBe('write')
  })

  it('put_page literal', () => {
    const r = classifyQuery('請用 put_page 儲存這份摘要')
    expect(r.class).toBe('write')
  })

  it('新增頁面', () => {
    const r = classifyQuery('幫我新增頁面給這個主題')
    expect(r.class).toBe('write')
  })
})

describe('classifyQuery — lookup class', () => {
  it('X 在哪', () => {
    const r = classifyQuery('alice 在哪')
    expect(r.class).toBe('lookup')
    expect(r.confidence).toBe('high')
  })

  it('的 slug', () => {
    const r = classifyQuery('這個人的 slug 是什麼')
    // lookup fires before definition because /的 ?slug/ matches first
    expect(r.class).toBe('lookup')
  })

  it('找 X 頁面', () => {
    const r = classifyQuery('找 acme 頁面')
    expect(r.class).toBe('lookup')
  })
})

describe('classifyQuery — definition class', () => {
  it('X 是什麼', () => {
    const r = classifyQuery('YC 是什麼')
    expect(r.class).toBe('definition')
    expect(r.classified_by).toBe('rule')
    expect(r.confidence).toBe('high')
  })

  it('的定義', () => {
    const r = classifyQuery('pgvector 的定義')
    expect(r.class).toBe('definition')
  })

  it('腦庫裡有 X 嗎', () => {
    const r = classifyQuery('腦庫裡有這個人嗎')
    expect(r.class).toBe('definition')
  })

  it('X 是誰 (end anchor)', () => {
    const r = classifyQuery('alice 是誰')
    expect(r.class).toBe('definition')
  })
})

describe('classifyQuery — comparison class', () => {
  it('X 和 Y 的差異', () => {
    const r = classifyQuery('pgvector 和 elasticsearch 的差異')
    expect(r.class).toBe('comparison')
  })

  it('比較', () => {
    const r = classifyQuery('比較兩種 embedding 方法')
    expect(r.class).toBe('comparison')
  })

  it('vs', () => {
    const r = classifyQuery('BM25 vs vector search')
    expect(r.class).toBe('comparison')
  })
})

describe('classifyQuery — graph class', () => {
  it('的關係', () => {
    const r = classifyQuery('alice 和 bob 的關係')
    expect(r.class).toBe('graph')
  })

  it('的投資人', () => {
    const r = classifyQuery('acme 的投資人是誰')
    expect(r.class).toBe('graph')
  })

  it('認識誰', () => {
    const r = classifyQuery('charlie 認識誰')
    expect(r.class).toBe('graph')
  })
})

describe('classifyQuery — research class', () => {
  it('彙整', () => {
    const r = classifyQuery('彙整所有關於 AI 的筆記')
    expect(r.class).toBe('research')
  })

  it('分析', () => {
    const r = classifyQuery('分析這個市場的趨勢')
    expect(r.class).toBe('research')
  })

  it('完整報告', () => {
    const r = classifyQuery('給我 acme 的完整報告')
    expect(r.class).toBe('research')
  })
})

describe('classifyQuery — search class (explicit)', () => {
  it('有哪些', () => {
    const r = classifyQuery('有哪些 ML 相關頁面')
    expect(r.class).toBe('search')
    expect(r.classified_by).toBe('rule')
  })

  it('相關的', () => {
    const r = classifyQuery('找跟 vector DB 相關的')
    expect(r.class).toBe('search')
  })

  it('搜尋', () => {
    const r = classifyQuery('搜尋 transformer 架構')
    expect(r.class).toBe('search')
  })
})

describe('classifyQuery — edge cases', () => {
  it('short noun (< 10 chars, no verb) → definition low confidence', () => {
    const r = classifyQuery('pgvector')
    expect(r.class).toBe('definition')
    expect(r.confidence).toBe('low')
    expect(r.matched_pattern).toBe('definition:short-noun-fallback')
  })

  it('very short pure English noun → definition fallback', () => {
    const r = classifyQuery('OpenAI')
    expect(r.class).toBe('definition')
    expect(r.confidence).toBe('low')
  })

  it('mixed-language query with no rules → search llm', () => {
    const r = classifyQuery('tell me everything about gbrain internals and how they work')
    expect(r.class).toBe('search')
    expect(r.classified_by).toBe('llm')
    expect(r.confidence).toBe('low')
  })

  it('write beats definition when both could match', () => {
    // 記錄 is write; also could sound definitional
    const r = classifyQuery('記錄這個定義')
    expect(r.class).toBe('write')
  })

  it('empty string → search llm fallback', () => {
    const r = classifyQuery('')
    expect(r.class).toBe('search')
    expect(r.classified_by).toBe('llm')
  })

  it('single CJK char → definition short-noun fallback', () => {
    const r = classifyQuery('愛')
    expect(r.class).toBe('definition')
    expect(r.confidence).toBe('low')
  })

  it('pure whitespace → search llm fallback', () => {
    const r = classifyQuery('   ')
    expect(r.class).toBe('search')
    expect(r.classified_by).toBe('llm')
  })
})

describe('assertToolAllowed', () => {
  it('allows a permitted tool for definition', () => {
    expect(() => assertToolAllowed('definition', 'get_page')).not.toThrow()
  })

  it('throws for query on definition class', () => {
    expect(() => assertToolAllowed('definition', 'query')).toThrow(
      '[QueryBudget] Tool "query" is forbidden for query class "definition"',
    )
  })

  it('throws for get_chunks on definition class', () => {
    expect(() => assertToolAllowed('definition', 'get_chunks')).toThrow(
      '[QueryBudget]',
    )
  })

  it('throws for search on lookup class', () => {
    expect(() => assertToolAllowed('lookup', 'search')).toThrow(
      '[QueryBudget] Tool "search" is forbidden for query class "lookup"',
    )
  })

  it('throws for query on lookup class', () => {
    expect(() => assertToolAllowed('lookup', 'query')).toThrow('[QueryBudget]')
  })

  it('allows any tool for write class (no restrictions)', () => {
    expect(() => assertToolAllowed('write', 'put_page')).not.toThrow()
    expect(() => assertToolAllowed('write', 'query')).not.toThrow()
  })

  it('allows any tool for graph class', () => {
    expect(() => assertToolAllowed('graph', 'traverse_graph')).not.toThrow()
  })
})
