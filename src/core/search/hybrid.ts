/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * Pipeline: keyword + vector → RRF fusion → normalize → boost → cosine re-score → dedup
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Compiled truth boost: 2.0x for compiled_truth chunks after RRF normalization
 * Cosine re-score: blend 0.7*rrf + 0.3*cosine for query-specific ranking
 */

import type { BrainEngine } from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
import type { SearchResult, SearchOpts, Chunk } from '../types.ts';
import { embed } from '../embedding.ts';
import { dedupResults } from './dedup.ts';
import { sentenceSig, ternaryCosine } from './ternary.ts';
import { autoDetectDetail } from './intent.ts';
import { readFileSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Tag-weight config (loaded once per process from ~/.gbrain/tag-weights.json)
// ---------------------------------------------------------------------------
interface TagWeightConfig {
  weights: Record<string, number>;
  relations: Record<string, Record<string, number>>;
}

let _tagConfig: TagWeightConfig | null = null;
function getTagConfig(): TagWeightConfig {
  if (_tagConfig) return _tagConfig;
  try {
    const raw = readFileSync(`${homedir()}/.gbrain/tag-weights.json`, 'utf-8');
    _tagConfig = JSON.parse(raw) as TagWeightConfig;
  } catch {
    _tagConfig = { weights: {}, relations: {} };
  }
  return _tagConfig;
}

const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
/**
 * Backlink boost coefficient. Score is multiplied by (1 + BACKLINK_BOOST_COEF * log(1 + count)).
 * - 0 backlinks: factor = 1.0 (no boost).
 * - 1 backlink:  factor ~= 1.035.
 * - 10 backlinks: factor ~= 1.12.
 * - 100 backlinks: factor ~= 1.23.
 * Applied AFTER cosine re-score so it survives normalization, BEFORE dedup so the
 * boosted ranking determines which chunks per page are kept.
 */
const BACKLINK_BOOST_COEF = 0.05;
const DEBUG = process.env.GBRAIN_SEARCH_DEBUG === '1';

/**
 * Apply backlink boost to a result list in place. Mutates each result's score
 * by (1 + BACKLINK_BOOST_COEF * log(1 + count)). Pure data transform; no DB call.
 * Caller fetches counts via engine.getBacklinkCounts.
 */
export function applyBacklinkBoost(results: SearchResult[], counts: Map<string, number>): void {
  for (const r of results) {
    const count = counts.get(r.slug) ?? 0;
    if (count > 0) {
      r.score *= (1.0 + BACKLINK_BOOST_COEF * Math.log(1 + count));
    }
  }
}

/**
 * Apply per-page frontmatter boost multipliers. Mutates scores in place.
 * Caller fetches boosts via engine.getFrontmatterBoosts.
 * Pages with no boost field default to 1.0 (unchanged).
 */
export function applyFrontmatterBoost(results: SearchResult[], boosts: Map<string, number>): void {
  for (const r of results) {
    const multiplier = boosts.get(r.slug);
    if (multiplier != null) {
      r.score *= multiplier;
    }
  }
}

/**
 * Apply tag-based boost using weights and tag-relationship bonuses.
 *
 * For each result:
 *   base    = max(weight[tag]) across the page's tags (or 1.0 if untagged)
 *   bonus   = Σ relation[t1][t2] for each ordered pair (t1, t2) in the page's tags
 *   multiplier = base × (1 + bonus)
 *
 * Bridge pages (tagged with two related high-value tags) are rewarded
 * multiplicatively — e.g. 業務知識(1.4) + 說服力 relation(0.15) → 1.4 × 1.15 = 1.61×.
 *
 * Config loaded from ~/.gbrain/tag-weights.json (cached per process).
 * Pass `config` to override the default config (useful in unit tests).
 */
export function applyTagBoost(
  results: SearchResult[],
  tagsMap: Map<string, string[]>,
  config?: TagWeightConfig,
): void {
  const { weights, relations } = config ?? getTagConfig();
  if (Object.keys(weights).length === 0) return;

  for (const r of results) {
    const tags = tagsMap.get(r.slug);
    if (!tags || tags.length === 0) continue;

    // Base: highest weight tag wins
    const base = Math.max(...tags.map(t => weights[t] ?? 1.0));

    // Relation bonus: sum over all tag pairs
    let bonus = 0;
    for (let i = 0; i < tags.length; i++) {
      const relMap = relations[tags[i]];
      if (!relMap) continue;
      for (let j = 0; j < tags.length; j++) {
        if (i === j) continue;
        bonus += relMap[tags[j]] ?? 0;
      }
    }

    r.score *= base * (1 + bonus);

    if (DEBUG) {
      console.error(`[search-debug] ${r.slug} tag-boost base=${base.toFixed(2)} bonus=${bonus.toFixed(3)} tags=[${tags.join(',')}]`);
    }
  }
}

/**
 * 三進制重排 — 對候選集合做錯字/同義容錯拉分。
 *
 * 原理：ts_rank('simple') 對中文逐字拆，「汽候」vs「氣候」會拆開搜不到。
 * 三進制簽名靠字元/雙字元重疊，錯字/同義仍保有高 cosine。
 * 本函數對每個候選 chunk 算 query 的三進制 cosine，做溫和 boost：
 *   - cosine 未過門檻（虛假相關噪音）：＊1.0 不變
 *   - 超過門檻：原始 score 混合重排序，拉高字元重疊者
 *
 * 保守設計：只 boost 不壓抑，不會把真正無關的排到前面。失敗由呼叫端吞掉。
 */
const TERNARY_BOOST_THRESHOLD = 0.25;  // 低門檻，只護住「有字元重疊」的候選
const TERNARY_BOOST_STRENGTH = 0.4;    // boost 幅度上限（0..1）

export function applyTernaryRescore(results: SearchResult[], query: string): void {
  if (results.length === 0 || !query.trim()) return;

  const querySig = sentenceSig(query);
  // 補償式 boost：不壓抑原始分數，只在三進制 cosine 高時加分碼。
  // 錯字/同義的候選，原始 ts_rank 給低分，但三進制揭示高字元重疊 → 拉回。
  // 完全無關的 cosine 低 → 不變，保持原始排序。
  const boosts = results.map((r) => {
    const cosine = ternaryCosine(querySig, sentenceSig(r.chunk_text.slice(0, 200)));
    const excess = cosine - TERNARY_BOOST_THRESHOLD; // 超過門檻的部分才算 bonus
    if (excess <= 0) return r.score;
    // bonus = 超出門檻比例 × 強度，疊加到原始分數（不放縮）
    return r.score * (1 + TERNARY_BOOST_STRENGTH * excess);
  });

  for (let i = 0; i < results.length; i++) {
    results[i].score = boosts[i];
  }
}

/**
 * 三進制全庫召回 fallback — 當關鍵字 + 向量都撈不到候選（錯字/同義完全落空）時救回。
 *
 * 為什麼要這層：錯字查詢（如「拼牌定位」）在 ts_rank 可能完全 0 命中，重排層
 * (`applyTernaryRescore`) 只在「已有候選」內 boost，搆不到沒進候選的內容。
 *
 * 高效策略（避免雲端 DB 全表 chunk 掃描）：先拉全庫「頁 title」（輕量單欄），
 * 對 query 算 title 級三進制 cosine 找出錯字相近頁；命中頁再個別撈 chunk。
 * 這樣只查幾百個 title 字串，不拉整庫 chunk，雲端 Postgres 也快。
 */
const TERNARY_TITLE_THRESHOLD = 0.28;   // title 級召迴門檻：需真有字元重疊
const TERNARY_RECALL_MAX = 8;

export async function ternaryFallbackSearch(
  engine: BrainEngine,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  let titles: { slug: string; title: string }[] = [];
  try {
    titles = await engine.getAllPageTitles();
  } catch {
    return []; // 全掃失敗不致命
  }
  if (titles.length === 0) return [];

  const querySig = sentenceSig(query);
  // 對每頁 title 算三進制 cosine，找出錯字相近的候選頁
  const candidates = titles
    .map((p) => ({ ...p, sim: ternaryCosine(querySig, sentenceSig(p.title)) }))
    .filter((p) => p.sim >= TERNARY_TITLE_THRESHOLD)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TERNARY_RECALL_MAX);

  if (candidates.length === 0) return [];

  // 對候選頁撈 chunk，取每頁最好的一塊
  const results: SearchResult[] = [];
  for (const c of candidates) {
    try {
      const chunks = await engine.getChunks(c.slug);
      if (chunks.length === 0) continue;
      const best = chunks[0]; // 首塊通常具代表性
      results.push({
        slug: c.slug,
        page_id: best.page_id,
        title: c.title,
        type: 'concept',
        chunk_text: best.chunk_text,
        chunk_source: best.chunk_source === 'timeline' ? 'timeline' : 'compiled_truth',
        chunk_id: best.id,
        chunk_index: best.chunk_index,
        score: c.sim,
        stale: false,
      });
    } catch {
      // 單頁失敗跳過
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.min(limit, TERNARY_RECALL_MAX));
}

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  expandFn?: (query: string) => Promise<string[]>;
  /** Override default RRF K constant (default: 60). Lower values boost top-ranked results more. */
  rrfK?: number;
  /** Override dedup pipeline parameters. */
  dedupOpts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
  };
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  const limit = opts?.limit || 20;
  const offset = opts?.offset || 0;
  const innerLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);

  // Auto-detect detail level from query intent when caller doesn't specify
  const detail = opts?.detail ?? autoDetectDetail(query);
  const searchOpts: SearchOpts = { limit: innerLimit, detail };

  if (DEBUG && detail) {
    console.error(`[search-debug] auto-detail=${detail} for query="${query}"`);
  }

  // Run keyword search (always available, no API key needed)
  const keywordResults = await engine.searchKeyword(query, searchOpts);

  // Skip vector search entirely if no OpenAI key is configured
  if (!process.env.OPENAI_API_KEY) {
    // Apply backlink boost in keyword-only path too. One getBacklinkCounts query
    // per search request; not N+1.
    if (keywordResults.length > 0) {
      try {
        const slugs = Array.from(new Set(keywordResults.map(r => r.slug)));
        const [counts, fmBoosts, tagsMap] = await Promise.all([
          engine.getBacklinkCounts(slugs),
          engine.getFrontmatterBoosts(slugs),
          engine.getTagsForSlugs(slugs),
        ]);
        applyBacklinkBoost(keywordResults, counts);
        applyFrontmatterBoost(keywordResults, fmBoosts);
        applyTagBoost(keywordResults, tagsMap);
        keywordResults.sort((a, b) => b.score - a.score);
      } catch {
        // Boost failure is non-fatal: keep unboosted ranking.
      }
    }
    // KEY-only 路徑：keyword 撈不到時改走三進制全庫召回（錯字容錯）
    if (keywordResults.length > 0) {
      return dedupResults(keywordResults).slice(offset, offset + limit);
    }
    return await ternaryFallbackSearch(engine, query, limit);
  }

  // Determine query variants (optionally with expansion)
  // expandQuery already includes the original query in its return value,
  // so we use it directly instead of prepending query again
  let queries = [query];
  if (opts?.expansion && opts?.expandFn) {
    try {
      queries = await opts.expandFn(query);
      if (queries.length === 0) queries = [query];
    } catch {
      // Expansion failure is non-fatal
    }
  }

  // Embed all query variants and run vector search
  let vectorLists: SearchResult[][] = [];
  let queryEmbedding: Float32Array | null = null;
  try {
    const embeddings = await Promise.all(queries.map(q => embed(q)));
    queryEmbedding = embeddings[0];
    vectorLists = await Promise.all(
      embeddings.map(emb => engine.searchVector(emb, searchOpts)),
    );
  } catch {
    // Embedding failure is non-fatal, fall back to keyword-only
  }

  if (vectorLists.length === 0) {
    // vector 不可用/失敗：keyword 撈不到時改走三進制全庫召回（錯字容錯）
    if (keywordResults.length > 0) {
      return dedupResults(keywordResults).slice(offset, offset + limit);
    }
    return await ternaryFallbackSearch(engine, query, limit);
  }

  // Merge all result lists via RRF (includes normalization + boost)
  // Skip boost for detail=high (temporal/event queries want natural ranking)
  const allLists = [...vectorLists, keywordResults];
  let fused = rrfFusion(allLists, opts?.rrfK ?? RRF_K, detail !== 'high');

  // Cosine re-scoring before dedup so semantically better chunks survive
  if (queryEmbedding) {
    fused = await cosineReScore(engine, fused, queryEmbedding);
  }

  // Apply backlink boost AFTER cosine re-score so the boost survives normalization,
  // and BEFORE dedup so it influences which chunks per page survive deduplication.
  // One DB query for the whole result set (not N+1).
  if (fused.length > 0) {
    try {
      const slugs = Array.from(new Set(fused.map(r => r.slug)));
      const [counts, fmBoosts, tagsMap] = await Promise.all([
        engine.getBacklinkCounts(slugs),
        engine.getFrontmatterBoosts(slugs),
        engine.getTagsForSlugs(slugs),
      ]);
      applyBacklinkBoost(fused, counts);
      applyFrontmatterBoost(fused, fmBoosts);
      applyTagBoost(fused, tagsMap);
      fused.sort((a, b) => b.score - a.score);
    } catch {
      // Boost failure is non-fatal: keep blended cosine ranking.
    }
  }

  // Dedup
  const deduped = dedupResults(fused, opts?.dedupOpts);

  // Auto-escalate: if detail=low returned 0, retry with high
  if (deduped.length === 0 && opts?.detail === 'low') {
    return hybridSearch(engine, query, { ...opts, detail: 'high' });
  }

  // 三進制重排：在中段（dedup 後）對錯字/同義漏網做溫和拉分。
  // 這支在候選集合上重新算三進制 cosine，把「ts_rank 給低分但字元重疊高」
  // 的 chunk 往上拉，解決中文錯字/同義搜不到。只在有明顯字元重疊時生效。
  if (deduped.length > 0) {
    try {
      applyTernaryRescore(deduped, query);
      deduped.sort((a, b) => b.score - a.score);
    } catch {
      // 三進制重排失敗不致命：保留原排序。
    }
  }

  return deduped.slice(offset, offset + limit);
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each result gets score = sum(1 / (K + rank)) across all lists it appears in.
 * After accumulation: normalize to 0-1, then boost compiled_truth chunks.
 */
