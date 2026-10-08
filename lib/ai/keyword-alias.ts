/**
 * Bilingual keyword alias groups (P1).
 *
 * Why this exists: the corpus is mostly English (titles / excerpts) while users
 * typically type Chinese keywords — a literal match scores ~0 (see the
 * feasibility probe record under `test/`). Each group lists surface forms that
 * should be treated as the SAME concept, across zh/en and common synonyms.
 *
 * Matching rules live in `personalize.ts`:
 *   - CJK terms  → substring match
 *   - ASCII terms → word-ish match with light inflection (s / es / ing / ed)
 *
 * Spec: 《抓取内容逻辑与关键词个性化方案》§2.0.1 R3.
 */

export const KEYWORD_ALIAS_GROUPS: string[][] = [
  // --- AI / models ---
  ["大模型", "大语言模型", "基础模型", "llm", "large language model", "foundation model"],
  ["智能体", "ai agent", "agent", "agents"],
  ["开源", "open source", "open-source", "oss"],
  ["多模态", "multimodal", "multi-modal"],
  ["推理", "reasoning", "inference"],
  ["算力", "compute", "computing power"],
  ["训练", "training", "train"],
  // --- chips / hardware ---
  ["芯片", "半导体", "chip", "chips", "semiconductor"],
  ["英伟达", "nvidia", "nvda"],
  ["台积电", "tsmc"],
  ["数据中心", "data center", "data centre", "datacenter"],
  ["服务器", "server", "servers"],
  // --- companies ---
  ["微软", "microsoft", "msft"],
  ["谷歌", "google", "alphabet", "googl"],
  ["苹果", "apple", "aapl"],
  ["特斯拉", "tesla", "tsla"],
  ["字节跳动", "bytedance", "tiktok"],
  ["腾讯", "tencent", "qq", "weixin", "wechat"],
  ["阿里巴巴", "alibaba", "baba"],
  // --- finance / macro ---
  ["美联储", "fed", "federal reserve"],
  ["降息", "rate cut", "rate cuts"],
  ["加息", "rate hike", "rate hikes"],
  ["通胀", "inflation", "cpi"],
  ["融资", "funding", "financing", "raised"],
  ["上市", "ipo", "initial public offering"],
  ["黄金", "gold", "xau"],
  ["原油", "oil", "crude", "wti"],
  ["汇率", "exchange rate", "forex"],
  // --- crypto ---
  ["比特币", "bitcoin", "btc"],
  ["以太坊", "ethereum", "eth"],
  // --- policy / other ---
  ["监管", "regulation", "regulatory", "antitrust"],
  ["关税", "tariff", "tariffs"],
  ["电动车", "ev", "electric vehicle", "electric vehicles"],
];

/** Normalize a single surface form for comparison. */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Return every surface form equivalent to `keyword` (the keyword itself plus
 * every member of its alias group). Unknown keywords return just themselves.
 */
export function aliasFormsFor(keyword: string): string[] {
  const k = norm(keyword);
  if (!k) return [];
  for (const group of KEYWORD_ALIAS_GROUPS) {
    if (group.some((t) => norm(t) === k)) {
      return group.map((t) => t.trim());
    }
  }
  return [keyword.trim()];
}
