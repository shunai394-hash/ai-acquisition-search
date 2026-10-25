export const NETWORKS = ["tiktok", "instagram", "facebook", "youtube", "x", "linkedin"] as const;
export type Network = (typeof NETWORKS)[number];
export type AssetKind = "video" | "image" | "text";
export type JobMode = "immediate" | "scheduled" | "approval" | "autopilot";

export const STALE_LOCK_MS = 15 * 60 * 1000;
export const MAX_AUTO_ATTEMPTS = 5;
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RULE = {
  timezone: "Asia/Tokyo",
  maxPerDay: 10,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  windowStart: "00:00",
  windowEnd: "23:59",
  paused: false,
};

export type PostingRule = typeof DEFAULT_RULE;

export type NetworkCapability = {
  network: Network;
  label: string;
  executable: boolean;
  formats: AssetKind[];
  reason: string | null;
};

/**
 * Per-user posting is enabled only where this app has a user OAuth connection
 * and an official publish call. Global app tokens are not used for the queue,
 * because they would publish as the operator account rather than the user's.
 */
export const NETWORK_CAPABILITIES: NetworkCapability[] = [
  {
    network: "tiktok",
    label: "TikTok",
    executable: true,
    formats: ["video", "image"],
    reason: "動画は公式Content Posting API（FILE_UPLOAD）で投稿します。画像はPULL_FROM_URLのみのため、TikTok側で配信ドメインの所有確認が必要です。未審査アプリは自分のみ公開（SELF_ONLY）に制限されます。",
  },
  {
    network: "instagram",
    label: "Instagram",
    executable: false,
    formats: [],
    reason: "ユーザーごとの公式OAuthが未接続です。アプリ共通トークンでは投稿しません。",
  },
  {
    network: "facebook",
    label: "Facebook",
    executable: false,
    formats: [],
    reason: "ユーザーごとの公式OAuthが未接続です。アプリ共通トークンでは投稿しません。",
  },
  {
    network: "youtube",
    label: "YouTube",
    executable: false,
    formats: [],
    reason: "ユーザーごとの公式OAuthが未接続です。アプリ共通トークンでは投稿しません。",
  },
  {
    network: "x",
    label: "X",
    executable: false,
    formats: [],
    reason: "ユーザーごとの公式OAuthが未接続です。アプリ共通トークンでは投稿しません。",
  },
  {
    network: "linkedin",
    label: "LinkedIn",
    executable: false,
    formats: [],
    reason: "既存のLinkedIn接続は別画面の単発投稿です。この自動投稿キューにはまだ接続していません。",
  },
];

export function networkCapability(network: string) {
  return NETWORK_CAPABILITIES.find((item) => item.network === network) ?? null;
}

export function captionLimit(network: string, kind: AssetKind) {
  if (network === "tiktok" && kind === "image") return 4000;
  if (network === "tiktok") return 2200;
  if (network === "x") return 280;
  if (network === "youtube") return 100;
  if (network === "linkedin") return 3000;
  if (network === "instagram") return 2200;
  return 2000;
}

