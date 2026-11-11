import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import linuxdoIcon from "./assets/linuxdo.png";
import v2exIcon from "./assets/v2ex.jpg";
import nodeseekIcon from "./assets/nodeseek.png";
import appinnIcon from "./assets/appinn.jpg";
import ghxiIcon from "./assets/ghxi.png";
import iplaysoftIcon from "./assets/iplaysoft.png";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Deal = Dashboard["deals"][number];

const CATEGORIES = [
  "全部",
  "免费白嫖",
  "限免",
  "低价优惠",
  "会员订阅",
  "游戏",
  "AI 相关",
  "VPS/云服务",
  "代理/机场",
  "软件工具",
  "交易/求购",
  "讨论/资讯",
  "其他",
  "我的收藏",
] as const;

/** 不是优惠的类别：「全部」里默认隐藏，可一键显示 */
const NON_DEAL = new Set<string>(["交易/求购", "讨论/资讯"]);

/** 来源名 → 本地 favicon（构建时从 Google favicon 服务 sz=64 拉取并自托管，见 DATA-PLAN.md） */
const SOURCE_ICONS: Record<string, string> = {
  "LINUX DO 福利羊毛": linuxdoIcon,
  "V2EX 推广": v2exIcon,
  NodeSeek: nodeseekIcon,
  小众软件: appinnIcon,
  果核剥壳: ghxiIcon,
  异次元软件世界: iplaysoftIcon,
};

function sourceInitial(name: string): string {
  const t = name.trim();
  // 英文来源取首字母，中文来源取首字
  const m = t.match(/[A-Za-z]/);
  if (t.startsWith("LINUX")) return "L";
  if (m && t.indexOf(m[0]) === 0) return m[0].toUpperCase();
  return t.charAt(0) || "?";
}

