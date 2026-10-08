import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { SYSTEM_PROMPT_DIGEST_EN, SYSTEM_PROMPT_DIGEST_ZH } from "./prompts";
import { REPORT_LOCALE } from "../sources/registry";
import type { Category, RawArticle } from "../sources/types";

const SYSTEM_PROMPT_DIGEST =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_DIGEST_EN : SYSTEM_PROMPT_DIGEST_ZH;

export interface BriefItem {
  title: string;
  url: string;
  source: string;
  summary: string;
  importance: number;
}

export interface DailyReport {
  hero_headline: string;
  daily_overview: string;
  tech_briefs: BriefItem[];
  finance_briefs: BriefItem[];
  politics_briefs: BriefItem[];
  editor_note: string;
  keywords: string[];
  /** Optional trading-signals section, present when scripts/daily.ts ran successfully. */
  trading?: TradingSection;
}

import type { TickerAnalysis } from "../trading/signals";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TradingCommentary } from "./trading-commentary";

export interface TradingSection extends TradingCommentary {
  generated_at: string;
  tickers: TickerAnalysis[];
  crypto_fear_greed?: FearGreedSnapshot;
  crypto_global?: CryptoGlobalStats;
}

export interface ArticleInput extends RawArticle {
  source: string;
}

const PER_CATEGORY_LIMIT: Record<Category, number> = {
  tech: 25,
  finance: 20,
  politics: 15,
};

const MAX_AGE_DAYS = 14;

/**
 * Pick `limit` items from `items` so every source gets a fair shot.
 *
 * Why this exists: the previous `slice(0, limit)` honored insertion order,
 * which is the source-iteration order in daily.ts. That gave whichever
 * source came first 100% of the quota — e.g. all 25 tech slots filled by
 * Hacker News before GitHub Trending / Solidot / V2EX / 阮一峰 got a turn.
 *
 * Strategy: drop items older than MAX_AGE_DAYS, group by sourceId,
 * sort each bucket newest-first, then round-robin one item per source
 * until we hit the limit. Sources with fewer items naturally drop out
 * and others absorb the slack.
 */