export function normalizeHashtag(value: string) {
  return value.replace(/^#+/, "").trim();
}

export function composeCaption(caption: string, hashtags: string[]) {
  const tags = hashtags.map(normalizeHashtag).filter(Boolean).map((tag) => "#" + tag);
  return [caption.trim(), tags.join(" ")].filter(Boolean).join("\n");
}

export function normalizeCaption(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function redactError(message: string) {
  return message
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/access_token[=:]\s*\S+/gi, "access_token=[redacted]")
    .replace(/refresh_token[=:]\s*\S+/gi, "refresh_token=[redacted]")
    .replace(/https?:\/\/[^\s]+/g, (url) => {
      const [base] = url.split("?");
      return url.includes("?") ? base + "?[redacted]" : base;
    })
    .slice(0, 500);
}

export type ErrorClass = "reauth" | "safe_retry" | "uncertain" | "terminal";

export function classifyPublishError(message: string): ErrorClass {
  const text = message.toLowerCase();
  if (/access token|refresh token|token refresh|unauthorized|unauthorised|invalid_grant|invalid scope|\bscope\b|reauth|アクセストークン|再接続|接続してください|login kit/.test(text)) {
    return "reauth";
  }
  if (/timeout|timed out|aborterror|econnreset|socket hang|fetch failed|network error|ネットワーク/.test(text)) {
    return "uncertain";
  }
  if (/\b429\b|rate limit|rate_limit_exceeded|too many requests|\b50[234]\b|temporarily unavailable|一時的/.test(text)) {
    return "safe_retry";
  }
  return "terminal";
}

export function backoffMs(attempt: number) {
  const step = Math.min(Math.max(attempt, 1), 6);
  return Math.min(60 * 60 * 1000, 60_000 * 2 ** (step - 1));
}

export function isValidTimeZone(timeZone: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) map[part.type] = part.value;
  return {
    weekday: WEEKDAYS[map.weekday] ?? 0,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function localDateKey(date: Date, timeZone: string) {
  const part = zonedParts(date, timeZone);
  return `${part.year}-${String(part.month).padStart(2, "0")}-${String(part.day).padStart(2, "0")}`;
}

function clockMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function isInsideWindow(now: Date, rule: PostingRule) {
  if (rule.paused) return false;
  if (!rule.weekdays.includes(zonedParts(now, rule.timezone).weekday)) return false;
  const start = clockMinutes(rule.windowStart);
  const end = clockMinutes(rule.windowEnd);
  if (start == null || end == null) return false;
  const part = zonedParts(now, rule.timezone);
  const current = part.hour * 60 + part.minute;
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

export function nextOpenInstant(now: Date, rule: PostingRule) {
  if (rule.paused) return null;
  if (isInsideWindow(now, rule)) return now;
  for (let step = 1; step <= 8 * 24 * 4; step++) {
    const candidate = new Date(now.getTime() + step * 15 * 60 * 1000);
    if (isInsideWindow(candidate, rule)) return candidate;
  }
  return null;
}

export function zonedLocalToUtc(local: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match || !isValidTimeZone(timeZone)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const shown = zonedParts(utcGuess, timeZone);
  const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
  const corrected = new Date(utcGuess.getTime() - (shownUtc - utcGuess.getTime()));
  const check = zonedParts(corrected, timeZone);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) {
    return null;
  }
  return corrected;
}

export type RecentJob = {
  id?: string;
  assetId: string;
  network: string;
  caption: string;
  status: string;
  scheduledAt: string;
};

const ACTIVE_DUPLICATE = new Set(["awaiting_approval", "queued", "paused", "processing", "pending", "published"]);

export function findDuplicate(input: {
  assetId: string;
  network: string;
  caption: string;
  now: Date;
  recent: RecentJob[];
}) {
  const captionKey = normalizeCaption(input.caption);
  const cutoff = input.now.getTime() - DUPLICATE_WINDOW_MS;
  return input.recent.find((job) => {
    if (job.network !== input.network || !ACTIVE_DUPLICATE.has(job.status)) return false;
    const when = Date.parse(job.scheduledAt);
    if (!Number.isFinite(when) || when < cutoff) return false;
    return job.assetId === input.assetId || normalizeCaption(job.caption) === captionKey;
  }) ?? null;
}

export function initialStatus(mode: JobMode) {
  return mode === "approval" ? "awaiting_approval" : "queued";
}

export function manualRetryPolicy(job: {
  status: string;
  publish_accepted_at?: string | null;
  metadata?: { retry_safety?: string } | null;
}) {
  if (job.publish_accepted_at) {
    return {
      allowed: false,
      confirm: false,
      reason: "外部APIがすでに受け付けています。再投稿すると二重投稿になるため再試行できません。",
    };
  }
  if (!["failed", "needs_reauth"].includes(job.status)) {
    return { allowed: false, confirm: false, reason: "この状態では再試行できません。" };
  }
  if (job.metadata?.retry_safety === "confirm_no_duplicate") {
    return {
      allowed: true,
      confirm: true,
      reason: "通信が途中で切れた可能性があります。TikTok側に同じ動画が無いことを確認してから再試行してください。",
    };
  }
  return { allowed: true, confirm: false, reason: "外部APIは受け付けていません。再試行できます。" };
}

export function parseRule(row: Partial<{
  timezone: string;
  max_per_day: number;
  weekdays: number[];
  window_start: string;
  window_end: string;
  paused: boolean;
}> | null): PostingRule {
  if (!row) return { ...DEFAULT_RULE, weekdays: [...DEFAULT_RULE.weekdays] };
  const timezone = typeof row.timezone === "string" && isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_RULE.timezone;
  const maxPerDay = typeof row.max_per_day === "number" && row.max_per_day >= 1 && row.max_per_day <= 50
    ? row.max_per_day
    : DEFAULT_RULE.maxPerDay;
  const weekdays = Array.isArray(row.weekdays)
    ? row.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [...DEFAULT_RULE.weekdays];
  return {
    timezone,
    maxPerDay,
    weekdays: weekdays.length ? weekdays : [...DEFAULT_RULE.weekdays],
    windowStart: clockMinutes(String(row.window_start || "")) != null ? String(row.window_start) : DEFAULT_RULE.windowStart,
    windowEnd: clockMinutes(String(row.window_end || "")) != null ? String(row.window_end) : DEFAULT_RULE.windowEnd,
    paused: row.paused === true,
  };
}

export type SuggestionInput = {
  caption: string;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  metricsStatus: "available" | "unavailable" | "not_fetched" | "scope_missing";
};

export function performanceSuggestions(posts: SuggestionInput[], timeZone: string) {
  const measured = posts.filter((post) => post.metricsStatus === "available" && typeof post.views === "number");
  if (!measured.length) {
    return ["取得済みの再生数がないため、投稿時間や内容の推奨は出していません。未取得の指標は0として扱いません。"];
  }
  const best = [...measured].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];
  const when = best.publishedAt ? zonedParts(new Date(best.publishedAt), timeZone) : null;
  const hour = when ? `${String(when.hour).padStart(2, "0")}:00台` : "投稿時刻不明";
  const preview = best.caption.trim().slice(0, 40);
  return [
    `取得できた再生数では、${hour}の投稿（「${preview}」）が最も多いです。次回の予約時刻の候補にしてください。自動では変更しません。`,
  ];
}
