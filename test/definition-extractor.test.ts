import { describe, test, expect } from 'bun:test'
import { extractDefinitionPayload } from '../src/core/definition-extractor'

describe('extractDefinitionPayload', () => {
  test('正常中文頁面（有 compiled_truth）', () => {
    const page = {
      slug: 'people/alice-example',
      title: '艾麗絲',
      compiled_truth: '艾麗絲是一位創業者。她在 2020 年創立了 Acme。\n\n更多內容在這裡。',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const result = extractDefinitionPayload(page, 'resolve')
    expect(result.slug).toBe('people/alice-example')
    expect(result.title).toBe('艾麗絲')
    expect(result.one_liner).toBe('艾麗絲是一位創業者。')
    expect(result.short_def).toBe(page.compiled_truth.slice(0, 300))
    expect(result.extended_def).toBe(page.compiled_truth.slice(0, 800))
    expect(result.updated_at).toBe('2026-01-01T00:00:00Z')
    expect(result.cache_hit).toBe(false)
    expect(result.source).toBe('resolve')
  })

  test('只有 content 沒有 compiled_truth', () => {
    const page = {
      slug: 'companies/widget-co',
      title: 'Widget Co',
      content: 'Widget Co makes widgets. They are great.',
    }
    const result = extractDefinitionPayload(page, 'search')
    expect(result.one_liner).toBe('Widget Co makes widgets.')
    expect(result.short_def).toBe(page.content!.slice(0, 300))
    expect(result.source).toBe('search')
  })

  test('超短頁面（< 80 字）', () => {
    const page = {
      slug: 'topics/foo',
      compiled_truth: 'Foo is short.',
    }
    const result = extractDefinitionPayload(page, 'alias')
    expect(result.one_liner).toBe('Foo is short.')
    expect(result.short_def).toBe('Foo is short.')
    expect(result.extended_def).toBe('Foo is short.')
  })

  test('one_liner 截斷邏輯（> 80 字的第一句）', () => {
    const longSentence = 'A'.repeat(90) + '. More text.'
    const page = {
      slug: 'topics/long',
      compiled_truth: longSentence,
    }
    const result = extractDefinitionPayload(page, 'resolve')
    expect(result.one_liner.length).toBeLessThanOrEqual(80)
    expect(result.one_liner).toBe('A'.repeat(80))
  })

  test('title 從 # 提取', () => {
    const page = {
      slug: 'people/charlie-example',
      compiled_truth: '# Charlie Example\n\nSome content here.',
    }
    const result = extractDefinitionPayload(page, 'resolve')
    expect(result.title).toBe('Charlie Example')
  })

  test('title fallback 到 slug 最後一段', () => {
    const page = {
      slug: 'people/bob-example',
      compiled_truth: 'No heading here. Just some text.',
    }
    const result = extractDefinitionPayload(page, 'resolve')
    expect(result.title).toBe('bob-example')
  })

  test('空頁面 edge case', () => {
    const page = {
      slug: 'topics/empty',
    }
    const result = extractDefinitionPayload(page, 'search')
    expect(result.title).toBe('empty')
    expect(result.one_liner).toBe('')
    expect(result.short_def).toBe('')
    expect(result.extended_def).toBe('')
    expect(result.updated_at).toBe('')
    expect(result.cache_hit).toBe(false)
  })

  test('compiled_truth 優先於 content', () => {
    const page = {
      slug: 'topics/priority',
      compiled_truth: 'From compiled_truth.',
      content: 'From content.',
    }
    const result = extractDefinitionPayload(page, 'alias')
    expect(result.one_liner).toBe('From compiled_truth.')
  })

  test('one_liner 用中文句點截斷', () => {
    const page = {
      slug: 'topics/chinese',
      compiled_truth: '這是第一句。這是第二句。',
    }
    const result = extractDefinitionPayload(page, 'resolve')
    expect(result.one_liner).toBe('這是第一句。')
  })
})