export function selectRoundRobin(
  items: ArticleInput[],
  limit: number,
  scoreMap?: Map<string, number>,
): ArticleInput[] {
  // Personalization bias: only reorder *within* each source bucket — the
  // round-robin below still guarantees every source its turn (fairness kept).
  // No scoreMap → this degenerates to the previous pure date-desc order.
  const scoreOf = (it: ArticleInput) => scoreMap?.get(it.url) ?? 0;
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const fresh = items.filter(
    (it) => !it.publishedAt || it.publishedAt.getTime() >= cutoff,
  );

  const bySource = new Map<string, ArticleInput[]>();
  for (const it of fresh) {
    const arr = bySource.get(it.sourceId) ?? [];
    arr.push(it);
    bySource.set(it.sourceId, arr);
  }
  for (const arr of bySource.values()) {
    arr.sort(
      (a, b) =>
        scoreOf(b) - scoreOf(a) ||
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    );
  }

  const buckets = Array.from(bySource.values());
  const out: ArticleInput[] = [];
  let madeProgress = true;
  while (out.length < limit && madeProgress) {
    madeProgress = false;
    for (const b of buckets) {
      if (b.length === 0) continue;
      out.push(b.shift()!);
      madeProgress = true;
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Reader preferences injected into the digest user prompt (P4). */
export interface DigestPreferences {
  include: string[];
  exclude: string[];
}

/**
 * Build the one-line preference instruction prepended to the digest prompt.
 * Soft guidance only: the system prompt still forbids inventing items.
 */
function buildPreferenceLine(prefs?: DigestPreferences | null): string {
  if (!prefs) return "";
  const inc = prefs.include.filter(Boolean);
  const exc = prefs.exclude.filter(Boolean);
  if (inc.length === 0 && exc.length === 0) return "";
  if (REPORT_LOCALE === "en") {
    return `Reader preference: prioritise candidate items related to [${inc.join(", ")}]${exc.length ? `; de-prioritise [${exc.join(", ")}]` : ""}. This only affects which candidates you pick, never invent items that are not in the candidate list.`;
  }
  return `读者偏好：请优先选取与 [${inc.join(", ")}] 相关的候选条目${exc.length ? `，并尽量避免 [${exc.join(", ")}]` : ""}。此偏好仅影响你的取舍排序，绝不可编造候选列表之外的条目。`;
}

/**
 * Best-effort dump of the raw LLM output + the JSON-extracted text so that
 * malformed / truncated responses stay diagnosable after the fact.
 */
async function dumpRawLogs(prefix: string, text: string, cleaned: string): Promise<void> {
  try {
    const fs = await import("node:fs");
    fs.mkdirSync("logs", { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(`logs/${prefix}-${ts}.txt`, text, "utf8");
    fs.writeFileSync(`logs/${prefix}-cleaned-${ts}.txt`, cleaned, "utf8");
    console.warn(`[pipeline] raw output dumped to logs/${prefix}-${ts}.txt`);
  } catch {
    // best-effort logging
  }
}

/**
 * A digest is "complete" only when every required section is populated.
 * jsonrepair can turn a truncated model response into a *partial* object that
 * still parses, so parse-success alone is not enough.
 */
function isComplete(r: DailyReport): boolean {
  return (
    r.tech_briefs.length > 0 &&
    r.finance_briefs.length > 0 &&
    r.politics_briefs.length > 0 &&
    r.editor_note.trim().length > 0 &&
    r.keywords.length >= 5
  );
}

/** Rough richness metric — used to keep the better of two incomplete attempts. */
function contentScore(r: DailyReport): number {
  return (
    r.tech_briefs.length +
    r.finance_briefs.length +
    r.politics_briefs.length +
    (r.editor_note.trim() ? 2 : 0) +
    Math.min(r.keywords.length, 5)
  );
}

async function callOnce(
  userPayloadJson: string,
  prefs?: DigestPreferences | null,
): Promise<DailyReport> {
  // Claude Code CLI's built-in system prompt biases the model toward
  // conversational markdown output. Anchor the format expectation in the
  // user message (instruction recency wins) *and* explicitly demand every
  // schema field be populated — without this Sonnet has been observed to
  // emit a JSON shell with empty arrays to "satisfy" a JSON-only ask.
  const basePrompt =
    REPORT_LOCALE === "en"
      ? [
          "**Output language: ENGLISH ONLY.** Every string value in the JSON — hero_headline, daily_overview, every brief's title/summary, editor_note, keywords — must be written entirely in English. No Chinese characters anywhere.",
          "",
          "Your task: generate today's daily brief from the candidate news below. **The response MUST be a single valid JSON object** — starts with `{`, ends with `}`, no markdown, no code fences, no explanations.",
          "",
          "The JSON must contain every field non-empty (briefs arrays per the system-prompt counts):",
          "  - hero_headline: 10-25 word headline of the day",
          "  - daily_overview: **150-250 word** paragraph covering tech / finance / politics signals so a reader sees the whole picture at a glance",
          "  - tech_briefs: **3-5** tech BriefItems",
          "  - finance_briefs: **3-5** finance BriefItems",
          "  - politics_briefs: **2-3** politics BriefItems",
          "  - editor_note: 30-60 word editor's note",
          "  - keywords: 5-8 keywords",
          "",
          "BriefItem fields: title, url (copied verbatim from candidate), source, summary, importance (1-10).",
          "**Quote rule (important!)**: For any quotation INSIDE a JSON string, use single quotes ' or curly quotes '\" — **never** raw double quotes \", which break JSON parsing.",
          "No trailing commas.",
          "",
          `Candidate news (JSON array, ${userPayloadJson.length} chars):`,
          userPayloadJson,
        ].join("\n")
      : [
          "你的任务：根据下方候选新闻，生成一份当日简报，**响应必须是一个合法 JSON 对象**——以 `{` 开头，以 `}` 结尾，不要 markdown / 不要代码围栏 / 不要任何解释。",
          "",
          "JSON 必须包含全部字段且不能为空（briefs 数组按 system prompt 规定的条数填充）：",
          "  - hero_headline: 10-25 字的当日一句话头条",
          "  - daily_overview: **150-220 字** 的当日总览段落，一段话覆盖技术 / 财经 / 时政 的核心信号，让读者一眼抓住全貌",
          "  - tech_briefs: **3-5 条** 科技 BriefItem",
          "  - finance_briefs: **3-5 条** 财经 BriefItem",
          "  - politics_briefs: **2-3 条** 时政 BriefItem",
          "  - editor_note: 30-60 字的编辑短评",
          "  - keywords: 5-8 个关键词",
          "",
          "BriefItem 字段：title、url（必须从候选条目原样选取）、source、summary、importance(1-10)。",
          "**引号规则（重要！）**：JSON 字符串内的中文引用请使用**中文全角引号**「」或者 “”，**绝对不要**用英文双引号 \" —— 那会导致 JSON 解析失败。例：写 商务部回应「内卷」 而不是 商务部回应\"内卷\"。",
          "不要使用单引号、不要末尾多余逗号。",
          "",
          "候选新闻（JSON 数组，共 " + userPayloadJson.length + " 字符）：",
          userPayloadJson,
        ].join("\n");
  const prefLine = buildPreferenceLine(prefs);
  const userPrompt = prefLine ? `${prefLine}\n\n${basePrompt}` : basePrompt;
  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT_DIGEST,
    userPrompt,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<DailyReport>;
  try {
    parsed = JSON.parse(cleaned) as Partial<DailyReport>;
  } catch (strictErr) {
    // LLMs routinely emit JSON with unescaped quotes inside Chinese
    // strings (e.g. 商务部回应"内卷"). jsonrepair fixes most of these
    // mechanically before we ever surface a failure.
    try {
      const repaired = jsonrepair(cleaned);
      parsed = JSON.parse(repaired) as Partial<DailyReport>;
      console.warn("[pipeline] JSON.parse failed but jsonrepair recovered");
      // Dump even on a *successful* repair: a repair that yields only a partial
      // object (e.g. truncated output) would otherwise leave no evidence.
      await dumpRawLogs("claude-repaired", text, cleaned);
    } catch {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/claude-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/claude-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[pipeline] both JSON.parse and jsonrepair failed; raw at logs/claude-raw-${ts}.txt`,
        );
      } catch {
        // best-effort logging
      }
      throw strictErr;
    }
  }
  return {
    hero_headline: parsed.hero_headline ?? "",
    daily_overview: parsed.daily_overview ?? "",
    tech_briefs: parsed.tech_briefs ?? [],
    finance_briefs: parsed.finance_briefs ?? [],
    politics_briefs: parsed.politics_briefs ?? [],
    editor_note: parsed.editor_note ?? "",
    keywords: parsed.keywords ?? [],
  };
}

export async function generateDailyReport(
  articles: ArticleInput[],
  scoreMap?: Map<string, number>,
  prefs?: DigestPreferences | null,
): Promise<{ report: DailyReport; tokensUsed: number }> {
  const grouped: Record<Category, ArticleInput[]> = {
    tech: [],
    finance: [],
    politics: [],
  };
  for (const a of articles) grouped[a.category].push(a);

  // Personalization: bias which items each source contributes (see
  // selectRoundRobin). No scoreMap → unchanged behaviour.
  const compact = (Object.keys(grouped) as Category[]).flatMap((c) =>
    selectRoundRobin(grouped[c], PER_CATEGORY_LIMIT[c], scoreMap),
  );

  const userPayload = compact.map((a, i) => ({
    n: i + 1,
    title: a.title,
    url: a.url,
    source: a.source,
    category: a.category,
    excerpt: (a.excerpt ?? "").slice(0, 200),
    published: a.publishedAt?.toISOString() ?? "",
  }));
  const userPayloadJson = JSON.stringify(userPayload);

  if (prefs && (prefs.include.length > 0 || prefs.exclude.length > 0)) {
    console.log(
      `[pipeline] preferences → digest prompt  include=[${prefs.include.join(", ")}]  exclude=[${prefs.exclude.join(", ")}]`,
    );
  }

  let report: DailyReport;
  try {
    report = await callOnce(userPayloadJson, prefs);
  } catch (firstErr) {
    // One retry — claude CLI occasionally wraps in narration on the first
    // pass but obeys when the same prompt is repeated.
    console.warn(
      `[pipeline] first claude CLI call failed, retrying: ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
    );
    report = await callOnce(userPayloadJson, prefs);
  }

  // Completeness gate — jsonrepair may "recover" a truncated response into a
  // partial object (missing politics_briefs / editor_note / keywords). Require
  // every section, retry once, and keep the richer of the two attempts.
  if (!isComplete(report)) {
    console.warn(
      `[pipeline] digest incomplete (tech ${report.tech_briefs.length} / finance ${report.finance_briefs.length} / politics ${report.politics_briefs.length} / note ${report.editor_note.trim() ? "y" : "n"} / kw ${report.keywords.length}) — retrying once`,
    );
    try {
      const retry = await callOnce(userPayloadJson, prefs);
      if (contentScore(retry) > contentScore(report)) report = retry;
      console.warn(
        isComplete(report)
          ? "[pipeline] retry produced a complete digest"
          : "[pipeline] retry still incomplete — keeping the richer result",
      );
    } catch (retryErr) {
      console.warn(
        `[pipeline] completeness retry failed: ${
          retryErr instanceof Error ? retryErr.message : String(retryErr)
        }`,
      );
    }
  }

  // Max subscription has no per-call token meter — we expose 0 for schema
  // compatibility; consumers should treat 0 as "metric not available".
  return { report, tokensUsed: 0 };
}