function SourceLogo({
  source,
  size = 16,
  className = "",
}: {
  source: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const icon = SOURCE_ICONS[source];
  const px = `${size}px`;
  if (!icon || failed) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[#f4f4f5] font-semibold text-[#52525b] ring-1 ring-inset ring-[var(--border)] dark:bg-[#27272a] dark:text-[#d4d4d8] ${className}`}
        style={{ width: px, height: px, fontSize: Math.max(9, Math.round(size * 0.58)) }}
      >
        {sourceInitial(source)}
      </span>
    );
  }
  return (
    <img
      src={icon}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-[4px] bg-white object-contain ring-1 ring-inset ring-black/5 ${className}`}
      style={{ width: px, height: px }}
    />
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 发布时间：相对时间（精确到分钟）+ 具体时刻，例如「23 分钟前 · 11:46」「昨天 23:08」「11/6 12:31」 */
function fmtPublished(ms: number | null): { short: string; full: string } | null {
  if (ms == null) return null;
  const d = new Date(ms);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const full = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`;
  const diff = now.getTime() - ms;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  let short: string;
  if (diff < 0) short = `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  else if (diff < 60_000) short = "刚刚";
  else if (diff < 3_600_000) short = `${Math.floor(diff / 60_000)} 分钟前 · ${hh}:${mm}`;
  else if (d.toDateString() === now.toDateString()) short = `${Math.floor(diff / 3_600_000)} 小时前 · ${hh}:${mm}`;
  else if (d.toDateString() === yesterday.toDateString()) short = `昨天 ${hh}:${mm}`;
  else short = `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  return { short, full };
}

function PublishedAt({ ms, className = "" }: { ms: number | null; className?: string }) {
  const p = fmtPublished(ms);
  if (!p) return null;
  const fresh = ms != null && Date.now() - ms < 3 * 3_600_000; // 3 小时内高亮
  return (
    <time
      dateTime={new Date(ms!).toISOString()}
      title={`发布于 ${p.full}`}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap ${fresh ? "font-medium text-[var(--text)]" : ""} ${className}`}
    >
      <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      {p.short}
    </time>
  );
}

function expiryInfo(ms: number | null): { label: string; urgent: boolean; past: boolean } | null {
  if (ms == null) return null;
  const d = new Date(ms);
  const label = `${d.getMonth() + 1}/${d.getDate()} 到期`;
  const remain = ms - Date.now();
  return { label, urgent: remain > 0 && remain <= 2 * 24 * 3600 * 1000, past: remain <= 0 };
}

/** AI 分 → 0~100 展示分（模型原始分偏低，按 0.5 封顶映射，与微信推送一致） */
function aiPoints(score: number): number {
  return Math.max(0, Math.min(100, Math.round((score / 0.5) * 100)));
}

function aiTier(score: number): { label: string; cls: string } {
  if (score >= 0.4) return { label: "高价值", cls: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-[#052e16]" };
  if (score >= 0.3) return { label: "值得看", cls: "bg-amber-500 text-white dark:bg-amber-400 dark:text-[#451a03]" };
  if (score >= 0.15) return { label: "一般", cls: "bg-[var(--accent-soft)] text-[var(--text)]" };
  return { label: "价值低", cls: "bg-[var(--accent-soft)] text-[var(--dim)]" };
}

function AiBadge({ score, confidence }: { score: number | null; confidence: number | null }) {
  if (score == null) return null;
  const t = aiTier(score);
  return (
    <span
      title={`AI 价值分 ${aiPoints(score)}/100${confidence != null ? ` · 置信度 ${Math.round(confidence * 100)}%` : ""}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${t.cls}`}
    >
      AI {aiPoints(score)}
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-[#18181b] px-2.5 text-[13px] font-medium text-white shadow-sm transition-colors dark:bg-[#fafafa] dark:text-[#18181b]"
          : "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] font-medium text-[#3f3f46] shadow-sm transition-colors hover:bg-[#f4f4f5] hover:text-[#18181b] dark:text-[#d4d4d8] dark:hover:bg-[#27272a] dark:hover:text-[#fafafa]"
      }
    >
      {children}
    </button>
  );
}

function DealActions({
  deal,
  onToggle,
  compact = false,
}: {
  deal: Deal;
  onToggle: (id: number, field: "claimed" | "favorite", value: boolean) => void;
  compact?: boolean;
}) {
  const h = compact ? "h-7 text-[12px]" : "h-8 text-[13px]";
  return (
    <div className={`flex items-center gap-2 ${compact ? "mt-2" : ""}`}>
      <a
        href={deal.link}
        target="_blank"
        rel="noreferrer"
        aria-label={`去领取：${deal.title}`}
        className={`inline-flex ${h} items-center justify-center rounded-md bg-[var(--accent)] px-3 font-medium text-[var(--accent-foreground)] shadow transition-opacity hover:opacity-90`}
      >
        去领取
      </a>
      <button
        type="button"
        aria-label={deal.claimed ? `取消已领：${deal.title}` : `标记已领：${deal.title}`}
        aria-pressed={deal.claimed}
        onClick={() => onToggle(deal.id, "claimed", !deal.claimed)}
        className={
          deal.claimed
            ? `inline-flex ${h} items-center justify-center rounded-md border border-emerald-600/30 bg-emerald-50 px-2.5 font-medium text-emerald-700 shadow-sm transition-colors dark:border-emerald-400/30 dark:bg-emerald-950 dark:text-emerald-300`
            : `inline-flex ${h} items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 font-medium text-[var(--text)] shadow-sm transition-colors hover:bg-[var(--accent-soft)]`
        }
      >
        {deal.claimed ? "已领 ✓" : "标记已领"}
      </button>
      <button
        type="button"
        aria-label={deal.favorite ? `取消收藏：${deal.title}` : `收藏：${deal.title}`}
        aria-pressed={deal.favorite}
        onClick={() => onToggle(deal.id, "favorite", !deal.favorite)}
        className={`ml-auto inline-flex ${h} items-center justify-center rounded-md px-2.5 transition-colors hover:bg-[var(--accent-soft)] ${
          deal.favorite ? "font-medium text-amber-600 dark:text-amber-400" : "text-[var(--dim)] hover:text-[var(--text)]"
        }`}
      >
        {deal.favorite ? "★ 已收藏" : "☆ 收藏"}
      </button>
    </div>
  );
}

function DealCard({
  deal,
  onToggle,
}: {
  deal: Deal;
  onToggle: (id: number, field: "claimed" | "favorite", value: boolean) => void;
}) {
  const exp = expiryInfo(deal.expiresAt);
  return (
    <article
      className={`deal-card flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm transition-shadow hover:shadow-md ${
        deal.claimed ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-snug tracking-tight text-[var(--text)]">
          {deal.title}
        </h3>
        {deal.isNew && (
          <span className="mt-0.5 inline-flex shrink-0 items-center rounded-md bg-[var(--accent)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--accent-foreground)]">
            NEW
          </span>
        )}
      </div>
      {deal.summary && (
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-[var(--dim)]">
          {deal.summary}
        </p>
      )}
      {/* 元信息压成一行小字：类别 · 来源(带 logo) · 时间 · 到期 */}
      <div className="mb-2.5 mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-[var(--dim)]">
        <AiBadge score={deal.aiScore} confidence={deal.aiConfidence} />
        <span
          title={deal.categoryByAi ? "AI 分类" : "关键词规则分类"}
          className="inline-flex shrink-0 items-center rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text)]"
        >
          {deal.category}
        </span>
        <span className="inline-flex min-w-0 shrink items-center gap-1 truncate rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-medium">
          <SourceLogo source={deal.source} size={14} />
          <span className="truncate">{deal.source}</span>
        </span>
        <PublishedAt ms={deal.publishedAt} />
        {exp && (
          <span
            className={`shrink-0 whitespace-nowrap ${
              exp.past
                ? "font-medium line-through"
                : exp.urgent
                  ? "font-semibold text-[#dc2626] dark:text-[#f87171]"
                  : "font-medium text-[var(--text)]"
            }`}
          >
            {exp.label}
            {exp.urgent ? " · 临期" : ""}
          </span>
        )}
      </div>
      <div className="mt-auto border-t border-[var(--border)] pt-2.5">
        <DealActions deal={deal} onToggle={onToggle} />
      </div>
    </article>
  );
}

type CategoryName = (typeof CATEGORIES)[number];

type View = "list" | "rank";

interface Filters {
  sourceFilter: string | null;
  category: CategoryName;
  onlyNew: boolean;
  view: View;
  hideNonDeal: boolean;
}

const FILTERS_KEY = "deals.filters.v1";
const DEFAULT_FILTERS: Filters = { sourceFilter: null, category: "全部", onlyNew: false, view: "list", hideNonDeal: true };

function loadFilters(): Filters {
  // ?view=rank / ?view=list 可直接打开指定视图（便于分享排行榜链接）
  const q = new URLSearchParams(window.location.search).get("view");
  const urlView: View | null = q === "rank" || q === "list" ? q : null;
  try {
    const raw = window.localStorage.getItem(FILTERS_KEY);
    if (!raw) return urlView ? { ...DEFAULT_FILTERS, view: urlView } : DEFAULT_FILTERS;
    const v = JSON.parse(raw) as Partial<Filters>;
    return {
      sourceFilter: typeof v.sourceFilter === "string" ? v.sourceFilter : null,
      category: CATEGORIES.includes(v.category as CategoryName) ? (v.category as CategoryName) : "全部",
      onlyNew: v.onlyNew === true,
      view: urlView ?? (v.view === "rank" ? "rank" : "list"),
      hideNonDeal: v.hideNonDeal !== false,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

type Settings = ApiResponse<typeof api, "getSettings">;
type KeyField = "xizhiKey" | "openrouterKey" | "jinaKey";

const KEY_FIELDS: {
  field: KeyField;
  stat: "xizhi" | "openrouter" | "jina";
  label: string;
  hint: string;
  placeholder: string;
  href: string;
}[] = [
  {
    field: "xizhiKey",
    stat: "xizhi",
    label: "微信推送 · 息知 Key",
    hint: "开启微信推送，可直接粘贴完整推送地址",
    placeholder: "XZ… 或 https://xizhi.qqoq.net/XZ….send",
    href: "https://xz.qqoq.net/",
  },
  {
    field: "openrouterKey",
    stat: "openrouter",
    label: "AI 评分 · OpenRouter Key",
    hint: "开启 AI 价值分、分类和排行榜（免费模型）",
    placeholder: "sk-or-v1-…",
    href: "https://openrouter.ai/keys",
  },
  {
    field: "jinaKey",
    stat: "jina",
    label: "LINUX DO 抓取 · Jina Key（可选）",
    hint: "LINUX DO 显示异常 / HTTP 429 限流时填写",
    placeholder: "jina_…",
    href: "https://jina.ai/reader",
  },
];

function SettingsPanel({ onToast }: { onToast: (t: { ok: boolean; text: string }) => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({}) });
  const [drafts, setDrafts] = useState<Partial<Record<KeyField, string>>>({});
  const [quiet, setQuiet] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (args: Partial<Record<KeyField | "quietHours", string>>) => api.saveSettings(args),
    onSuccess: (data: Settings, args) => {
      queryClient.setQueryData(["settings"], data);
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setDrafts((d) => {
        const next = { ...d };
        for (const k of Object.keys(args) as KeyField[]) delete next[k];
        return next;
      });
      if ("quietHours" in args) setQuiet(null);
      onToast({ ok: true, text: Object.values(args).every((v) => v === "") ? "已清除" : "已保存，立即生效" });
    },
    onError: (e) => onToast({ ok: false, text: e instanceof Error ? e.message : "保存失败" }),
  });

  const s = settings.data;
  const inputCls =
    "h-9 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 font-mono text-xs text-[var(--text)] placeholder:font-sans placeholder:text-[var(--dim)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]";
  const btnCls =
    "inline-flex h-9 shrink-0 items-center justify-center rounded-md px-3 text-xs font-medium transition-opacity disabled:pointer-events-none disabled:opacity-50";

  return (
    <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="text-sm font-medium text-[var(--text)]">设置</p>
        <span className="text-xs text-[var(--dim)]">密钥只保存在服务端，页面上只显示末 4 位</span>
      </div>
      {!s ? (
        <p className="mt-3 text-xs text-[var(--dim)]">{settings.isError ? "读取设置失败" : "加载中…"}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {KEY_FIELDS.map((f) => {
            const st = s[f.stat];
            const draft = drafts[f.field] ?? "";
            return (
              <div key={f.field}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <label htmlFor={`set-${f.field}`} className="text-xs font-medium text-[var(--text)]">
                    {f.label}
                  </label>
                  <span className={`text-xs ${st.set ? "text-[var(--text)]" : "text-[var(--dim)]"}`}>
                    {st.set ? `✓ 已配置${st.tail ? ` ····${st.tail}` : ""}` : "未配置"}
                    {st.fromEnv && " · 来自 .env，重启后以 .env 为准"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  {f.hint} ·{" "}
                  <a
                    href={f.href}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-[var(--text)]"
                  >
                    获取
                  </a>
                </p>
                <form
                  className="mt-1.5 flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.trim()) save.mutate({ [f.field]: draft });
                  }}
                >
                  <input
                    id={`set-${f.field}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft}
                    placeholder={st.set ? "粘贴新的 Key 以替换" : f.placeholder}
                    onChange={(e) => setDrafts((d) => ({ ...d, [f.field]: e.target.value }))}
                    className={inputCls}
                  />
                  <button
                    type="submit"
                    disabled={!draft.trim() || save.isPending}
                    className={`${btnCls} bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90`}
                  >
                    保存
                  </button>
                  {st.set && (
                    <button
                      type="button"
                      disabled={save.isPending}
                      onClick={() => {
                        if (window.confirm(`确定清除「${f.label}」？`)) save.mutate({ [f.field]: "" });
                      }}
                      className={`${btnCls} border border-[var(--border)] text-[var(--dim)] hover:text-[var(--destructive)]`}
                    >
                      清除
                    </button>
                  )}
                </form>
              </div>
            );
          })}
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (quiet != null) save.mutate({ quietHours: quiet });
            }}
          >
            <label htmlFor="set-quiet" className="text-xs font-medium text-[var(--text)]">
              推送静默时段（北京时间）
            </label>
            <input
              id="set-quiet"
              value={quiet ?? s.quietHours}
              onChange={(e) => setQuiet(e.target.value)}
              placeholder="23-8"
              className={`${inputCls} w-24 flex-none`}
            />
            <button
              type="submit"
              disabled={quiet == null || quiet === s.quietHours || save.isPending}
              className={`${btnCls} bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90`}
            >
              保存
            </button>
            <span className="text-xs text-[var(--dim)]">如 23-8，填 off 关闭</span>
          </form>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function SkeletonList() {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="h-4 w-4/5 rounded bg-[var(--surface-alt)]" />
          <div className="mt-2 h-3 w-full rounded bg-[var(--surface-alt)]" />
          <div className="mt-1.5 h-3 w-2/3 rounded bg-[var(--surface-alt)]" />
          <div className="mt-3 flex gap-1.5">
            <div className="h-4 w-14 rounded bg-[var(--surface-alt)]" />
            <div className="h-4 w-20 rounded bg-[var(--surface-alt)]" />
          </div>
          <div className="mt-3 h-8 w-full rounded bg-[var(--surface-alt)]" />
        </div>
      ))}
    </div>
  );
}

function rankColor(rank: number): string {
  if (rank === 1) return "text-lg text-amber-500";
  if (rank === 2) return "text-lg text-zinc-400";
  if (rank === 3) return "text-lg text-orange-700 dark:text-orange-400";
  return "text-sm text-[var(--dim)]";
}

function Leaderboard({
  deals,
  onToggle,
}: {
  deals: Deal[];
  onToggle: (id: number, field: "claimed" | "favorite", value: boolean) => void;
}) {
  return (
    <ol
      className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm"
      aria-label="AI 价值排行榜"
    >
      {deals.map((d, i) => {
        const score = d.aiScore ?? 0;
        const t = aiTier(score);
        const rank = i + 1;
        const exp = expiryInfo(d.expiresAt);
        return (
          <li key={d.id} className="flex gap-3 border-b border-[var(--border)] px-3 py-3 last:border-b-0">
            <span className={`w-7 shrink-0 pt-0.5 text-center font-bold tabular-nums ${rankColor(rank)}`}>{rank}</span>
            <div className={`min-w-0 flex-1 ${d.claimed ? "opacity-60" : ""}`}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <a
                    href={d.link}
                    target="_blank"
                    rel="noreferrer"
                    className="line-clamp-2 text-[14px] font-semibold leading-snug text-[var(--text)] hover:underline"
                  >
                    {d.title}
                  </a>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--dim)]">
                    <SourceLogo source={d.source} size={12} />
                    <span className="truncate">{d.source}</span>
                    <span>·</span>
                    <span>{d.category}</span>
                    <span>·</span>
                    <PublishedAt ms={d.publishedAt} />
                    {d.isNew && <span className="font-semibold text-[var(--text)]">· NEW</span>}
                    {exp && !exp.past && (
                      <span className={exp.urgent ? "font-semibold text-[var(--destructive)]" : ""}>
                        · {exp.label}
                        {exp.urgent ? " · 临期" : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex w-14 shrink-0 flex-col items-end gap-1">
                  <span className="text-lg font-bold leading-none tabular-nums text-[var(--text)]">{aiPoints(score)}</span>
                  <span className={`whitespace-nowrap rounded px-1 text-[10px] font-medium ${t.cls}`}>{t.label}</span>
                </div>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-alt)]">
                <div
                  className={`h-full rounded-full ${score >= 0.4 ? "bg-emerald-500" : score >= 0.3 ? "bg-amber-500" : "bg-zinc-400"}`}
                  style={{ width: `${Math.max(4, aiPoints(score))}%` }}
                />
              </div>
              <DealActions deal={d} onToggle={onToggle} compact />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const secondaryBtn =
  "inline-flex h-8 items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--accent-soft)]";

export function App() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const { sourceFilter, category, onlyNew, view, hideNonDeal } = filters;
  const patchFilters = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));
  const [showBackTop, setShowBackTop] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const autoRefreshed = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  // 记住筛选条件（搜索词不记）
  useEffect(() => {
    try {
      window.localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    } catch {
      /* 存储不可用时忽略 */
    }
  }, [filters]);

  // 提示条 3.5 秒后自动消失
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({}),
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshDeals({}),
    onSuccess: (data) => {
      queryClient.setQueryData(["dashboard"], data);
      setToast({
        ok: true,
        text: data.stats.newCount > 0 ? `抓取完成，新增 ${data.stats.newCount} 条` : "抓取完成，暂无新增",
      });
    },
    onError: () => setToast({ ok: false, text: "本轮刷新失败，请稍后再试" }),
  });

  // 乐观更新：点击立即生效，失败回滚
  const toggle = useMutation({
    mutationFn: (args: { id: number; field: "claimed" | "favorite"; value: boolean }) =>
      api.setDealState(args),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard"] });
      const prev = queryClient.getQueryData<Dashboard>(["dashboard"]);
      if (prev) {
        queryClient.setQueryData<Dashboard>(["dashboard"], {
          ...prev,
          deals: prev.deals.map((d) => (d.id === args.id ? { ...d, [args.field]: args.value } : d)),
        });
      }
      return { prev };
    },
    onError: (_e, _a, c) => {
      if (c?.prev) queryClient.setQueryData(["dashboard"], c.prev);
      setToast({ ok: false, text: "保存失败，已恢复原状态" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });

  const testPush = useMutation({
    mutationFn: () => api.sendTestPush({}),
    onSuccess: (data) =>
      setToast({ ok: data.ok, text: data.ok ? "测试推送已发送，请查看微信" : data.message }),
    onError: () => setToast({ ok: false, text: "测试推送发送失败，请稍后再试" }),
  });

  // 推送来源开关（乐观更新）
  const [pushPanel, setPushPanel] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState(false);
  const setPushSource = useMutation({
    mutationFn: (args: { key: string; enabled: boolean }) => api.setPushSource(args),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard"] });
      const prev = queryClient.getQueryData<Dashboard>(["dashboard"]);
      if (prev) {
        queryClient.setQueryData<Dashboard>(["dashboard"], {
          ...prev,
          stats: {
            ...prev.stats,
            sources: prev.stats.sources.map((s) => (s.key === args.key ? { ...s, push: args.enabled } : s)),
          },
        });
      }
      return { prev };
    },
    onError: (_e, _a, c) => {
      if (c?.prev) queryClient.setQueryData(["dashboard"], c.prev);
      setToast({ ok: false, text: "保存失败，已恢复原状态" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });

  // 首次打开且库里还没有任何一轮抓取时，自动抓一轮。
  useEffect(() => {
    if (dashboard.data && dashboard.data.stats.lastRunAt == null && !autoRefreshed.current && !refresh.isPending) {
      autoRefreshed.current = true;
      refresh.mutate();
    }
  }, [dashboard.data, refresh]);

  // 快捷键：/ 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 回到顶部：滚动容器可能是 window，也可能是外壳内层容器。
  // scroll 事件不冒泡，但 document 捕获阶段能收到任意元素的滚动，直接从 target 读。
  useEffect(() => {
    let ticking = false;
    const onScroll = (e: Event) => {
      if (ticking) return;
      ticking = true;
      const t = e.target;
      window.requestAnimationFrame(() => {
        ticking = false;
        let y: number;
        let vh: number;
        if (t instanceof HTMLElement && t !== document.documentElement) {
          if (t.scrollHeight <= t.clientHeight + 4) return;
          scrollerRef.current = t;
          y = t.scrollTop;
          vh = t.clientHeight;
        } else {
          scrollerRef.current = null;
          y = window.scrollY;
          vh = window.innerHeight;
        }
        setShowBackTop(y > vh * 0.9);
      });
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  const scrollToTop = () => {
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    (scrollerRef.current ?? window).scrollTo({ top: 0, behavior });
  };

  const stats = dashboard.data?.stats;
  const allDeals = useMemo(() => dashboard.data?.deals ?? [], [dashboard.data]);
  const hasRun = stats?.lastRunAt != null;
  const errorBySource = useMemo(
    () => new Map((stats?.errors ?? []).map((e) => [e.source, e.error])),
    [stats],
  );

  const q = search.trim().toLowerCase();

  // 先按搜索/来源/仅新增过滤，再统计各类别条数（显示在类别按钮上）
  const { baseList, categoryCounts } = useMemo(() => {
    const baseList = allDeals.filter(
      (d) =>
        (!q || d.title.toLowerCase().includes(q) || d.summary.toLowerCase().includes(q)) &&
        (!sourceFilter || d.source === sourceFilter) &&
        (!onlyNew || d.isNew),
    );
    const categoryCounts = new Map<string, number>([
      ["全部", hideNonDeal ? baseList.filter((d) => !NON_DEAL.has(d.category)).length : baseList.length],
      ["我的收藏", baseList.filter((d) => d.favorite).length],
    ]);
    for (const d of baseList) categoryCounts.set(d.category, (categoryCounts.get(d.category) ?? 0) + 1);
    return { baseList, categoryCounts };
  }, [allDeals, q, sourceFilter, onlyNew, hideNonDeal]);

  const filtered = useMemo(() => {
    const list = baseList.filter((d) =>
      category === "我的收藏"
        ? d.favorite
        : category === "全部"
          ? !(hideNonDeal && NON_DEAL.has(d.category))
          : d.category === category,
    );
    // 已领的沉底，其余保持服务端的新鲜度排序。
    const byPublished = [...list].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return [...byPublished.filter((d) => !d.claimed), ...byPublished.filter((d) => d.claimed)];
  }, [baseList, category, hideNonDeal]);

  const filtersActive = q !== "" || sourceFilter != null || category !== "全部" || onlyNew;
  const clearFilters = () => {
    setSearch("");
    setFilters({ ...DEFAULT_FILTERS, view });
  };

  // 排行榜：当前筛选下已有 AI 分的条目，按分数高→低，取前 50
  const ranked = useMemo(
    () =>
      filtered
        .filter((d) => d.aiScore != null)
        .sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0))
        .slice(0, 50),
    [filtered],
  );
  const unscoredInView = filtered.some((d) => d.aiScore == null);

  const scoreNow = useMutation({
    mutationFn: () => api.scoreDeals({}),
    onSuccess: (data) => {
      queryClient.setQueryData(["dashboard"], data);
      setToast({
        ok: true,
        text: data.stats.aiPending > 0 ? `已评分，还剩 ${data.stats.aiPending} 条待评` : "AI 评分完成",
      });
    },
    onError: () => setToast({ ok: false, text: "AI 评分失败，请稍后再试" }),
  });

  const refreshing = refresh.isPending;
  const newCount = stats?.newCount ?? 0;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-24 lg:max-w-5xl">
        {/* 标题、操作与概况（可滚走） */}
        <header className="pt-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)] sm:text-3xl">每日优惠情报</h1>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={testPush.isPending}
                onClick={() => testPush.mutate()}
                title="发送一条微信测试推送"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium text-[var(--dim)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-50"
              >
                {testPush.isPending && <Spinner />}
                测试推送
              </button>
              <button
                type="button"
                aria-expanded={pushPanel}
                onClick={() => setPushPanel((v) => !v)}
                title="选择哪些网站的优惠推送到微信"
                className={`inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] ${pushPanel ? "bg-[var(--accent-soft)] text-[var(--text)]" : "text-[var(--dim)]"}`}
              >
                推送来源
              </button>
              <button
                type="button"
                aria-expanded={settingsPanel}
                onClick={() => setSettingsPanel((v) => !v)}
                title="填写推送 / AI 等密钥"
                className={`inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] ${settingsPanel ? "bg-[var(--accent-soft)] text-[var(--text)]" : "text-[var(--dim)]"}`}
              >
                设置
              </button>
              <button
                type="button"
                disabled={refreshing}
                onClick={() => refresh.mutate()}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] shadow transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
              >
                {refreshing && <Spinner />}
                {refreshing ? "抓取中…" : "立即刷新"}
              </button>
            </div>
          </div>

          <p className="mt-2 text-sm text-[var(--dim)]">
            {!hasRun || stats == null ? (
              refreshing ? "首次抓取中，约需十几秒…" : "尚未抓取 · 点「立即刷新」获取最新优惠"
            ) : (
              <>
                更新于 {fmtTime(stats.lastRunAt!)} · {stats.okSources}/{stats.totalSources} 来源正常 · 在架 {stats.onShelf} 条 ·{" "}
                {newCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => patchFilters({ onlyNew: !onlyNew })}
                    title="点击切换「仅看本轮新增」"
                    className="font-semibold text-[var(--text)] underline decoration-dotted underline-offset-4 hover:decoration-solid"
                  >
                    本轮新增 {newCount} 条
                  </button>
                ) : (
                  "本轮无新增"
                )}
              </>
            )}
          </p>

          {settingsPanel && <SettingsPanel onToast={setToast} />}

          {pushPanel && stats != null && (
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-[var(--text)]">微信推送哪些网站</p>
                <span className="text-xs text-[var(--dim)]">
                  已选 {stats.sources.filter((s) => s.push).length}/{stats.sources.length} · 只影响推送，不影响页面展示
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {stats.sources.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    role="switch"
                    aria-checked={s.push}
                    onClick={() => setPushSource.mutate({ key: s.key, enabled: !s.push })}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
                      s.push
                        ? "border-transparent bg-[var(--accent)] text-[var(--accent-foreground)]"
                        : "border-[var(--border)] text-[var(--dim)] line-through decoration-1 hover:text-[var(--text)]"
                    }`}
                  >
                    <SourceLogo source={s.name} size={14} />
                    {s.push ? "✓ " : ""}
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 来源：健康状态 + 在架数，同时就是来源筛选（原来的状态行与来源筛选合并） */}
          {stats != null && stats.sources.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="按来源筛选">
              {stats.sources.map((s) => {
                const active = sourceFilter === s.name;
                const err = errorBySource.get(s.name);
                return (
                  <button
                    key={s.name}
                    type="button"
                    aria-pressed={active}
                    title={s.ok ? `只看 ${s.name}` : `抓取异常：${err ?? "未知错误"}`}
                    onClick={() => patchFilters({ sourceFilter: active ? null : s.name })}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
                      active
                        ? "border-transparent bg-[var(--accent)] text-[var(--accent-foreground)]"
                        : s.ok
                          ? "border-[var(--border)] bg-[var(--surface)] text-[var(--dim)] hover:text-[var(--text)]"
                          : "border-[var(--destructive)] bg-[var(--surface)] text-[var(--destructive)]"
                    }`}
                  >
                    <SourceLogo source={s.name} size={14} />
                    <span>{s.name}</span>
                    <span className="tabular-nums opacity-80">{s.ok ? s.count : "异常"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </header>

        {/* 粘性工具栏：只放搜索 + 类别，保持紧凑 */}
        <div className="sticky top-0 z-30 -mx-4 mt-4 border-b border-[var(--border)] px-4 pb-2 pt-3 backdrop-blur-md [background-color:color-mix(in_srgb,var(--bg)_92%,transparent)]">
          <div className="mb-2.5 flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-[var(--surface-alt)] p-0.5" role="tablist" aria-label="视图">
              {(
                [
                  ["list", "全部优惠"],
                  ["rank", "AI 排行榜"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => patchFilters({ view: v })}
                  className={`h-7 rounded-md px-3 text-[13px] font-medium transition-colors ${
                    view === v
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                      : "text-[var(--dim)] hover:text-[var(--text)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {stats?.aiEnabled && stats.aiPending > 0 && (
              <button
                type="button"
                disabled={scoreNow.isPending || refreshing}
                onClick={() => scoreNow.mutate()}
                className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--dim)] hover:bg-[var(--accent-soft)] hover:text-[var(--text)] disabled:opacity-50"
              >
                {scoreNow.isPending && <Spinner />}
                {stats.aiPending} 条待 AI 评分
              </button>
            )}
          </div>
          <div className="relative">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--dim)]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              inputMode="search"
              enterKeyHint="search"
              aria-label="搜索优惠"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch("");
                  e.currentTarget.blur();
                }
              }}
              placeholder="搜标题或简介，如 会员 / 网盘 / 喜加一"
              className="flex h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] py-2 pl-9 pr-9 text-base text-[var(--text)] shadow-sm transition-colors placeholder:text-[var(--dim)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-1 focus:ring-offset-[var(--bg)]"
            />
            {search ? (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setSearch("");
                  searchRef.current?.focus();
                }}
                className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--dim)] hover:bg-[var(--accent-soft)] hover:text-[var(--text)]"
              >
                ✕
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-[var(--border)] px-1.5 text-[11px] text-[var(--dim)] sm:block">
                /
              </kbd>
            )}
          </div>

          {/* 类别：手机横滑一行，桌面换行；按钮带条数 */}
          <div className="-mx-4 mt-2.5 flex items-center gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
            {CATEGORIES.map((c) => {
              const n = categoryCounts.get(c) ?? 0;
              if (n === 0 && c !== category && c !== "全部" && c !== "我的收藏") return null;
              return (
                <Chip key={c} label={`类别：${c}`} active={category === c} onClick={() => patchFilters({ category: c })}>
                  {c}
                  <span className={`tabular-nums ${n === 0 ? "opacity-40" : "opacity-60"}`}>{n}</span>
                </Chip>
              );
            })}
            <Chip label="只看本轮新增" active={onlyNew} onClick={() => patchFilters({ onlyNew: !onlyNew })}>
              仅新增
            </Chip>
          </div>

          {/* 当前结果与筛选摘要 */}
          <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 text-xs text-[var(--dim)]" aria-live="polite">
            <span>
              共 <span className="font-semibold tabular-nums text-[var(--text)]">{filtered.length}</span> 条
            </span>
            {sourceFilter && (
              <button
                type="button"
                onClick={() => patchFilters({ sourceFilter: null })}
                className="inline-flex items-center gap-1 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[var(--text)]"
              >
                来源：{sourceFilter} ✕
              </button>
            )}
            {category === "全部" && (
              <button
                type="button"
                onClick={() => patchFilters({ hideNonDeal: !hideNonDeal })}
                className="rounded px-1 underline decoration-dotted underline-offset-2 hover:text-[var(--text)]"
              >
                {hideNonDeal
                  ? `已隐藏讨论/交易帖 ${baseList.filter((d) => NON_DEAL.has(d.category)).length} 条，显示`
                  : "隐藏讨论/交易帖"}
              </button>
            )}
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="ml-auto font-medium text-[var(--text)] underline underline-offset-2">
                清除筛选
              </button>
            )}
          </div>
        </div>

        {/* 列表：手机单列，≥1024px 双列 */}
        <section className="mt-4" aria-label="优惠列表" aria-busy={dashboard.isPending || refreshing}>
          {dashboard.isPending || (!hasRun && refreshing) ? (
            <SkeletonList />
          ) : dashboard.isError ? (
            <div className="py-12 text-center">
              <p className="text-sm text-[var(--destructive)]">加载失败：{dashboard.error.message}</p>
              <button type="button" onClick={() => dashboard.refetch()} className={`mt-3 ${secondaryBtn}`}>
                重试
              </button>
            </div>
          ) : view === "rank" ? (
            !stats?.aiEnabled ? (
              <p className="py-12 text-center text-sm text-[var(--dim)]">
                AI 排行榜未开启：点右上角「设置」填写 OpenRouter Key（免费）即可，无需重启。
              </p>
            ) : ranked.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm text-[var(--dim)]">
                  {filtered.length === 0 ? "没有符合当前筛选的优惠。" : "这些优惠还没有 AI 评分。"}
                </p>
                {filtered.length > 0 && (
                  <button
                    type="button"
                    onClick={() => scoreNow.mutate()}
                    disabled={scoreNow.isPending}
                    className={`mt-3 ${secondaryBtn}`}
                  >
                    {scoreNow.isPending ? "评分中…" : "立即 AI 评分"}
                  </button>
                )}
              </div>
            ) : (
              <>
                <p className="mb-2 text-xs text-[var(--dim)]">
                  按 AI 价值分排序，前 {ranked.length} 条{unscoredInView ? " · 部分条目尚未评分" : ""}
                </p>
                <Leaderboard deals={ranked} onToggle={(id, field, value) => toggle.mutate({ id, field, value })} />
              </>
            )
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-[var(--dim)]">
                {allDeals.length === 0
                  ? "暂无在架优惠，点「立即刷新」抓取一轮。"
                  : category === "我的收藏" && !q
                    ? "还没有收藏，点卡片上的「☆ 收藏」把想留着的优惠存起来。"
                    : "没有符合当前筛选的优惠。"}
              </p>
              {filtersActive && allDeals.length > 0 && (
                <button type="button" onClick={clearFilters} className={`mt-3 ${secondaryBtn}`}>
                  清除全部筛选
                </button>
              )}
            </div>
          ) : (
            <div
              className={`grid grid-cols-1 gap-3 transition-opacity lg:grid-cols-2 ${refreshing ? "opacity-70" : ""}`}
            >
              {filtered.map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  onToggle={(id, field, value) => toggle.mutate({ id, field, value })}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {/* 提示条：自动消失 */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-6 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ${
            toast.ok ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-[var(--destructive)] text-white"
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* 回到顶部 */}
      {showBackTop && (
        <button
          type="button"
          aria-label="回到顶部"
          onClick={scrollToTop}
          className="fixed bottom-6 right-4 z-40 inline-flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-lg transition-all hover:bg-[var(--accent-soft)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2 focus:ring-offset-[var(--bg)] lg:right-6"
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
