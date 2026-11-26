import { redactText, toSafeError } from "./security.ts";
import type { FetchLike, LoaderResult, PluginAuth } from "./types.ts";
import { assertAllowedTargetURL, normalizeURL } from "./url.ts";

export const DEFAULT_HEADER_TIMEOUT_MS = 120_000;

export interface SafeFetchOptions {
  headerTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Wrap fetch with origin/path-prefix enforcement, redirect blocking, response-header timeout
 * (cleared as soon as headers arrive so streaming SSE is never aborted), and secret redaction.
 */
export function createSafeFetch(
  allowedBaseURL: string,
  secrets: readonly (string | undefined)[] = [],
  options: SafeFetchOptions = {},
): FetchLike {
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return async (input, init) => {
    assertAllowedTargetURL(input, allowedBaseURL);

    const callerSignal = init?.signal ?? undefined;
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new DOMException("CPA response headers timed out", "TimeoutError"));
    }, headerTimeoutMs);

    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: combinedSignal,
        redirect: "error",
      });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? error;
      }
      if (timeoutController.signal.aborted) {
        const timeoutErr = new Error("连接 CPA 响应头超时，请检查服务状态或网络连通性");
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      }
      if (error instanceof TypeError || (error instanceof Error && /redirect/i.test(error.message))) {
        throw new TypeError(redactText(error.message || "CPA 请求失败或触发了被禁止的重定向", secrets));
      }
      throw toSafeError(error, "CPA 网络请求失败，请检查服务地址与网络连通性", secrets);
    }
  };
}

/**
 * Magpie auth.loader implementation returning baseURL, business apiKey, and hardened fetch.
 */
export async function createLoader(
  getAuth: () => PluginAuth | undefined | Promise<PluginAuth | undefined>,
  options: SafeFetchOptions = {},
): Promise<LoaderResult> {
  const auth = await getAuth();
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) return {};

  const baseURL = normalizeURL(auth.metadata?.baseURL, "CPA 地址");
  const secrets = [
    auth.key,
    typeof auth.metadata?.managementKey === "string" ? auth.metadata.managementKey : undefined,
  ];

  return {
    baseURL: `${baseURL}/v1`,
    apiKey: auth.key,
    fetch: createSafeFetch(baseURL, secrets, options),
  };
}
