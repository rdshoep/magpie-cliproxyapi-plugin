import { readJSON, redactText, toSafeError } from "./security.ts";
import { managementScope } from "./state.ts";
import type {
  FetchLike,
  ModelDefinitionEntry,
  ModelEntry,
  ParsedModelFilter,
  PluginAuth,
  PluginRuntimeState,
  ProviderConfig,
} from "./types.ts";
import { managementBase, normalizeURL } from "./url.ts";

interface ModelRow {
  id?: unknown;
  display_name?: unknown;
  owned_by?: unknown;
}

interface ModelListPayload {
  data?: unknown;
}

interface DefinitionsPayload {
  models?: unknown;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Validate optional comma-separated wildcard model filter string.
 */
export function validateModelFilter(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value.length > 500) return "模型过滤规则过长（最多 500 个字符）";
  if (/[\x00-\x1f\x7f]/.test(value)) return "模型过滤规则不能包含控制字符";
  for (const raw of value.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (token === "!") return "排除规则 '!' 后不能为空";
  }
  return undefined;
}

/**
 * Parse comma-separated wildcard rules (e.g. "claude-*,gpt-*,!*-legacy").
 */
export function parseModelFilter(raw?: string): ParsedModelFilter {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  if (typeof raw !== "string" || !raw.trim()) return { include, exclude };

  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    if (token.startsWith("!")) {
      const pattern = token.slice(1).trim();
      if (pattern) exclude.push(wildcardToRegex(pattern));
    } else {
      include.push(wildcardToRegex(token));
    }
  }
  return { include, exclude };
}

/**
 * Check whether a model ID passes built-in cloaking exclusion and optional user filter rules.
 */
export function matchesModelFilter(id: string, filter?: ParsedModelFilter): boolean {
  if (id.startsWith("claude-fable-5-dd-")) return false;
  if (!filter || (!filter.include.length && !filter.exclude.length)) return true;
  if (filter.exclude.some(re => re.test(id))) return false;
  if (filter.include.length > 0) return filter.include.some(re => re.test(id));
  return true;
}

/**
 * Optionally prepend a readable provider/channel tag to the model display name without altering model.id.
 */
export function formatGroupedName(id: string, displayName: string, ownedBy?: string): string {
  let group = "Other";
  const owner = typeof ownedBy === "string" ? ownedBy.trim() : "";
  if (id.startsWith("claude-") || owner.toLowerCase() === "anthropic") {
    group = "Claude";
  } else if (owner.toLowerCase() === "openai" || /^(gpt-|o[134](?:-|$)|codex)/i.test(id)) {
    group = "OpenAI";
  } else if (id.startsWith("gemini-") || owner.toLowerCase() === "google") {
    group = "Gemini";
  } else if (owner) {
    group = owner;
  }

  const prefix = `[${group}]`;
  return displayName.startsWith(prefix) ? displayName : `${prefix} ${displayName}`;
}

