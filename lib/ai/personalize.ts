/**
 * Keyword personalization — P1 core (pure functions, no side effects on the
 * main pipeline). It only reads `profile.config.json`, scores articles, and
 * exposes helpers; nothing here is wired into `daily.ts` yet.
 *
 * Spec: 《抓取内容逻辑与关键词个性化方案》§2.0.1 (R1–R7).
 * Design notes:
 *   - Zero-config = zero impact: no file / `enabled:false` → loadProfile() → null.
 *   - Default mode is `boost` (re-rank, never delete). `filter` is opt-in.
 *   - CJK keywords match as substrings; ASCII keywords match word-ish with
 *     light inflection and a bilingual alias bridge (see keyword-alias.ts).
 */

import fs from "node:fs";
import { aliasFormsFor } from "./keyword-alias";
import type { ArticleInput } from "./pipeline";

// ---------------------------------------------------------------------------
// spec constants (R2)
// ---------------------------------------------------------------------------
export const MAX_KEYWORDS = 10;
export const MAX_KEYWORD_CHARS = 12;

const DEFAULT_MATCH_FIELDS = ["title", "excerpt", "summary", "source"];
const DEFAULT_FIELD_WEIGHTS: Record<string, number> = {
  title: 3,
  excerpt: 1,
  summary: 2,
  source: 1,
  meta: 1,
};
const DEFAULT_PROFILE_PATH = "profile.config.json";

export interface TopPicksConfig {
  enabled: boolean;
  count: number;
}

export interface KeywordProfile {
  enabled: boolean;
  locale?: "zh" | "en";
  include: string[];
  exclude: string[];
  boost: number;
  matchFields: string[];
  fieldWeights: Record<string, number>;
  /** Optional per-keyword multiplier (keyed by lowercased include term). */
  keywordWeights: Record<string, number>;
  mode: "boost" | "filter";
  excludePenalty: number;
  topPicks: TopPicksConfig;
}

export interface ScoreResult {
  score: number;
  includeHits: string[];
  excludeHits: string[];
}

export interface PersonalizationResult {
  articles: ArticleInput[];
  scoreMap: Map<string, number>;
  hitsMap: Map<string, string[]>;
  topPicks: ArticleInput[];
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const matcherCache = new Map<string, RegExp>();

/**
 * CJK surface → case-insensitive substring.
 * ASCII surface → word-ish match with light inflection (s / es / ing / ed),
 * delimited by non-alphanumerics so短词不会误命中（如 `ai` 不会命中 `said`）。
 */
function matcherFor(surface: string): RegExp {
  const key = surface.trim().toLowerCase();
  const cached = matcherCache.get(key);
  if (cached) return cached;
  const escaped = escapeRegExp(surface.trim());
  const re = CJK_RE.test(surface)
    ? new RegExp(escaped, "i")
    : new RegExp(`(?:^|[^a-z0-9])${escaped}(?:s|es|ing|ed)?(?=[^a-z0-9]|$)`, "i");
  matcherCache.set(key, re);
  return re;
}

function fieldText(a: ArticleInput, field: string): string {
  switch (field) {
    case "title":
      return a.title ?? "";
    case "excerpt":
      return a.excerpt ?? "";
    case "summary":
      return a.summary ?? "";
    case "source":
      return a.source ?? "";
    case "meta":
      return a.meta ?? "";
    default:
      return "";
  }
}

/** Best field weight among the fields where `keyword` (or an alias) matched. */
function bestWeight(
  a: ArticleInput,
  keyword: string,
  profile: KeywordProfile,
): number {
  const forms = aliasFormsFor(keyword);
  if (forms.length === 0) return 0;
  let best = 0;
  for (const f of profile.matchFields) {
    const text = fieldText(a, f);
    if (!text) continue;
    if (forms.some((form) => matcherFor(form).test(text))) {
      best = Math.max(best, profile.fieldWeights[f] ?? 1);
    }
  }
  return best;
}

/** Score one article against the profile. */
export function scoreArticle(a: ArticleInput, profile: KeywordProfile): ScoreResult {
  const includeHits: string[] = [];
  const excludeHits: string[] = [];
  let score = 0;

  for (const kw of profile.include) {
    const w = bestWeight(a, kw, profile);
    if (w > 0) {
      includeHits.push(kw);
      const kwWeight = profile.keywordWeights[kw.trim().toLowerCase()] ?? 1;
      score += profile.boost * w * kwWeight;
    }
  }
  for (const kw of profile.exclude) {
    if (bestWeight(a, kw, profile) > 0) {
      excludeHits.push(kw);
      score -= profile.excludePenalty;
    }
  }
  return { score, includeHits, excludeHits };
}

// ---------------------------------------------------------------------------
// validation + loading (R2)
// ---------------------------------------------------------------------------
function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
}

