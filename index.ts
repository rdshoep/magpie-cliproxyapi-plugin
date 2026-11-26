import { discoverModels, matchesModelFilter, parseModelFilter, validateModelFilter } from "./src/discovery.ts";
import { maskSecret, redactText } from "./src/security.ts";
import { createRuntimeState } from "./src/state.ts";
import { createLoader } from "./src/transport.ts";
import type {
  AuthorizeInputs,
  AuthorizeResult,
  FetchLike,
  PluginHooks,
  PluginMetadata,
  PluginRuntimeState,
} from "./src/types.ts";
import { createUsage } from "./src/usage.ts";
import {
  assertAllowedTargetURL,
  isInsecureRemoteManagement,
  managementBase,
  normalizeURL,
  validateURL,
} from "./src/url.ts";

export interface PluginOptions {
  state?: PluginRuntimeState;
  fetch?: FetchLike;
}

async function probeConnection(
  baseURL: string,
  businessKey: string,
  metadata: PluginMetadata,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const secrets = [businessKey, metadata.managementKey];
  try {
    const response = await fetchImpl(`${baseURL}/v1/models`, {
      headers: { Authorization: `Bearer ${businessKey}` },
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    try {
      await response.body?.cancel();
    } catch {
      // Ignore stream cancellation error.
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return `CPA 业务 API Key 无效或被拒绝（HTTP ${response.status}）`;
      }
      return `CPA 业务接口返回异常状态（HTTP ${response.status}）`;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return "连接 CPA 业务接口超时，请检查地址与网络连通性";
    }
    return redactText("无法连接 CPA 业务接口，请检查地址与服务状态", secrets);
  }

  // Optional single-shot read-only management probe: failure degrades silently and never blocks business sign-in.
  if (metadata.managementKey) {
    try {
      const mgmtResponse = await fetchImpl(`${managementBase(metadata)}/credentials`, {
        headers: {
          Authorization: `Bearer ${metadata.managementKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      try {
        await mgmtResponse.body?.cancel();
      } catch {
        // Ignore stream cancellation error.
      }
    } catch {
      // Management probe failures do not block business model inference.
    }
  }

  return undefined;
}

export default async function CLIProxyAPIPlugin(options: PluginOptions = {}): Promise<PluginHooks> {
  const state = options.state ?? createRuntimeState();
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider.cpa ??= { name: "CLIProxyAPI", npm: "@ai-sdk/anthropic", models: {} };
    },
    auth: {
      provider: "cpa",
      usage: createUsage({ state, request: fetchImpl }),
      methods: [
        {
          type: "api",
          label: "CLIProxyAPI business API key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "CPA Base URL",
              validate: value => validateURL(value, false, "CPA 地址"),
            },
            {
              type: "password",
              key: "businessKey",
              message: "Business API key",
              validate: value =>
                typeof value === "string" && value.trim() ? undefined : "请填写业务 API Key",
            },
            {
              type: "password",
              key: "managementKey",
              message: "Management key (optional, for usage)",
            },
            {
              type: "text",
              key: "managementURL",
              message: "Management URL (optional)",
              validate: value => validateURL(value, true, "管理地址"),
            },
            {
              type: "text",
              key: "credential",
              message: "CPA credential name or auth_index (optional)",
            },
            {
              type: "select",
              key: "modelRouting",
              message:
                "Model quota routing (enable only if no config API keys, openai-compatibility or plugins serve the same models)",
              options: [
                { label: "Disabled (default)", value: "disabled" },
                { label: "Enabled", value: "enabled" },
              ],
            },
            {
              type: "text",
              key: "modelFilter",
              message: "Model filter wildcards (optional, e.g. claude-*,gpt-*,!*-legacy)",
              validate: validateModelFilter,
            },
            {
              type: "select",
              key: "modelGroupPrefix",
              message: "Display group prefix on model names (optional)",
              options: [
                { label: "Disabled (default)", value: "disabled" },
                { label: "Enabled", value: "enabled" },
              ],
            },
            {
              type: "select",
              key: "usageMode",
              message: "Quota query mode",
              options: [
                { label: "Auto (default: passive signals first, active fallback)", value: "auto" },
                { label: "Passive only (read CPA signals only, no upstream calls)", value: "passive-only" },
              ],
            },
            {
              type: "select",
              key: "checkConnection",
              message: "Verify connection during sign-in (optional)",
              options: [
                { label: "Skip (default, offline save)", value: "skip" },
                { label: "Check now (single read-only probe)", value: "check" },
              ],
            },
          ],
          async authorize(inputs?: AuthorizeInputs): Promise<AuthorizeResult> {
            const secrets = [inputs?.businessKey, inputs?.managementKey];
            try {
              const baseURL = normalizeURL(inputs?.baseURL, "CPA 地址");
              const key = inputs?.businessKey?.trim();
              if (!key) return { type: "failed", error: "请填写业务 API Key" };

              const metadata: PluginMetadata = {
                baseURL,
                email: `cpa@${new URL(baseURL).host}`,
              };

              const managementURL = inputs?.managementURL?.trim();
              if (managementURL) {
                metadata.managementURL = normalizeURL(managementURL, "管理地址");
              }

              for (const field of ["managementKey", "credential"] as const) {
                const value = inputs?.[field]?.trim();
                if (value) metadata[field] = value;
              }

              const modelFilter = inputs?.modelFilter?.trim();
              if (modelFilter) {
                const filterErr = validateModelFilter(modelFilter);
                if (filterErr) return { type: "failed", error: filterErr };
                metadata.modelFilter = modelFilter;
              }

              if (inputs?.modelRouting === "enabled") metadata.modelRouting = "enabled";
              if (inputs?.modelGroupPrefix === "enabled") metadata.modelGroupPrefix = "enabled";
              if (inputs?.usageMode === "passive-only") metadata.usageMode = "passive-only";

              if (inputs?.checkConnection === "check") {
                const probeError = await probeConnection(baseURL, key, metadata, fetchImpl);
                if (probeError) return { type: "failed", error: probeError };
              }

              // Re-login clears in-process circuit breakers and cached readings so fixed CPA settings recover immediately.
              state.resetAll();
              return { type: "success", key, metadata };
            } catch (error) {
              return {
                type: "failed",
                error:
                  error instanceof Error
                    ? redactText(error.message, secrets)
                    : "CPA 或管理地址格式无效",
              };
            }
          },
        },
      ],
      loader: getAuth => createLoader(getAuth, { fetchImpl }),
    },
    provider: {
      id: "cpa",
      models: (provider, ctx) => discoverModels(provider, ctx, state, fetchImpl),
    },
  };
}

export const _internal = {
  normalizeURL,
  createUsage,
  createRuntimeState,
  maskSecret,
  redactText,
  assertAllowedTargetURL,
  parseModelFilter,
  matchesModelFilter,
  isInsecureRemoteManagement,
};
