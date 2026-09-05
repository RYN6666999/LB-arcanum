/**
 * Ternary Hash Search tests — 三進制哈希的容錯能力 + 接線驗證。
 *
 * 核心主張：三進制簽名靠「字元/雙字元組合重疊」做到錯字 / 同義 / 免分詞容錯，
 * 這是 gbrain ts_rank('simple') 對中文搜不到的洞。
 */
import { describe, test, expect } from 'bun:test';
import { sentenceSig, ternaryCosine, charTernaryVec, TERNARY_DIM } from '../src/core/search/ternary.ts';
import { applyTernaryRescore } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('ternarySig dimension', () => {
  test('輸出 64 維，值域 {-1,0,+1}', () => {
    const sig = sentenceSig('氣候變遷');
    expect(sig).toHaveLength(TERNARY_DIM);
    for (const v of sig) expect(v).toBeOneOf([-1, 0, 1]);
  });

  test('charTernaryVec 也是 64 維', () => {
    expect(charTernaryVec('氣')).toHaveLength(TERNARY_DIM);
  });
});

describe('錯字容錯 (核心價值)', () => {
  test('錯字「汽候」 vs 正確「氣候」 相似度 > 純無關字', () => {
    const target = sentenceSig('氣候變遷影響農業');
    const typo = sentenceSig('汽候變遷影響農業');   // 氣→汽 錯字
    const unrelated = sentenceSig('今天天氣很好');   // 無關句
    expect(ternaryCosine(typo, target)).toBeGreaterThan(ternaryCosine(unrelated, target));
  });

  test('完整重複 => 高相似度 (通常下限 0.7)', () => {
    const a = sentenceSig('記憶檢索系統優化');
    const b = sentenceSig('記憶檢索系統優化');
    expect(ternaryCosine(a, b)).toBeGreaterThan(0.7);
  });
});

describe('同義 / 免分詞容忍', () => {
  test('同義替換仍相關（「天氣」→「氣候」相鄰字元重疊）', () => {
    const target = sentenceSig('本週天氣轉涼');
    const synonym = sentenceSig('本週氣候轉涼');   // 天→氣候，部分字元重疊
    const unrelated = sentenceSig('股票市場漲跌');
    expect(ternaryCosine(synonym, target)).toBeGreaterThan(ternaryCosine(unrelated, target));
  });
});

describe('長度無關性', () => {
  test('相同內容不同長度 padding 不影響主訊號', () => {
    const short = sentenceSig('房仲銷售');
    const long = sentenceSig('關於房仲銷售這件事情的完整討論');
    // 兩者都含「房仲銷售」，相似度應高於與完全無關的句子
    const unrelated = sentenceSig('量子物理與天文望遠鏡');
    expect(ternaryCosine(long, short)).toBeGreaterThan(ternaryCosine(unrelated, short));
  });
});

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'p', page_id: 1, title: 'T', type: 'concept',
    chunk_text: '', chunk_source: 'compiled_truth',
    chunk_id: 1, chunk_index: 0, score: 0, stale: false,
    ...overrides,
  };
}

describe('applyTernaryRescore 接線（在真實檢索管線中提升錯字結果）', () => {
  test('錯字 chunk 分數上升（三進制 boost 生效）', () => {
    const typoChunk = makeResult({ slug: 'typo', chunk_text: '氣候變遷影響台灣農業收成', score: 0.5 });
    const results = [typoChunk];
    const before = typoChunk.score;
    applyTernaryRescore(results, '汽候變遷');
    expect(results[0].score).toBeGreaterThan(before);
  });

  test('完全無關時分數完全不變（不誤傷）', () => {
    const unrelatedChunk = makeResult({ slug: 'u', chunk_text: '量子物理與星空觀測', score: 0.8 });
    const results = [unrelatedChunk];
    const before = unrelatedChunk.score;
    applyTernaryRescore(results, '汽候變遷');
    expect(results[0].score).toBe(before);  // 無關 cosine -0.03，低於門檻，不動
  });
});