/** Validate a raw profile object. Returns a list of human-readable errors ([] = OK). */
export function validateProfile(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (raw.include !== undefined && !Array.isArray(raw.include)) errors.push("`include` 必须是字符串数组");
  if (raw.exclude !== undefined && !Array.isArray(raw.exclude)) errors.push("`exclude` 必须是字符串数组");

  const include = asStringArray(raw.include);
  const exclude = asStringArray(raw.exclude);
  const all = [...include, ...exclude];

  if (all.length > MAX_KEYWORDS) {
    errors.push(`关键词总数 ${all.length} 超过上限 ${MAX_KEYWORDS}（include + exclude 合计）`);
  }
  for (const kw of all) {
    const len = [...kw].length;
    if (len > MAX_KEYWORD_CHARS) {
      errors.push(`关键词「${kw}」长度 ${len} 超过上限 ${MAX_KEYWORD_CHARS} 字符`);
    }
    if (!/[\p{L}\p{N}]/u.test(kw)) {
      errors.push(`关键词「${kw}」必须是文字或数字，不能是纯标点/符号`);
    }
  }
  const incSet = new Set(include.map((s) => s.toLowerCase()));
  for (const e of exclude) {
    if (incSet.has(e.toLowerCase())) {
      errors.push(`关键词「${e}」同时出现在 include 与 exclude`);
    }
  }
  if (raw.mode !== undefined && raw.mode !== "boost" && raw.mode !== "filter") {
    errors.push("`mode` 只能是 \"boost\" 或 \"filter\"");
  }

  if (raw.keywordWeights !== undefined) {
    if (
      typeof raw.keywordWeights !== "object" ||
      raw.keywordWeights === null ||
      Array.isArray(raw.keywordWeights)
    ) {
      errors.push('`keywordWeights` 必须是对象，形如 { "关键词": 权重 }');
    } else {
      const incLower = new Set(include.map((s) => s.toLowerCase()));
      for (const [k, v] of Object.entries(raw.keywordWeights as Record<string, unknown>)) {
        if (!incLower.has(k.trim().toLowerCase())) {
          errors.push(`keywordWeights 中的「${k}」不在 include 列表中（可能拼写错误）`);
        }
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
          errors.push(`keywordWeights[「${k}」] 必须是正数`);
        }
      }
    }
  }
  return errors;
}