export function rrfFusion(lists: SearchResult[][], k: number, applyBoost = true): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { result: r, score: rrfScore });
      }
    }
  }

  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];

  // Normalize to 0-1 by dividing by observed max
  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      const rawScore = e.score;
      e.score = e.score / maxScore;

      // Apply compiled truth boost after normalization (skip for detail=high)
      const boost = applyBoost && e.result.chunk_source === 'compiled_truth' ? COMPILED_TRUTH_BOOST : 1.0;
      e.score *= boost;

      if (DEBUG) {
        console.error(`[search-debug] ${e.result.slug}:${e.result.chunk_id} rrf_raw=${rawScore.toFixed(4)} rrf_norm=${(rawScore / maxScore).toFixed(4)} boost=${boost} boosted=${e.score.toFixed(4)} source=${e.result.chunk_source}`);
      }
    }
  }

  // Sort by boosted score descending
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

/**
 * Cosine re-scoring: blend RRF score with query-chunk cosine similarity.
 * Runs before dedup so semantically better chunks survive.
 */
async function cosineReScore(
  engine: BrainEngine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
): Promise<SearchResult[]> {
  const chunkIds = results
    .map(r => r.chunk_id)
    .filter((id): id is number => id != null);

  if (chunkIds.length === 0) return results;

  let embeddingMap: Map<number, Float32Array>;
  try {
    embeddingMap = await engine.getEmbeddingsByChunkIds(chunkIds);
  } catch {
    // DB error is non-fatal, return results without re-scoring
    return results;
  }

  if (embeddingMap.size === 0) return results;

  // Normalize RRF scores to 0-1 for blending
  const maxRrf = Math.max(...results.map(r => r.score));

  return results.map(r => {
    const chunkEmb = r.chunk_id != null ? embeddingMap.get(r.chunk_id) : undefined;
    if (!chunkEmb) return r;

    const cosine = cosineSimilarity(queryEmbedding, chunkEmb);
    const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
    const blended = 0.7 * normRrf + 0.3 * cosine;

    if (DEBUG) {
      console.error(`[search-debug] ${r.slug}:${r.chunk_id} cosine=${cosine.toFixed(4)} norm_rrf=${normRrf.toFixed(4)} blended=${blended.toFixed(4)}`);
    }

    return { ...r, score: blended };
  }).sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
