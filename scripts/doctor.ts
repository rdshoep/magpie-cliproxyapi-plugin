import { maskSecret, readJSON, redactText } from "../src/security.ts";
import type { FetchLike } from "../src/types.ts";
import { isInsecureRemoteManagement, managementBase, normalizeURL } from "../src/url.ts";

export interface DoctorOptions {
  baseURL: string;
  apiKey: string;
  managementURL?: string;
  managementKey?: string;
}

export interface DoctorCheckItem {
  name: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  warnings: string[];
  checks: DoctorCheckItem[];
  summary: string;
}

function parseCliArgs(argv: readonly string[]): Partial<DoctorOptions> & { help?: boolean } {
  const result: Partial<DoctorOptions> & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--base-url" && i + 1 < argv.length) {
      result.baseURL = argv[++i];
    } else if (arg === "--api-key" && i + 1 < argv.length) {
      result.apiKey = argv[++i];
    } else if (arg === "--management-url" && i + 1 < argv.length) {
      result.managementURL = argv[++i];
    } else if (arg === "--management-key" && i + 1 < argv.length) {
      result.managementKey = argv[++i];
    }
  }
  return result;
}

/**
 * Run read-only connectivity and credential diagnostics against a CPA instance.
 * Never reads host files or environment variables; redacts all secrets in output.
 */
export async function runDoctor(
  options: DoctorOptions,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<DoctorReport> {
  const secrets = [options.apiKey, options.managementKey];
  const warnings: string[] = [];
  const checks: DoctorCheckItem[] = [];

  const baseURL = normalizeURL(options.baseURL, "CPA 地址");
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("请通过 --api-key 提供业务 API Key");

  const mgmtKey = options.managementKey?.trim();
  const mgmtBase = mgmtKey
    ? managementBase({ baseURL, managementURL: options.managementURL })
    : undefined;

  if (mgmtBase && isInsecureRemoteManagement(mgmtBase)) {
    warnings.push(
      `警告：管理接口 ${mgmtBase} 为非本机明文 HTTP，管理密钥存在网络嗅探风险，建议使用 HTTPS、SSH 隧道或本机回环地址`,
    );
  }

  const runProbe = async (name: string, url: string, headers: Record<string, string>) => {
    const start = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      const latencyMs = Date.now() - start;
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // Ignore cancellation error.
        }
        checks.push({
          name,
          ok: false,
          status: response.status,
          latencyMs,
          detail: `HTTP ${response.status}`,
        });
        return;
      }
      const payload = (await readJSON(response, 1 << 20)) as Record<string, unknown>;
      const count = Array.isArray(payload?.data)
        ? payload.data.length
        : Array.isArray(payload?.files)
          ? payload.files.length
          : Array.isArray(payload?.models)
            ? payload.models.length
            : 0;
      checks.push({
        name,
        ok: true,
        status: response.status,
        latencyMs,
        detail: `OK（条目数: ${count}）`,
      });
    } catch (error) {
      const latencyMs = Date.now() - start;
      const rawMsg = error instanceof Error ? error.message : "请求失败";
      checks.push({
        name,
        ok: false,
        latencyMs,
        detail: redactText(rawMsg, secrets),
      });
    }
  };

  await runProbe("业务接口 /v1/models (OpenAI 格式)", `${baseURL}/v1/models`, {
    Authorization: `Bearer ${apiKey}`,
  });
  await runProbe("业务接口 /v1/models (Anthropic 格式)", `${baseURL}/v1/models`, {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });

  if (mgmtKey && mgmtBase) {
    const mgmtHeaders = {
      Authorization: `Bearer ${mgmtKey}`,
      "Content-Type": "application/json",
    };
    await runProbe("管理接口 /credentials（只读）", `${mgmtBase}/credentials`, mgmtHeaders);
    await runProbe(
      "管理接口 /routing/model-definitions/claude",
      `${mgmtBase}/routing/model-definitions/claude`,
      mgmtHeaders,
    );
    await runProbe(
      "管理接口 /routing/model-definitions/codex",
      `${mgmtBase}/routing/model-definitions/codex`,
      mgmtHeaders,
    );
  }

  // Business endpoints must pass; management endpoints are optional and reported as warnings/status.
  const businessOk = checks.slice(0, 2).every(c => c.ok);
  const lines = [
    `CPA 诊断目标: ${baseURL}`,
    `业务 API Key: ${maskSecret(apiKey)}`,
    ...(mgmtKey && mgmtBase
      ? [`管理入口: ${mgmtBase}`, `管理密钥: ${maskSecret(mgmtKey)}`]
      : ["管理入口: 未提供（跳过管理接口检测）"]),
    ...warnings,
    ...checks.map(
      c => `[${c.ok ? "PASS" : "FAIL"}] ${c.name} - ${c.detail} (${c.latencyMs}ms)`,
    ),
  ];

  return {
    ok: businessOk,
    warnings: warnings.map(w => redactText(w, secrets)),
    checks,
    summary: redactText(lines.join("\n"), secrets),
  };
}

if (import.meta.main) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || !args.baseURL || !args.apiKey) {
    process.stdout.write(
      "用法: bun run scripts/doctor.ts --base-url <CPA_URL> --api-key <BIZ_KEY> [--management-url <MGMT_URL>] [--management-key <MGMT_KEY>]\n",
    );
    process.exitCode = args.help ? 0 : 1;
  } else {
    try {
      const report = await runDoctor({
        baseURL: args.baseURL,
        apiKey: args.apiKey,
        managementURL: args.managementURL,
        managementKey: args.managementKey,
      });
      process.stdout.write(`${report.summary}\n`);
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      const msg = redactText(
        error instanceof Error ? error.message : "诊断执行失败",
        [args.apiKey, args.managementKey],
      );
      process.stderr.write(`错误: ${msg}\n`);
      process.exitCode = 1;
    }
  }
}