/** Fill defaults for a validated raw profile object. */
export function normalizeProfile(raw: Record<string, unknown>): KeywordProfile {
  const include = asStringArray(raw.include);
  const exclude = asStringArray(raw.exclude);
  const matchFieldsRaw = asStringArray(raw.matchFields);
  const matchFields = matchFieldsRaw.length ? matchFieldsRaw : [...DEFAULT_MATCH_FIELDS];
  const rawWeights =
    raw.fieldWeights && typeof raw.fieldWeights === "object" && !Array.isArray(raw.fieldWeights)
      ? (raw.fieldWeights as Record<string, number>)
      : {};
  const rawKwWeights =
    raw.keywordWeights && typeof raw.keywordWeights === "object" && !Array.isArray(raw.keywordWeights)
      ? (raw.keywordWeights as Record<string, unknown>)
      : {};
  const keywordWeights: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawKwWeights)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      keywordWeights[k.trim().toLowerCase()] = v;
    }
  }
  const tp =
    raw.topPicks && typeof raw.topPicks === "object" && !Array.isArray(raw.topPicks)
      ? (raw.topPicks as Record<string, unknown>)
      : {};

  return {
    enabled: true,
    locale: raw.locale === "en" ? "en" : raw.locale === "zh" ? "zh" : undefined,
    include,
    exclude,
    boost: typeof raw.boost === "number" && raw.boost > 0 ? raw.boost : 3,
    matchFields,
    fieldWeights: { ...DEFAULT_FIELD_WEIGHTS, ...rawWeights },
    keywordWeights,
    mode: raw.mode === "filter" ? "filter" : "boost",
    excludePenalty: typeof raw.excludePenalty === "number" ? raw.excludePenalty : 5,
    topPicks: {
      enabled: tp.enabled !== false,
      count: typeof tp.count === "number" && tp.count > 0 ? tp.count : 6,
    },
  };
}

/**
 * Load & validate `profile.config.json` (or `PROFILE_PATH` override).
 * - file missing            → null (zero impact)
 * - `enabled: false`        → null
 * - invalid JSON / schema   → throws (caller decides how to surface it)
 */
export function loadProfile(pathOverride?: string): KeywordProfile | null {
  const path =
    pathOverride?.trim() || process.env.PROFILE_PATH?.trim() || DEFAULT_PROFILE_PATH;
  if (!fs.existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.enabled === false) return null;

  const errors = validateProfile(raw);
  if (errors.length) {
    throw new Error(`${path} invalid:\n  - ${errors.join("\n  - ")}`);
  }
  return normalizeProfile(raw);
}

// ---------------------------------------------------------------------------
// apply (R4/R5)
// ---------------------------------------------------------------------------
function timeDesc(a: ArticleInput, b: ArticleInput): number {
  return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
}

/**
 * Score every article, optionally hard-filter (mode=filter), and build topPicks.
 * `boost` mode never removes articles, so the display/tab structure is preserved.
 */
export function applyPersonalization(
  articles: ArticleInput[],
  profile: KeywordProfile | null,
): PersonalizationResult {
  const scoreMap = new Map<string, number>();
  const hitsMap = new Map<string, string[]>();
  if (!profile || !profile.enabled) {
    return { articles, scoreMap, hitsMap, topPicks: [] };
  }

  const scored = articles.map((a) => ({ a, r: scoreArticle(a, profile) }));
  for (const { a, r } of scored) {
    scoreMap.set(a.url, r.score);
    hitsMap.set(a.url, r.includeHits);
  }

  const kept =
    profile.mode === "filter"
      ? scored
          .filter(({ r }) => !(r.excludeHits.length > 0 && r.includeHits.length === 0))
          .map(({ a }) => a)
      : articles;

  const topPicks = profile.topPicks.enabled
    ? scored
        .filter(({ r }) => r.score > 0 && r.includeHits.length > 0)
        .sort((x, y) => y.r.score - x.r.score || timeDesc(x.a, y.a))
        .slice(0, profile.topPicks.count)
        .map(({ a }) => a)
    : [];

  return { articles: kept, scoreMap, hitsMap, topPicks };
}

/**
 * Non-throwing wrapper around loadProfile() for callers that must keep running
 * (render / daily): returns the error message instead of raising.
 */
export function tryLoadProfile(pathOverride?: string): {
  profile: KeywordProfile | null;
  error: string | null;
} {
  try {
    return { profile: loadProfile(pathOverride), error: null };
  } catch (e) {
    return { profile: null, error: (e as Error).message };
  }
}
