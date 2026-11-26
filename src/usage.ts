import { readJSON, redactText } from "./security.ts";
import { createRuntimeState, managementScope } from "./state.ts";
import type {
  ApiCallFn,
  CPACredential,
  FetchLike,
  PassiveReading,
  PluginAuth,
  PluginRuntimeState,
  ResetCard,
  UsageAdapter,
  UsageReading,
  UsageResets,
  UsageResult,
  UsageWindow,
} from "./types.ts";
import { managementBase } from "./url.ts";

const READ_TTL_MS = 300_000;
const INVENTORY_TTL_MS = 1_800_000;
const SIGNAL_MAX_AGE_MS = 300_000;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_HEADER: Record<string, string> = {
  Authorization: "Bearer $TOKEN$",
  "anthropic-beta": "oauth-2025-04-20",
  "User-Agent": "claude-cli/2.1.280 (external, cli)",
  Accept: "application/json",
};
const CLAUDE_GRANT_ID = /^[a-z0-9_-]{1,40}$/;

function managementHeaders(managementKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${managementKey}`,
    "Content-Type": "application/json",
  };
}

class UsageError extends Error {
  permanent: boolean;
  stale: boolean;
  upstreamStatus?: number;
  retryAfter?: number;

  constructor(message: string, { permanent = false, stale = true }: { permanent?: boolean; stale?: boolean } = {}) {
    super(message);
    this.permanent = permanent;
    this.stale = stale;
  }
}

function within<T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

function optionalTime(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function usageWindows(data: unknown): UsageWindow[] {
  const record = data as Record<string, { utilization?: unknown; resets_at?: unknown } | undefined> | null;
  const windows: UsageWindow[] = [];
  for (const [key, name, span] of [
    ["five_hour", "5 hours", 18000],
    ["seven_day", "7 days", 604800],
  ] as const) {
    const row = record?.[key];
    const used = row?.utilization;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
    const window: UsageWindow = { name, used, span };
    if (row?.resets_at === null && used === 0) {
      // A window which has not started has no reset time yet.
    } else {
      const reset = typeof row?.resets_at === "string" ? Date.parse(row.resets_at) : NaN;
      if (!Number.isFinite(reset)) continue;
      window.resetsAt = new Date(reset).toISOString();
    }
    windows.push(window);
  }
  if (!windows.length) {
    throw new UsageError("CPA 未返回有效的配额窗口，请检查所选凭据");
  }
  return windows;
}

// Claude usage-limit reset grants ("Reset for free" in Claude Settings > Usage), read from the
// opt-in `cedar_ember` block of the same usage response. Display only: grants are never claimed.
function claudeResets(block: unknown, now: number): UsageResets | undefined {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
  const obj = block as { eligible?: unknown; grants?: unknown };
  if (typeof obj.eligible !== "boolean") return undefined;
  const grants = obj.grants ?? [];
  if (!Array.isArray(grants)) return undefined;

  const each: ResetCard[] = [];
  const seen = new Set<string>();
  for (const item of grants) {
    if (item === null || typeof item !== "object") return undefined;
    const grant = item as {
      id?: unknown;
      resets_left?: unknown;
      resets_total?: unknown;
      ends_at?: unknown;
      starts_at?: unknown;
      type?: unknown;
    };
    const { id, resets_left: left, resets_total: total } = grant;
    if (typeof id !== "string" || !CLAUDE_GRANT_ID.test(id) || seen.has(id)) return undefined;
    seen.add(id);
    if (!Number.isInteger(left) || (left as number) < 0 || (left as number) > 100) return undefined;
    if (total !== undefined && (!Number.isInteger(total) || (total as number) < (left as number))) return undefined;
    const until = optionalTime(grant.ends_at);
    if (until === undefined || optionalTime(grant.starts_at) === undefined) return undefined;
    if (!left || (until && Date.parse(until) <= now)) continue;
    const window: ResetCard["window"] =
      grant.type === "session" ? "fiveHour" : grant.type === "weekly" ? "weekly" : undefined;
    for (let i = 0; i < (left as number); i++) {
      const card: ResetCard = {};
      if (until) card.until = until;
      if (window) card.window = window;
      each.push(card);
    }
  }
  if (!each.length) return undefined;
  each.sort((a, b) =>
    a.until === b.until ? 0 : a.until === undefined ? 1 : b.until === undefined ? -1 : a.until < b.until ? -1 : 1,
  );
  const resets: UsageResets = { count: each.length, each };
  if (each[0].until) resets.until = each[0].until;
  return resets;
}

async function readClaudeUsage(
  apiCall: ApiCallFn,
  _credential: CPACredential,
  { now, memo = {} }: { now: number; memo?: Record<string, unknown> },
): Promise<UsageReading> {
  const plain = () => apiCall({ method: "GET", url: CLAUDE_USAGE_URL, header: CLAUDE_USAGE_HEADER });
  let data: unknown;
  let inventory = !(typeof memo.plainUntil === "number" && memo.plainUntil > now);
  if (!inventory) {
    data = await plain();
  } else {
    try {
      data = await apiCall({ method: "GET", url: `${CLAUDE_USAGE_URL}?cedar_ember=1`, header: CLAUDE_USAGE_HEADER });
    } catch (error) {
      const status = (error as { upstreamStatus?: number } | undefined)?.upstreamStatus;
      if (status !== 400 && status !== 403) throw error;
      data = await plain();
      memo.plainUntil = now + 86_400_000;
      inventory = false;
    }
  }
  const reading: UsageReading = { windows: usageWindows(data), inventory };
  const resets = claudeResets((data as { cedar_ember?: unknown } | null)?.cedar_ember, now);
  if (resets) reading.resets = resets;
  return reading;
}

function claudeSignalWindows(credential: CPACredential, now: number): PassiveReading | undefined {
  const quota = credential?.quota;
  const observedAt = typeof quota?.observed_at === "string" ? Date.parse(quota.observed_at) : NaN;
  if (!Number.isFinite(observedAt) || now - observedAt > SIGNAL_MAX_AGE_MS || observedAt - now > 60_000) {
    return undefined;
  }
  if (quota?.signals === null || typeof quota?.signals !== "object") return undefined;

  const signals = new Map<string, string>();
  for (const [key, value] of Object.entries(quota.signals)) {
    if (typeof value === "string") signals.set(key.toLowerCase(), value.trim());
  }

  const windows: UsageWindow[] = [];
  for (const [key, name, span] of [
    ["5h", "5 hours", 18000],
    ["7d", "7 days", 604800],
  ] as const) {
    const used = signals.get(`anthropic-ratelimit-unified-${key}-utilization`) ?? "";
    const reset = signals.get(`anthropic-ratelimit-unified-${key}-reset`) ?? "";
    if (!/^\d{1,6}(\.\d{1,9})?$/.test(used) || !/^\d{1,12}(\.\d{1,9})?$/.test(reset)) return undefined;
    const resetsAt = Math.round(Number(reset) * 1000);
    if (resetsAt <= now || resetsAt > 8.64e15) return undefined;
    windows.push({
      name,
      used: Math.round(Number(used) * 10_000) / 100,
      span,
      resetsAt: new Date(resetsAt).toISOString(),
    });
  }
  return { windows, observedAt };
}

function codexPlan(value: unknown): string | undefined {
  return typeof value === "string" &&
    ["free", "go", "plus", "pro", "team", "business", "enterprise", "edu"].includes(value)
    ? value
    : undefined;
}

interface CodexRateLimitRow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

function codexWindows(data: unknown, now = Date.now()): UsageWindow[] {
  const rateLimit = (data as { rate_limit?: { primary_window?: unknown; secondary_window?: unknown } } | null)
    ?.rate_limit;
  const windows: UsageWindow[] = [];
  for (const item of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    const row = item as CodexRateLimitRow | undefined;
    if (
      typeof row?.used_percent !== "number" ||
      !Number.isFinite(row.used_percent) ||
      row.used_percent < 0 ||
      row.used_percent > 100 ||
      !Number.isSafeInteger(row.limit_window_seconds) ||
      (row.limit_window_seconds as number) <= 0
    ) {
      continue;
    }

    let reset = row.reset_at;
    if (reset == null && row.reset_after_seconds != null) {
      const after = row.reset_after_seconds;
      if (typeof after !== "number" || !Number.isFinite(after) || after < 0) continue;
      reset = now / 1000 + after;
    }
    if (
      reset != null &&
      (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0 || reset > 8.64e12)
    ) {
      continue;
    }

    const span = row.limit_window_seconds as number;
    const match = (
      [
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
        ["second", 1],
      ] as const
    ).find(([, seconds]) => span % seconds === 0)!;
    const [unit, seconds] = match;
    const count = span / seconds;
    const window: UsageWindow = {
      name: `${count} ${unit}${count === 1 ? "" : "s"}`,
      used: row.used_percent,
      span,
    };
    if (reset != null) window.resetsAt = new Date((reset as number) * 1000).toISOString();
    windows.push(window);
  }
  if (!windows.length) throw new UsageError("CPA 未返回有效的 Codex 配额窗口");
  return windows;
}

function codexResets(block: unknown, now: number): UsageResets | undefined {
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const obj = block as { available_count?: unknown; credits?: unknown };
  const count = obj.available_count;
  if (!Number.isSafeInteger(count) || (count as number) <= 0) return undefined;
  const totalCount = count as number;

  const each: ResetCard[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(obj.credits) ? obj.credits : []) {
    const credit = item as { status?: unknown; reset_type?: unknown; id?: unknown; expires_at?: unknown } | null;
    if (credit?.status !== "available" || credit.reset_type !== "codex_rate_limits") continue;
    if (typeof credit.id !== "string" || !credit.id.trim() || seen.has(credit.id)) return undefined;
    seen.add(credit.id);
    const until = optionalTime(credit.expires_at);
    if (!until || Date.parse(until) <= now) continue;
    each.push({ until });
  }
  each.sort((a, b) => (a.until ?? "").localeCompare(b.until ?? ""));
  return {
    count: totalCount,
    byWindow: false,
    ...(each[0] ? { until: each[0].until } : {}),
    ...(each.length === totalCount ? { each } : {}),
  };
}

async function readCodexUsage(
  apiCall: ApiCallFn,
  credential: CPACredential,
  { now, memo, passive }: { now: number; memo: Record<string, unknown>; passive?: PassiveReading },
): Promise<UsageReading> {
  const header: Record<string, string> = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
  };
  const accountId = credential.id_token?.chatgpt_account_id;
  if (typeof accountId === "string" && accountId.trim() && !/[\r\n]/.test(accountId)) {
    header["Chatgpt-Account-Id"] = accountId.trim();
  }

  const data = passive
    ? undefined
    : ((await apiCall({
        method: "GET",
        url: "https://chatgpt.com/backend-api/wham/usage",
        header,
      })) as { rate_limit_reset_credits?: unknown; plan_type?: unknown } | undefined);

  const windows = passive?.windows ?? codexWindows(data, now);
  const inventoryAt = typeof memo.inventoryAt === "number" ? memo.inventoryAt : undefined;
  if (data?.rate_limit_reset_credits != null || !(inventoryAt !== undefined && inventoryAt + INVENTORY_TTL_MS > now)) {
    memo.inventoryAt = now;
    memo.resets = undefined;
    try {
      const block =
        data?.rate_limit_reset_credits ??
        (await apiCall(
          {
            method: "GET",
            url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
            header: {
              ...header,
              Accept: "application/json",
              "OpenAI-Beta": "codex-1",
              Originator: "Codex Desktop",
            },
          },
          3_000,
        ));
      memo.resets = codexResets(block, now);
    } catch (error) {
      if ((error as { permanent?: boolean } | undefined)?.permanent) throw error;
    }
  }

  return {
    windows,
    plan: passive?.plan ?? codexPlan(data?.plan_type),
    resets: memo.resets as UsageResets | undefined,
    inventory: true,
    inventoryAt: memo.inventoryAt as number | undefined,
  };
}

function codexSignalWindows(credential: CPACredential, now: number): PassiveReading | undefined {
  const quota = credential?.quota;
  const observedAt = typeof quota?.observed_at === "string" ? Date.parse(quota.observed_at) : NaN;
  if (!Number.isFinite(observedAt) || now - observedAt > SIGNAL_MAX_AGE_MS || observedAt - now > 60_000) {
    return undefined;
  }
  if (quota?.signals === null || typeof quota?.signals !== "object") return undefined;

  const signals = new Map(
    Object.entries(quota.signals)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key.toLowerCase(), value.trim()]),
  );
  const readNum = (key: string) =>
    /^\d{1,12}(\.\d{1,9})?$/.test(signals.get(key) ?? "") ? Number(signals.get(key)) : NaN;

  const rate_limit: Record<string, CodexRateLimitRow> = {};
  for (const key of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${key}-`;
    const reset = readNum(`${prefix}reset-at`);
    const resetAfter = readNum(`${prefix}reset-after-seconds`);
    const reset_at = Number.isFinite(reset) ? reset : observedAt / 1000 + resetAfter;
    if (!Number.isFinite(reset_at) || reset_at * 1000 <= now) return undefined;
    rate_limit[`${key}_window`] = {
      used_percent: readNum(`${prefix}used-percent`),
      limit_window_seconds: readNum(`${prefix}window-minutes`) * 60,
      reset_at,
    };
  }

  try {
    const windows = codexWindows({ rate_limit }, now);
    if (windows.length !== 2) return undefined;
    return { windows, observedAt, plan: codexPlan(signals.get("x-codex-plan-type")) };
  } catch {
    return undefined;
  }
}