function definitionBase(id: string): string {
  return id.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

function reasoningLevels(definition: ModelDefinitionEntry | undefined): string[] {
  if (!Array.isArray(definition?.thinking?.levels)) return [];
  return [
    ...new Set(
      definition.thinking.levels
        .filter((level): level is string => typeof level === "string")
        .map(level => level.trim())
        .filter(Boolean),
    ),
  ];
}

function applyReasoning(
  model: ModelEntry,
  definition: ModelDefinitionEntry | undefined,
  configured: Partial<ModelEntry> | undefined,
): ModelEntry {
  const levels = reasoningLevels(definition);
  if (!levels.length) return model;
  if (!Object.hasOwn(configured ?? {}, "variants")) {
    model.variants = Object.fromEntries(levels.map(level => [level, {}]));
  }
  if (!Object.hasOwn(configured?.capabilities ?? {}, "reasoning")) {
    model.capabilities = { ...model.capabilities, reasoning: true };
  }
  return model;
}

/**
 * Query optional CPA routing model definitions for thinking/reasoning levels.
 * Always degrades to an empty map on error without blocking model discovery.
 */
export async function modelDefinitions(
  auth: PluginAuth | undefined,
  state: PluginRuntimeState,
  channel = "claude",
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<Map<string, ModelDefinitionEntry>> {
  const metadata = auth?.metadata;
  if (typeof metadata?.managementKey !== "string" || !metadata.managementKey) return new Map();

  try {
    const base = managementBase(metadata);
    const scope = managementScope(base, metadata.managementKey);
    if (state.blocked.has(scope)) return new Map();

    const signal = AbortSignal.timeout(10_000);
    const response = await fetchImpl(`${base}/routing/model-definitions/${channel}`, {
      headers: {
        Authorization: `Bearer ${metadata.managementKey}`,
        "Content-Type": "application/json",
      },
      signal,
      redirect: "error",
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const message =
          response.status === 401
            ? "CPA 管理密钥无效或已拒绝访问（HTTP 401），已暂停自动查询；请修正后重新登录"
            : "CPA 管理接口拒绝访问（HTTP 403，可能未开启 allow-remote 或已触发 IP 封禁），已暂停自动查询；请修正后重新登录";
        state.blocked.set(scope, message);
      }
      try {
        await response.body?.cancel();
      } catch {
        // Ignore stream cancellation error.
      }
      return new Map();
    }

    const payload = (await readJSON(response, 1 << 20)) as DefinitionsPayload;
    if (!Array.isArray(payload?.models)) return new Map();

    const definitions = new Map<string, ModelDefinitionEntry>();
    for (const item of payload.models) {
      const def = item as ModelDefinitionEntry | null;
      if (typeof def?.id !== "string" || !def.id.trim()) continue;
      definitions.set(def.id, def);
    }
    return definitions;
  } catch {
    return new Map();
  }
}

/**
 * Discover models from CPA /v1/models (OpenAI + Anthropic formats in parallel) and merge reasoning levels.
 */
export async function discoverModels(
  provider: ProviderConfig | undefined,
  ctx: { auth?: PluginAuth } = {},
  state: PluginRuntimeState,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<Record<string, ModelEntry>> {
  const auth = ctx.auth;
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) return {};

  const apiKey = auth.key;
  const secrets = [
    apiKey,
    typeof auth.metadata?.managementKey === "string" ? auth.metadata.managementKey : undefined,
  ];
  const baseURL = normalizeURL(auth.metadata?.baseURL, "CPA 地址");
  const definitionsPromise = modelDefinitions(auth, state, "claude", fetchImpl);
  const codexDefinitionsPromise = modelDefinitions(auth, state, "codex", fetchImpl);
  const signal = AbortSignal.timeout(10_000);

  const fetchModels = async (headers: Record<string, string>): Promise<ModelRow[]> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseURL}/v1/models`, { headers, signal, redirect: "error" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        const timeoutError = new DOMException(redactText(error.message || "请求 CPA 模型列表超时", secrets), "TimeoutError");
        throw timeoutError;
      }
      throw toSafeError(error, "连接 CPA 模型列表失败，请检查地址与网络连通性", secrets);
    }

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore stream cancellation error.
      }
      const message =
        response.status === 401 || response.status === 403
          ? `CPA 业务 API Key 无效或已过期（HTTP ${response.status}），请重新登录`
          : response.status === 404
            ? "CPA 模型列表接口未找到（HTTP 404），请检查 Base URL 配置"
            : `CPA 模型发现失败（HTTP ${response.status}）`;
      const error = new Error(message) as Error & { signIn?: "expired" };
      if (response.status === 401 || response.status === 403) error.signIn = "expired";
      throw error;
    }

    let payload: ModelListPayload;
    try {
      payload = (await readJSON(response, 1 << 20)) as ModelListPayload;
    } catch (error) {
      if (error instanceof Error && error.message.includes("大小限制")) throw error;
      throw new Error("CPA 返回的模型列表 JSON 格式无效");
    }

    if (!Array.isArray(payload?.data)) {
      throw new Error("CPA 返回的模型列表结构无效");
    }
    return payload.data as ModelRow[];
  };

  const [lists, definitions, codexDefinitions] = await Promise.all([
    Promise.allSettled([
      fetchModels({ Authorization: `Bearer ${apiKey}` }),
      fetchModels({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
    ]),
    definitionsPromise,
    codexDefinitionsPromise,
  ]);

  const expiredFailure = lists.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" &&
      Boolean((result.reason as { signIn?: string } | undefined)?.signIn === "expired"),
  );
  if (expiredFailure) throw expiredFailure.reason;
  if (lists[0].status === "rejected") throw lists[0].reason;

  const rows = lists[0].value;
  const namedRows = lists[1].status === "fulfilled" ? lists[1].value : [];
  const names = new Map<string, unknown>(
    namedRows
      .filter((row): row is ModelRow & { id: string } => typeof row?.id === "string")
      .map(row => [row.id, row.display_name]),
  );

  const filterRaw = typeof auth.metadata?.modelFilter === "string" ? auth.metadata.modelFilter : undefined;
  const parsedFilter = filterRaw ? parseModelFilter(filterRaw) : undefined;
  const groupPrefix = auth.metadata?.modelGroupPrefix === "enabled";

  const models: Record<string, ModelEntry> = {};
  for (const row of rows) {
    if (typeof row?.id !== "string" || !row.id.trim()) continue;
    if (!matchesModelFilter(row.id, parsedFilter)) continue;

    const configured = provider?.models?.[row.id];
    const ownedBy = typeof row.owned_by === "string" ? row.owned_by : undefined;
    const codex = ownedBy === "openai" && !row.id.startsWith("claude-");
    const channel = codex ? codexDefinitions : definitions;
    const definition = channel.get(row.id) ?? channel.get(definitionBase(row.id));
    const rawName = names.get(row.id);
    const baseName = typeof rawName === "string" && rawName ? rawName : row.id;
    const name = groupPrefix ? formatGroupedName(row.id, baseName, ownedBy) : baseName;

    const model: ModelEntry = {
      ...configured,
      id: row.id,
      name,
    };
    applyReasoning(model, definition, configured);
    if (model.api) {
      const { id: _id, ...api } = model.api;
      model.api = api;
    }
    if (codex) {
      model.api = { ...model.api, npm: "@ai-sdk/openai" };
    }
    Object.defineProperty(models, row.id, {
      value: model,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return models;
}
