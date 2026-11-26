import { once } from "node:events";
import { createServer, type AddressInfo, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "bun:test";
import plugin, { _internal } from "../index.ts";
import { runDoctor } from "../scripts/doctor.ts";
import { createSafeFetch } from "../src/transport.ts";
import type { CPACredential, FetchLike } from "../src/types.ts";

async function withLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("1. maskSecret, redactText and toSafeError enforce secret masking", () => {
  expect(_internal.maskSecret("")).toBe("");
  expect(_internal.maskSecret("short")).toBe("****");
  expect(_internal.maskSecret("12345678")).toBe("****");
  expect(_internal.maskSecret("sk-ant-1234567890abcd")).toBe("sk-a****abcd");

  const biz = "sk-biz-supersecret9999";
  const mgmt = "mgmt-secret-value-8888";
  const raw = `Error calling https://cpa.local with Bearer ${biz} and x-api-key=${mgmt} plus sk-another-secret-token123`;
  const redacted = _internal.redactText(raw, [biz, mgmt]);
  expect(redacted.includes(biz)).toBe(false);
  expect(redacted.includes(mgmt)).toBe(false);
  expect(redacted.includes("sk-another-secret-token123")).toBe(false);
  expect(redacted).toContain("sk-b****9999");
  expect(redacted).toContain("mgmt****8888");
});

test("2. assertAllowedTargetURL & loader.fetch lock target origin and path prefix", async () => {
  expect(() => _internal.assertAllowedTargetURL("https://cpa.example.invalid/proxy/v1/messages", "https://cpa.example.invalid/proxy")).not.toThrow();
  expect(() => _internal.assertAllowedTargetURL("https://evil.example.invalid/v1/messages", "https://cpa.example.invalid")).toThrow(TypeError);
  expect(() => _internal.assertAllowedTargetURL("https://cpa.example.invalid/other/v1/messages", "https://cpa.example.invalid/proxy")).toThrow(TypeError);
  expect(() => _internal.assertAllowedTargetURL("https://cpa.example.invalid/proxy-evil/v1/messages", "https://cpa.example.invalid/proxy")).toThrow(TypeError);

  let called = 0;
  const instance = await plugin({
    fetch: async () => {
      called++;
      return Response.json({ ok: true });
    },
  });
  const loader = await instance.auth.loader(() => ({
    type: "api",
    key: "sk-biz-1234567890",
    metadata: { baseURL: "https://cpa.example.invalid/api" },
  }));
  await expect(loader.fetch!("https://attacker.invalid/v1/messages")).rejects.toThrow(/超出已配置的 CPA 地址范围/);
  await expect(loader.fetch!("https://cpa.example.invalid/v1/messages")).rejects.toThrow(/超出已配置的 CPA 地址前缀/);
  expect(called).toBe(0);
});

test("3. loader.fetch enforces headers timeout on stalled server, keeps SSE alive after headers, and honors caller abort", async () => {
  // 3a. Stalled headers trigger TimeoutError
  await withLocalServer(
    () => {
      // Intentionally never send response headers.
    },
    async origin => {
      const safeFetch = createSafeFetch(origin, ["sk-secret-123456"], { headerTimeoutMs: 40 });
      let caught: Error | undefined;
      try {
        await safeFetch(`${origin}/v1/messages`);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.name).toBe("TimeoutError");
      expect(caught?.message).toMatch(/响应头超时/);
    },
  );

  // 3b. Active SSE stream continues after headers arrive even past headerTimeoutMs
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 90);
    },
    async origin => {
      const safeFetch = createSafeFetch(origin, [], { headerTimeoutMs: 40 });
      const res = await safeFetch(`${origin}/v1/messages`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("data: first");
      expect(body).toContain("data: second");
    },
  );

  // 3c. Caller abort still cancels stream
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: start\n\n");
    },
    async origin => {
      const safeFetch = createSafeFetch(origin, [], { headerTimeoutMs: 5000 });
      const controller = new AbortController();
      const res = await safeFetch(`${origin}/v1/messages`, { signal: controller.signal });
      controller.abort();
      await expect(res.text()).rejects.toThrow();
    },
  );
});

