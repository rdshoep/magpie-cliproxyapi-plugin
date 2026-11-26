/**
 * Validate and normalize a CPA or management HTTP/HTTPS base URL.
 * Rejects userinfo, query strings, fragments, and invalid ports; strips trailing `/` and `/v1`.
 */
export function normalizeURL(value: unknown, label = "CPA 地址"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`请填写有效的${label}`);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label}格式无效，请输入完整的 HTTP 或 HTTPS 地址`);
  }

  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error(`${label}仅支持 HTTP 或 HTTPS 协议且必须包含主机名`);
  }

  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${label}端口无效，必须在 1-65535 之间`);
    }
  }

  if (url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new Error(`${label}不能包含用户名、密码、查询参数（?）或锚点（#）`);
  }

  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return url.href.replace(/\/+$/, "");
}

/**
 * Field validator wrapper for Magpie login prompts.
 */
export function validateURL(value: unknown, optional = false, label = "CPA 地址"): string | undefined {
  if (optional && (typeof value !== "string" || !value.trim())) return undefined;
  try {
    normalizeURL(value, label);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : `${label}格式无效`;
  }
}

/**
 * Return true when the URL points to a loopback address (localhost, 127.0.0.0/8, ::1).
 */
export function isLoopbackHost(urlString: string): boolean {
  try {
    const host = new URL(urlString).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "0:0:0:0:0:0:0:1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Return true when a management endpoint uses plaintext HTTP on a non-loopback host.
 */
export function isInsecureRemoteManagement(managementUrlString: string): boolean {
  try {
    const url = new URL(managementUrlString);
    return url.protocol === "http:" && !isLoopbackHost(managementUrlString);
  } catch {
    return false;
  }
}

/**
 * Resolve the normalized management API base URL from plugin metadata.
 */
export function managementBase(metadata: { baseURL?: unknown; managementURL?: unknown }): string {
  return metadata.managementURL
    ? normalizeURL(metadata.managementURL, "管理地址")
    : `${normalizeURL(metadata.baseURL, "CPA 地址")}/v8/management`;
}

/**
 * Enforce minimal network egress: ensure a fetch target stays within the configured baseURL origin & path prefix.
 */
export function assertAllowedTargetURL(input: string | URL | Request, allowedBaseURL: string): URL {
  const base = new URL(normalizeURL(allowedBaseURL, "CPA 地址"));
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new TypeError("请求目标 URL 无效，已拦截");
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new TypeError("请求目标协议不被允许，已拦截");
  }

  if (target.origin !== base.origin) {
    throw new TypeError("请求目标超出已配置的 CPA 地址范围，已拦截");
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    throw new TypeError("请求路径超出已配置的 CPA 地址前缀，已拦截");
  }

  return target;
}
