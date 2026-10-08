import "./_env";

import { sources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import type { ArticleInput } from "../lib/ai/pipeline";
import {
  applyPersonalization,
  loadProfile,
  type KeywordProfile,
} from "../lib/ai/personalize";

// Source-fetch sanity check only — does NOT call the LLM. For the full
// ingest → digest → write-to-disk pipeline use `npm run daily` instead.
async function main() {
  console.log("Fetching from sources…\n");
  const articles: ArticleInput[] = [];

  const enabled = sources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
    }
  }

  console.log(`\nTotal articles: ${articles.length}`);
  console.log("\nTop 10 articles:");
  articles.slice(0, 10).forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.category}] ${a.title}`);
  });

  // --- P1 preview: keyword personalization (read-only; main pipeline untouched) ---
  let profile: KeywordProfile | null = null;
  try {
    profile = loadProfile();
  } catch (e) {
    console.error(`\n[personalize] ${(e as Error).message}`);
    console.error("[personalize] -> 个性化已跳过（修复 profile.config.json 后重试）");
  }

  if (profile) {
    const { scoreMap, hitsMap, topPicks } = applyPersonalization(articles, profile);
    const matched = [...hitsMap.values()].filter((h) => h.length > 0).length;
    console.log("\n=== 个性化预览 ===");
    console.log(
      `include: [${profile.include.join(", ") || "空"}]  exclude: [${profile.exclude.join(", ") || "空"}]  mode: ${profile.mode}`,
    );
    console.log(`命中文章: ${matched}/${articles.length}   topPicks: ${topPicks.length}`);
    topPicks.forEach((a, i) => {
      const hits = hitsMap.get(a.url) ?? [];
      const snippet = (a.excerpt ?? "").replace(/\s+/g, " ").slice(0, 50);
      console.log(`  ${i + 1}. [${a.category}] score=${scoreMap.get(a.url)}  ${a.title}`);
      if (hits.length) console.log(`       命中: ${hits.join(", ")}`);
      if (snippet) console.log(`       ${snippet}`);
    });
    if (topPicks.length === 0) {
      console.log("  （无命中：检查关键词语言/表述是否与语料匹配，见方案 §2.0.1 R3）");
    }
  } else {
    console.log(
      "\n[personalize] 未启用（无 profile.config.json 或 enabled=false）——行为与现状一致。",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