test("4. modelFilter wildcards, exclusions, cloaking filter, and modelGroupPrefix work properly", async () => {
  const mockFetch: FetchLike = async (_url, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("anthropic-version")) {
      return Response.json({
        data: [
          { id: "claude-sonnet-4-6", owned_by: "anthropic" },
          { id: "claude-3-legacy", owned_by: "anthropic" },
          { id: "gpt-5-codex", owned_by: "openai" },
          { id: "gemini-2.5-pro", owned_by: "google" },
          { id: "claude-fable-5-dd-hidden", owned_by: "anthropic" },
        ],
      });
    }
    return Response.json({
      data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
    });
  };

  const instance = await plugin({ fetch: mockFetch });
  const models = await instance.provider.models(
    {},
    {
      auth: {
        type: "api",
        key: "sk-biz-12345678",
        metadata: {
          baseURL: "https://cpa.example.invalid",
          modelFilter: "claude-*,gpt-*,!*-legacy",
          modelGroupPrefix: "enabled",
        },
      },
    },
  );

  expect(Object.keys(models)).toEqual(["claude-sonnet-4-6", "gpt-5-codex"]);
  expect(models["claude-sonnet-4-6"].name).toBe("[Claude] Claude Sonnet 4.6");
  expect(models["gpt-5-codex"].name).toBe("[OpenAI] gpt-5-codex");
  expect(models["gpt-5-codex"].api?.npm).toBe("@ai-sdk/openai");
});

test("5. usageMode passive-only reads CPA signals and never invokes /requests/api-call", async () => {
  let now = Date.parse("2026-11-26T00:00:00Z");
  let apiCalls = 0;
  const freshCred: CPACredential = {
    provider: "claude",
    disabled: false,
    auth_index: "idx-passive",
    quota: {
      observed_at: new Date(now - 60_000).toISOString(),
      signals: {
        "anthropic-ratelimit-unified-5h-utilization": "0.3",
        "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 3600),
        "anthropic-ratelimit-unified-7d-utilization": "0.6",
        "anthropic-ratelimit-unified-7d-reset": String(now / 1000 + 86400),
      },
    },
  };
  let files: CPACredential[] = [freshCred];

  const read = _internal.createUsage({
    now: () => now,
    request: async url => {
      if (String(url).endsWith("/credentials")) return Response.json({ files });
      apiCalls++;
      return Response.json({});
    },
  });

  const okRes = await read(() => ({
    type: "api",
    key: "k",
    metadata: { baseURL: "https://cpa.example.invalid", managementKey: "mgmt-12345678", usageMode: "passive-only" },
  }));
  expect(okRes.windows).toHaveLength(2);
  expect(okRes.windows?.[0].used).toBe(30);
  expect(apiCalls).toBe(0);

  // Advance past the 15s /credentials list cache; without fresh passive signals, passive-only errors without api-call
  now += 20_000;
  files = [{ provider: "claude", disabled: false, auth_index: "idx-empty" }];
  const emptyRes = await read(() => ({
    type: "api",
    key: "k",
    metadata: {
      baseURL: "https://cpa.example.invalid",
      managementKey: "mgmt-12345678",
      credential: "idx-empty",
      usageMode: "passive-only",
    },
  }));
  expect(emptyRes.signIn).toBe("kept");
  expect(emptyRes.error).toMatch(/仅被动信号模式/);
  expect(apiCalls).toBe(0);
});