function credentialLabel(credential: CPACredential): string {
  const provider =
    credential.provider === "claude"
      ? "Claude"
      : credential.provider === "codex"
        ? "Codex"
        : credential.provider;
  const label = typeof credential.label === "string" ? credential.label.trim() : "";
  const safeSuffix = label && !/[@\x00-\x1f\x7f]/.test(label) ? label : String(credential.auth_index).slice(0, 8);
  return `${provider} ${safeSuffix}`;
}

export const usageAdapters: Record<string, UsageAdapter> = {
  claude: { read: readClaudeUsage, passive: claudeSignalWindows },
  codex: { read: readCodexUsage, passive: codexSignalWindows },
};

function liveResets(resets: UsageResets | undefined, now: number): UsageResets | undefined {
  if (!resets || !Array.isArray(resets.each)) return resets;
  const each = resets.each.filter(card => !card.until || Date.parse(card.until) > now);
  if (!each.length) return undefined;
  const { until: _until, ...rest } = resets;
  const live: UsageResets = { ...rest, count: each.length, each };
  if (each[0].until) live.until = each[0].until;
  return live;
}

function retryAfter(header: unknown, now: number): number | undefined {
  if (header === null || typeof header !== "object") return undefined;
  for (const [key, values] of Object.entries(header as Record<string, unknown>)) {
    if (key.toLowerCase() !== "retry-after") continue;
    const value = String(Array.isArray(values) ? values[0] : values).trim();
    const ms = /^\d{1,9}$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
  return undefined;
}

function upstreamDelay(error: unknown, failures: number): number {
  const backoff = Math.min(READ_TTL_MS * 2 ** Math.min(failures - 1, 4), 3_600_000);
  const retryAfterMs = (error as { retryAfter?: number } | undefined)?.retryAfter ?? 0;
  return Math.min(Math.max(backoff, retryAfterMs), 3_600_000);
}

function managementHttpErrorMessage(status: number): string {
  if (status === 401) {
    return "CPA 管理密钥无效或已拒绝访问（HTTP 401），已暂停自动查询；请检查密钥并重新登录";
  }
  if (status === 403) {
    return "CPA 管理接口拒绝访问（HTTP 403，可能未开启 allow-remote 或已触发 IP 封禁），已暂停自动查询；请修复 CPA 配置后重新登录";
  }
  if (status === 404) {
    return "CPA 管理接口路径不存在（HTTP 404），请确认 CPA 已开启管理接口并检查 Management URL";
  }
  return `CPA 管理接口请求失败（HTTP ${status}），请稍后重试`;
}

export interface CreateUsageOptions {
  request?: FetchLike;
  now?: () => number;
  timeout?: (ms: number) => AbortSignal;
  adapters?: Record<string, UsageAdapter>;
  state?: PluginRuntimeState;
  blocked?: Map<string, string>;
}

/**
 * Build Magpie's `auth.usage` hook with per-scope caching, concurrency caps, circuit breaker,
 * passive signal fast-path, and strict graceful degradation.
 */
export function createUsage({
  request = (...args) => fetch(...args),
  now = () => Date.now(),
  timeout = ms => AbortSignal.timeout(ms),
  adapters = usageAdapters,
  state = createRuntimeState(),
  blocked,
}: CreateUsageOptions = {}) {
  const blockedMap = blocked ?? state.blocked;
  const { cache, lists, upstream, activeReads } = state;

  const render = (entry: { value?: UsageResult; error?: string; updatedAt?: number }): UsageResult =>
    entry.value && (!entry.error || now() - (entry.updatedAt ?? 0) <= 900_000)
      ? entry.value
      : { error: entry.error, signIn: "kept" };

  return async (
    getAuth: () => PluginAuth | undefined | Promise<PluginAuth | undefined>,
  ): Promise<UsageResult> => {
    let secrets: readonly (string | undefined)[] = [];
    try {
      const startedAt = now();
      const signal = timeout(15_000);
      const auth = await within(Promise.resolve().then(getAuth), signal);
      const metadata = auth?.metadata;
      if (auth?.type !== "api" || !metadata?.managementKey) return {};
      if (typeof metadata.managementKey !== "string") {
        throw new UsageError("请检查 CPA 管理密钥配置");
      }

      const managementKey = metadata.managementKey;
      secrets = [auth.key, managementKey];

      const base = managementBase(metadata);
      const selection = metadata.credential ?? "";
      if (typeof selection !== "string") {
        throw new UsageError("请检查 CPA 凭据选择配置");
      }

      const scope = managementScope(base, managementKey);
      if (blockedMap.has(scope)) {
        return { error: blockedMap.get(scope), signIn: "kept" };
      }

      const modelRouting = metadata.modelRouting === "enabled";
      const passiveOnly = metadata.usageMode === "passive-only";
      const cacheKey = JSON.stringify([scope, selection, modelRouting, passiveOnly]);
      let entry = cache.get(cacheKey);
      if (!entry) {
        entry = {};
        cache.set(cacheKey, entry);
      }

      if (entry.pending) return await within(entry.pending, signal);
      if (
        (entry.value && now() - (entry.updatedAt ?? 0) < READ_TTL_MS) ||
        (entry.retryAt !== undefined && now() < entry.retryAt)
      ) {
        return render(entry);
      }

      const call = (path: string, maxBytes: number, body?: unknown, optionalMs?: number) => {
        if (optionalMs) {
          optionalMs = Math.min(optionalMs, 14_000 - (now() - startedAt));
          if (optionalMs <= 0) throw new UsageError("可选 CPA 重置卡查询预算已耗尽");
        }
        const requestSignal = optionalMs ? AbortSignal.any([signal, timeout(optionalMs)]) : signal;
        return within(
          (async () => {
            requestSignal.throwIfAborted();
            if (blockedMap.has(scope)) {
              throw new UsageError(blockedMap.get(scope)!, { permanent: true });
            }
            const response = await request(`${base}${path}`, {
              method: body === undefined ? "GET" : "POST",
              headers: managementHeaders(managementKey),
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              redirect: "error",
              signal: requestSignal,
            });
            if (response.status !== 200) {
              const permanent = response.status === 401 || response.status === 403;
              const message = managementHttpErrorMessage(response.status);
              if (permanent) blockedMap.set(scope, message);
              try {
                await response.body?.cancel();
              } catch {
                // Ignore stream cancellation error.
              }
              throw new UsageError(message, { permanent });
            }
            return readJSON(response, maxBytes);
          })(),
          requestSignal,
        );
      };

      const limited = async <T>(read: () => Promise<T>): Promise<T> => {
        let release!: () => void;
        const active = activeReads.get(scope) ?? new Set<Promise<void>>();
        activeReads.set(scope, active);
        while (active.size >= 2) await within(Promise.race(active), signal);
        signal.throwIfAborted();
        if (blockedMap.has(scope)) {
          throw new UsageError(blockedMap.get(scope)!, { permanent: true });
        }
        const slot = new Promise<void>(resolve => {
          release = resolve;
        });
        active.add(slot);
        try {
          return await read();
        } finally {
          active.delete(slot);
          release();
        }
      };

      const credentialList = (): Promise<CPACredential[]> => {
        let list = lists.get(scope);
        if (!list || now() - list.at >= 15_000) {
          list = {
            at: now(),
            files: call("/credentials", 1 << 20).then(payload => {
              const files = (payload as { files?: unknown } | null)?.files;
              if (!Array.isArray(files)) throw new UsageError("CPA 返回的凭据列表格式无效", { stale: false });
              return files as CPACredential[];
            }),
          };
          lists.set(scope, list);
          list.files.catch(() => {
            if (lists.get(scope) === list) lists.delete(scope);
          });
        }
        return within(list.files, signal);
      };

      const credentialReading = async (
        credential: CPACredential,
        adapter: UsageAdapter,
        apiCall: ApiCallFn,
      ): Promise<UsageReading> => {
        const upstreamKey = JSON.stringify([scope, credential.auth_index]);
        let credState = upstream.get(upstreamKey);
        if (!credState) {
          credState = { memo: {}, failures: 0, retryAt: 0 };
          upstream.set(upstreamKey, credState);
        }

        const t = now();
        const passive = adapter.passive?.(credential, t);
        const last = credState.reading;
        const age = last && credState.readAt !== undefined ? t - credState.readAt : Infinity;
        const inventoryAge = last ? t - (last.inventoryAt ?? credState.readAt ?? 0) : Infinity;

        const fromPassive = (): UsageReading => ({
          windows: passive!.windows,
          plan: passive!.plan ?? last?.plan,
          resets: inventoryAge < INVENTORY_TTL_MS ? liveResets(last?.resets, t) : undefined,
        });

        if (passiveOnly) {
          if (passive) return fromPassive();
          throw new UsageError("当前为仅被动信号模式，CPA 暂无近期推理配额信号", { stale: false });
        }

        if (age < READ_TTL_MS && last) {
          return passive && credState.readAt !== undefined && passive.observedAt > credState.readAt
            ? fromPassive()
            : { windows: last.windows, plan: last.plan, resets: liveResets(last.resets, t) };
        }

        if (
          passive &&
          (passive.inventory === false || (last && (!last.inventory || inventoryAge < INVENTORY_TTL_MS)))
        ) {
          return fromPassive();
        }

        if (!credState.pending && t < credState.retryAt) {
          if (passive) return fromPassive();
          throw credState.error;
        }

        credState.pending ??= (async () => {
          try {
            const reading = await limited(() =>
              adapter.read(apiCall, credential, {
                now: t,
                memo: credState.memo,
                passive: passive && { ...passive, plan: passive.plan ?? last?.plan },
              }),
            );
            Object.assign(credState, {
              reading,
              readAt: now(),
              failures: 0,
              retryAt: 0,
              error: undefined,
            });
            return reading;
          } catch (error) {
            credState.failures++;
            credState.error =
              error instanceof UsageError
                ? error
                : new UsageError("CPA 上游额度接口请求失败，请稍后重试");
            credState.retryAt = now() + upstreamDelay(error, credState.failures);
            throw error;
          } finally {
            credState.pending = undefined;
          }
        })();

        try {
          const reading = await within(credState.pending, signal);
          return {
            windows: reading.windows,
            plan: reading.plan,
            resets: liveResets(reading.resets, now()),
          };
        } catch (error) {
          if ((error as { permanent?: boolean } | undefined)?.permanent) throw error;
          if (passive) return fromPassive();
          throw error;
        }
      };

      entry.pending = (async (): Promise<UsageResult> => {
        try {
          const files = await credentialList();
          const rows = files.filter(row => row?.disabled === false);
          const supported = (row: CPACredential) => Object.hasOwn(adapters, row.provider);
          const matches = selection
            ? rows.filter(row => row.auth_index === selection || row.name === selection)
            : rows.filter(supported);

          if (!matches.length) {
            throw new UsageError(
              selection
                ? "所选 CPA 凭据不存在或已禁用"
                : rows.length
                  ? "当前供应商暂不支持额度查询"
                  : "未找到已启用的 CPA 凭据",
              { stale: false },
            );
          }
          if (selection && matches.length !== 1) {
            throw new UsageError("存在多个同名 CPA 凭据，请改用唯一的 name 或 auth_index", { stale: false });
          }

          if (rows.length > 1 && entry.value?.windows?.some(window => !window.aside)) {
            entry.value = undefined;
          }

          matches.sort(
            (a, b) =>
              a.provider.localeCompare(b.provider) ||
              credentialLabel(a).localeCompare(credentialLabel(b)) ||
              String(a.auth_index).localeCompare(String(b.auth_index)),
          );

          let exclusive: Map<string, string[]> | undefined;
          if (modelRouting && !selection && rows.length > 1 && rows.every(supported)) {
            const list = lists.get(scope)!;
            list.models ??= Promise.all(
              rows.map(credential =>
                limited(async () => {
                  const name = credential.name || credential.id;
                  if (typeof name !== "string" || !name.trim()) {
                    throw new UsageError("缺少 CPA 凭据名称或 ID");
                  }
                  const payload = (await call(`/credentials/models?name=${encodeURIComponent(name)}`, 1 << 20)) as {
                    models?: unknown;
                  };
                  if (
                    !Array.isArray(payload?.models) ||
                    payload.models.some(
                      model => typeof (model as { id?: unknown } | null)?.id !== "string" || !(model as { id: string }).id.trim(),
                    )
                  ) {
                    throw new UsageError("CPA 返回的凭据模型列表格式无效");
                  }
                  return new Set(
                    (payload.models as { id: string }[]).map(model => model.id.toLowerCase()),
                  );
                }),
              ),
            );
            try {
              const sets = await within(list.models, signal);
              exclusive = new Map(
                rows.map((credential, index) => [
                  credential.auth_index,
                  [...sets[index]].filter(id => sets.every((set, other) => other === index || !set.has(id))),
                ]),
              );
            } catch (error) {
              if ((error as { permanent?: boolean } | undefined)?.permanent || blockedMap.has(scope)) {
                throw error;
              }
            }
          }

          const read = async (credential: CPACredential): Promise<UsageReading> => {
            if (!supported(credential)) {
              throw new UsageError("当前供应商暂不支持额度查询", { stale: false });
            }
            const adapter = adapters[credential.provider];
            if (typeof credential.auth_index !== "string" || !credential.auth_index.trim() || credential.auth_index.length > 128) {
              throw new UsageError("CPA 凭据 auth_index 无效，请检查所选凭据", { stale: false });
            }
            const apiCall: ApiCallFn = async (template, optionalMs) => {
              const payload = (await call(
                "/requests/api-call",
                256 << 10,
                { ...template, auth_index: credential.auth_index },
                optionalMs,
              )) as { status_code?: unknown; header?: unknown; body?: unknown } | null;

              if (payload?.status_code !== 200) {
                const status = typeof payload?.status_code === "number" ? payload.status_code : undefined;
                const message =
                  status === 401
                    ? "CPA 上游凭据已失效，请在 CPA 管理面板刷新认证"
                    : status === 429
                      ? "CPA 上游额度接口触发限流，请稍后重试"
                      : "CPA 上游额度查询失败，请稍后重试";
                const error = new UsageError(message);
                error.upstreamStatus = status;
                error.retryAfter = retryAfter(payload?.header, now());
                throw error;
              }
              if (typeof payload.body !== "string") {
                throw new UsageError("CPA 返回的额度响应格式无效");
              }
              return JSON.parse(payload.body);
            };
            return credentialReading(credential, adapter, apiCall);
          };

          const readings = await Promise.all(
            matches.map(async credential => {
              try {
                if (blockedMap.has(scope)) {
                  throw new UsageError(blockedMap.get(scope)!, { permanent: true });
                }
                signal.throwIfAborted();
                return { reading: await read(credential) };
              } catch (error) {
                if ((error as { permanent?: boolean } | undefined)?.permanent || blockedMap.has(scope)) {
                  const raw = blockedMap.get(scope) ?? (error instanceof Error ? error.message : "CPA 管理访问被拒绝");
                  throw new UsageError(raw, { permanent: true });
                }
                return { error };
              }
            }),
          );

          if (blockedMap.has(scope)) {
            throw new UsageError(blockedMap.get(scope)!, { permanent: true });
          }

          const successes = readings.filter((result): result is { reading: UsageReading } => "reading" in result && Boolean(result.reading));
          if (!successes.length) throw (readings[0] as { error: unknown }).error;

          const windows: UsageWindow[] = readings.flatMap((result, index) => {
            const label = credentialLabel(matches[index]);
            if ("error" in result) {
              return [{ name: label, display: "额度暂不可用，请在 CPA 管理面板检查该凭据", aside: true }];
            }
            const models = exclusive?.get(matches[index].auth_index);
            return result.reading.windows.map(window =>
              rows.length > 1
                ? {
                    ...window,
                    name: `${window.name} (${label})`,
                    ...(models?.length ? { models } : { aside: true }),
                  }
                : { ...window },
            );
          });

          entry.value = { windows, signIn: "kept" };
          if (matches.length === 1) {
            const reading = successes[0].reading;
            if (reading.resets) entry.value.resets = reading.resets;
            if (reading.plan) entry.value.plan = reading.plan;
          }
          entry.updatedAt = now();
          entry.error = undefined;
        } catch (error) {
          const message =
            error instanceof UsageError
              ? redactText(error.message, secrets)
              : signal.aborted
                ? "CPA 额度查询超时，请检查管理接口连通性"
                : "CPA 额度暂不可用，请检查管理接口配置或网络连通性";
          entry.error = message;
          if (error instanceof UsageError && (!error.stale || error.permanent)) {
            entry.value = undefined;
          }
          entry.retryAt = now() + READ_TTL_MS;
        } finally {
          entry.pending = undefined;
        }
        return render(entry);
      })();

      return await within(entry.pending, signal);
    } catch {
      return { error: "CPA 额度暂不可用，请检查管理配置", signIn: "kept" };
    }
  };
}
