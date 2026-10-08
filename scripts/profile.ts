/**
 * Profile config validator CLI (P2).
 *
 * Usage:
 *   npm run profile:check                 # validates profile.config.json (or $PROFILE_PATH)
 *   npm run profile:check -- <path>       # validates an arbitrary file (e.g. the .example)
 *
 * Exit codes:
 *   0 — missing file (zero-config) / enabled:false / valid
 *   1 — invalid JSON / wrong top-level shape / constraint violations (R2)
 *
 * Offline & side-effect free: reads + validates only; never fetches, never calls an LLM.
 * Spec: 《抓取内容逻辑与关键词个性化方案》§2.0.1 R2.
 */

import "./_env";

import fs from "node:fs";

import {
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  normalizeProfile,
  validateProfile,
} from "../lib/ai/personalize";

function resolvePath(): string {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  return arg?.trim() || process.env.PROFILE_PATH?.trim() || "profile.config.json";
}

function main(): void {
  const path = resolvePath();

  if (!fs.existsSync(path)) {
    console.log(`[profile] ${path} 不存在 —— 个性化未启用（合法：零配置零影响）。`);
    process.exit(0);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`✗ ${path} 不是合法 JSON：${(e as Error).message}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`✗ ${path} 顶层必须是 JSON 对象`);
    process.exit(1);
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.enabled === false) {
    console.log(`✓ ${path}：enabled=false —— 个性化关闭（合法）。`);
    process.exit(0);
  }

  const errors = validateProfile(raw);
  if (errors.length > 0) {
    console.error(`✗ ${path} 校验失败（${errors.length} 处）：`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\n约束：include + exclude 合计 ≤ ${MAX_KEYWORDS} 个；每个关键词 ≤ ${MAX_KEYWORD_CHARS} 字符。`,
    );
    process.exit(1);
  }

  const p = normalizeProfile(raw);
  console.log(`✓ ${path} 校验通过`);
  console.log(`  include(${p.include.length}) : ${p.include.join(", ") || "（空）"}`);
  console.log(`  exclude(${p.exclude.length}) : ${p.exclude.join(", ") || "（空）"}`);
  console.log(
    `  mode=${p.mode}  boost=${p.boost}  excludePenalty=${p.excludePenalty}`,
  );
  console.log(`  matchFields : ${p.matchFields.join(", ")}`);
  console.log(
    `  topPicks    : ${p.topPicks.enabled ? `on (${p.topPicks.count})` : "off"}`,
  );
  process.exit(0);
}

main();