test("6. authorize() resets 401/403 circuit breaker and caches so re-login recovers immediately", async () => {
  let mgmtStatus = 401;
  const mockFetch: FetchLike = async url => {
    if (String(url).endsWith("/credentials")) {
      return mgmtStatus === 200
        ? Response.json({ files: [{ provider: "claude", disabled: false, auth_index: "idx-1" }] })
        : new Response("denied", { status: mgmtStatus });
    }
    return Response.json({
      status_code: 200,
      body: JSON.stringify({
        five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
    });
  };

  const instance = await plugin({ fetch: mockFetch });
  const authObj = {
    type: "api",
    key: "sk-biz-12345678",
    metadata: { baseURL: "https://cpa.example.invalid", managementKey: "mgmt-same-key-1234" },
  };

  const blocked = await instance.auth.usage(() => authObj);
  expect(blocked.signIn).toBe("kept");
  expect(blocked.error).toMatch(/HTTP 401/);

  // Fix CPA side, re-login with the EXACT SAME key/endpoint
  mgmtStatus = 200;
  const reLogin = await instance.auth.methods[0].authorize({
    baseURL: "https://cpa.example.invalid",
    businessKey: "sk-biz-12345678",
    managementKey: "mgmt-same-key-1234",
  });
  expect(reLogin.type).toBe("success");

  const recovered = await instance.auth.usage(() => authObj);
  expect(recovered.error).toBeUndefined();
  expect(recovered.windows?.[0].used).toBe(12);
});

test("7. authorize checkConnection fails on invalid business key, gracefully tolerates management failure", async () => {
  const mockFetch: FetchLike = async url => {
    const s = String(url);
    if (s.endsWith("/v1/models")) return new Response("unauthorized", { status: 401 });
    return new Response("ok", { status: 200 });
  };
  const instance = await plugin({ fetch: mockFetch });
  const failed = await instance.auth.methods[0].authorize({
    baseURL: "https://cpa.example.invalid",
    businessKey: "sk-bad-key-123456",
    checkConnection: "check",
  });
  expect(failed.type).toBe("failed");
  if (failed.type === "failed") {
    expect(failed.error).toMatch(/401/);
    expect(failed.error.includes("sk-bad-key-123456")).toBe(false);
  }

  // Valid business key + unreachable management port still succeeds
  const partialMock: FetchLike = async url => {
    if (String(url).endsWith("/v1/models")) return Response.json({ data: [] });
    throw new Error("ECONNREFUSED");
  };
  const instance2 = await plugin({ fetch: partialMock });
  const ok = await instance2.auth.methods[0].authorize({
    baseURL: "https://cpa.example.invalid",
    businessKey: "sk-good-key-123456",
    managementKey: "mgmt-12345678",
    checkConnection: "check",
  });
  expect(ok.type).toBe("success");
});

test("8. Chinese error categorization for 401/403/404/500/network keeps signIn kept", async () => {
  for (const [status, pattern] of [
    [401, /HTTP 401/],
    [403, /HTTP 403/],
    [404, /HTTP 404/],
    [500, /HTTP 500/],
  ] as const) {
    const read = _internal.createUsage({
      request: async () => new Response("secret-raw-body", { status }),
    });
    const res = await read(() => ({
      type: "api",
      key: "k",
      metadata: { baseURL: "https://cpa.example.invalid", managementKey: "mgmt-12345678" },
    }));
    expect(res.signIn).toBe("kept");
    expect(res.error).toMatch(pattern);
    expect(res.error?.includes("secret-raw-body")).toBe(false);
  }
});

test("9. isInsecureRemoteManagement detects plaintext non-loopback HTTP only", () => {
  expect(_internal.isInsecureRemoteManagement("http://127.0.0.1:8317/v8/management")).toBe(false);
  expect(_internal.isInsecureRemoteManagement("http://localhost:8317/v8/management")).toBe(false);
  expect(_internal.isInsecureRemoteManagement("http://[::1]:8317/v8/management")).toBe(false);
  expect(_internal.isInsecureRemoteManagement("https://192.168.1.10:8317/v8/management")).toBe(false);
  expect(_internal.isInsecureRemoteManagement("http://192.168.1.10:8317/v8/management")).toBe(true);
  expect(_internal.isInsecureRemoteManagement("http://cpa.internal:8317/v8/management")).toBe(true);
});

test("10. runDoctor redacts all secrets and warns on insecure remote http management URL", async () => {
  const apiKey = "sk-doctor-biz-99887766";
  const managementKey = "mgmt-doctor-secret-55443322";
  const mockFetch: FetchLike = async url => {
    const s = String(url);
    if (s.endsWith("/v1/models")) return Response.json({ data: [{ id: "claude-sonnet-4-6" }] });
    if (s.endsWith("/credentials")) return Response.json({ files: [{ auth_index: "a1" }] });
    return Response.json({ models: [] });
  };

  const report = await runDoctor(
    {
      baseURL: "https://cpa.example.invalid",
      apiKey,
      managementURL: "http://10.0.0.5:8317/v8/management",
      managementKey,
    },
    mockFetch,
  );

  expect(report.ok).toBe(true);
  expect(report.warnings).toHaveLength(1);
  expect(report.warnings[0]).toMatch(/非本机明文 HTTP/);
  expect(report.summary.includes(apiKey)).toBe(false);
  expect(report.summary.includes(managementKey)).toBe(false);
  expect(report.summary).toContain("sk-d****7766");
  expect(report.summary).toContain("mgmt****3322");
});
