/**
 * Ternary Hash Search — 三進制哈希 (ported from Aris :11551 aris-memory.py)
 *
 * Concept: 把文字轉成 64 維三元 {-1,0,+1} signature，靠字元/雙字元組合的
 * 重疊來做到「錯字容錯、同義容忍、免分詞、零依賴」。
 * 解決 gbrain `ts_rank('simple')` 對中文逐字拆、錯字/同義搜不到的洞。
 *
 * 由來: 2026-08-29 左腦 skill 分析，POC 驗證 錯字容錯/同義改寫 8/8 vs FTS5 0/8。
 * 原始實作 Python (neuralis scripts/aris-memory.py)，此檔為 TypeScript 1:1 移植。
 *
 * 純函數，無 I/O、無依賴。供三進制檢索通道 + 單元測試使用。
 */

export const TERNARY_DIM = 64;

/** 字元分類，與 Aris 相同 */
function charCategory(char: string): number {
  const c = char.codePointAt(0)!;
  if (c >= 0x4e00 && c <= 0x9fff) return 1; // CJK 統一表意文字
  if (c >= 0x3040 && c <= 0x30ff) return 2; // 假名
  if (/[a-zA-Z]/.test(char)) return 3;      // 拉丁字母
  if (/[0-9]/.test(char)) return 4;         // 數字
  return 5;
}

/** FNV-1a 64 維 hash % 3 → {0,1,2} */
function ternaryHash(char: string, dimIdx: number): number {
  const cp = char.codePointAt(0)!;
  const cat = charCategory(char);
  let h = 2166136261;
  const seed = `${cp}|${cat}|${dimIdx}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 16777619) & 0xffffffff;
  }
  return h % 3;
}

/** 單字元 → 64 維 [-1,0,+1] 向量 */
export function charTernaryVec(char: string): number[] {
  const vec = new Array<number>(TERNARY_DIM);
  for (let d = 0; d < TERNARY_DIM; d++) {
    const h = ternaryHash(char, d);
    vec[d] = h === 2 ? 1 : h === 1 ? -1 : 0;
  }
  return vec;
}

/**
 * 句子 → 64 維三元 signature（-1,0,+1 陣列）。
 * unigram 權重 0.65 + bigram 權重 0.25，自適應門檻。
 */
export function sentenceSig(text: string): number[] {
  if (!text.trim()) return new Array<number>(TERNARY_DIM).fill(0);

  const chars = Array.from(text); // 逐 code point，跨代理對安全
  const unigram = new Map<string, number>();
  for (const ch of chars) unigram.set(ch, (unigram.get(ch) ?? 0) + 1);

  const bigram = new Map<string, number>();
  for (let j = 0; j < chars.length - 1; j++) {
    const bg = chars[j] + chars[j + 1];
    bigram.set(bg, (bigram.get(bg) ?? 0) + 1);
  }

  const totalU = chars.length;
  const totalB = Math.max(chars.length - 1, 1);

  const acc = new Array<number>(TERNARY_DIM).fill(0);

  // unigram 項 (權重 0.65)
  for (const [ch, cnt] of unigram) {
    const v = charTernaryVec(ch);
    const w = cnt / totalU;
    for (let i = 0; i < TERNARY_DIM; i++) acc[i] += v[i] * w * 0.65;
  }

  // bigram 項 (權重 0.25) — 先把兩字元向量平均，再乘權重
  for (const [bg, cnt] of bigram) {
    const [c1, c2] = bg;
    const v1 = charTernaryVec(c1);
    const v2 = charTernaryVec(c2);
    const w = cnt / totalB;
    for (let i = 0; i < TERNARY_DIM; i++) {
      acc[i] += ((v1[i] + v2[i]) / 2) * w * 0.25;
    }
  }

  // 自適應門檻：短文本門檻高（稀疏），長文本門檻低（更敢回應）
  const thr = totalU <= 10 ? 0.18 : totalU <= 20 ? 0.12 : 0.08;
  return acc.map((v) => (v > thr ? 1 : v < -thr ? -1 : 0));
}

/** 兩個三元 signature 的 cosine 相似度（0..1） */
export function ternaryCosine(sigA: number[], sigB: number[]): number {
  if (sigA.length !== TERNARY_DIM || sigB.length !== TERNARY_DIM) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < TERNARY_DIM; i++) {
    dot += sigA[i] * sigB[i];
    magA += sigA[i] * sigA[i];
    magB += sigB[i] * sigB[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}