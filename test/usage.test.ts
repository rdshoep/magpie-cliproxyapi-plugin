import { once } from "node:events";
import { createServer, type AddressInfo } from "node:http";
import { expect, test } from "bun:test";
import plugin, { _internal } from "../index.ts";
import type { CPACredential, FetchLike, PluginAuth, UsageAdapter, UsageResult } from "../src/types.ts";

const managementKey = "test-mgmt-key-LEAKCHECK";
const businessKey = "test-biz-key-usage";
const baseURL = "https://cpa.example.invalid";
const reset = "2026-11-04T00:00:00Z";
const row: CPACredential = { provider: "claude", disabled: false, auth_index: "index-one", name: "one", label: "First" };
const second: CPACredential = { ...row, auth_index: "index-two", name: "two", label: "Second" };
const win = (utilization = 25, resets_at: string | null = reset) => ({ utilization, resets_at });
const data = () => ({ five_hour: win(), seven_day: win(50) });
const envelope = (body: unknown = data(), status_code = 200) => ({ status_code, body: JSON.stringify(body) });
const account = (metadata: Record<string, unknown> = {}): PluginAuth => ({
  type: "api",
  key: businessKey,
  metadata: { baseURL, managementKey, ...metadata },
});

function harness({
  files = [row],
  usage = envelope(),
  request,
  timeout,
  adapters,
}: {
  files?: CPACredential[];
  usage?: unknown;
  request?: (url: string, init: RequestInit | undefined, h: { advance: (ms: number) => void }) => Response | Promise<Response>;
  timeout?: (ms: number) => AbortSignal;
  adapters?: Record<string, UsageAdapter>;
} = {}) {
  let clock = 1_000_000;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const h = {
    files,
    usage,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (request) return request(url, init, h);
    return Response.json(url.endsWith("/credentials") ? { files: h.files } : h.usage);
  };
  const read = _internal.createUsage({
    now: () => clock,
    ...(timeout ? { timeout } : {}),
    ...(adapters ? { adapters } : {}),
    request: fetchFn,
  });
  return Object.assign(h, {
    read,
    get: (metadata: Record<string, unknown> = {}) => read(() => account(metadata)),
  });
}

function assertError(result: UsageResult) {
  expect(result.signIn).toBe("kept");
  expect(typeof result.error).toBe("string");
  expect((result.error ?? "").length).toBeGreaterThan(0);
  expect(result.windows).toBeUndefined();
  for (const secret of [managementKey, businessKey, "private-response-marker"]) {
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  }
}

test("usage hook is registered; absent management key makes no request", async () => {
  expect(typeof (await plugin()).auth.usage).toBe("function");
  const h = harness();
  expect(await h.read(() => undefined)).toEqual({});
  expect(await h.get({ managementKey: "" })).toEqual({});
  expect(h.calls).toHaveLength(0);
});

test("single enabled credential uses the exact api-call template and percentage windows", async () => {
  const h = harness({
    files: [
      null as unknown as CPACredential,
      { ...row, provider: "other", disabled: true },
      { ...row, disabled: true },
      row,
    ],
  });
  const result = await h.get();
  expect(result).toEqual({
    signIn: "kept",
    windows: [
      { name: "5 hours", used: 25, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" },
      { name: "7 days", used: 50, span: 604800, resetsAt: "2026-11-04T00:00:00.000Z" },
    ],
  });
  expect(h.calls).toHaveLength(2);
  const [credentials, api] = h.calls;
  expect(credentials.url).toBe(`${baseURL}/v8/management/credentials`);
  expect(credentials.init?.method).toBe("GET");
  expect(api.url).toBe(`${baseURL}/v8/management/requests/api-call`);
  expect(api.init?.method).toBe("POST");
  expect(JSON.parse(String(api.init?.body))).toEqual({
    auth_index: "index-one",
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
    header: {
      Authorization: "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-cli/2.1.280 (external, cli)",
      Accept: "application/json",
    },
  });
  expect(credentials.init?.signal).toBe(api.init?.signal);
  for (const { init } of h.calls) {
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${managementKey}`);
    expect(String(init?.body ?? "").includes(managementKey)).toBe(false);
    expect(JSON.stringify(init).includes(businessKey)).toBe(false);
  }
});

test("credential selection rejects zero, missing, disabled and ambiguous matches", async () => {
  for (const [files, selection] of [
    [[], ""],
    [[row], "missing"],
    [[row, { ...second, disabled: true }], "two"],
    [[row, { ...second, name: "one" }], "one"],
    [[{ ...row, disabled: undefined as unknown as boolean }], ""],
    [[{ ...row, disabled: 0 as unknown as boolean }], ""],
  ] as const) {
    const h = harness({ files: [...files] });
    assertError(await h.get({ credential: selection }));
    expect(h.calls).toHaveLength(1);
  }
});

test("selected multi-credential windows are display-only and use stable labels, never names or email", async () => {
  for (const credential of ["two", "index-two"]) {
    const h = harness({
      files: [row, { ...second, email: "private-response-marker" } as unknown as CPACredential],
    });
    const result = await h.get({ credential });
    expect((JSON.parse(String(h.calls[1].init?.body)) as { auth_index: string }).auth_index).toBe("index-two");
    expect(result.windows?.every(w => w.aside === true && w.name.endsWith("(Claude Second)"))).toBe(true);
    expect(JSON.stringify(result).includes("private-response-marker")).toBe(false);
  }
  const h = harness({ files: [row, { ...second, label: undefined }] });
  expect((await h.get({ credential: "two" })).windows?.[0].name).toMatch(/Claude index-tw/);
  const single = harness();
  expect((await single.get({ credential: "one" })).windows?.[0].aside).toBeUndefined();
});

test("auth_index must be a nonempty string of at most 128 characters", async () => {
  for (const auth_index of [undefined, null, 1, "", " ", "x".repeat(129)]) {
    const h = harness({ files: [{ ...row, auth_index: auth_index as string }] });
    assertError(await h.get());
    expect(h.calls).toHaveLength(1);
  }
  const h = harness({ files: [{ ...row, auth_index: "x".repeat(128) }] });
  expect((await h.get()).windows).toHaveLength(2);
});

test("management 401/403 including IP-ban 403 stop all automatic retries", async () => {
  for (const status of [401, 403]) {
    const h = harness({
      request: () => new Response("remote management disabled or IP banned; private-response-marker", { status }),
    });
    for (let i = 0; i < 10; i++) {
      assertError(await h.get());
      h.advance(1_800_000);
    }
    expect(h.calls).toHaveLength(1);
    assertError(await h.get({ credential: "another" }));
    expect(h.calls).toHaveLength(1);
    assertError(await h.get({ managementKey: "test-mgmt-key-replacement" }));
    expect(h.calls).toHaveLength(2);
  }
});

test("management auth failure at api-call also stops future credential requests", async () => {
  const h = harness({
    request: url =>
      url.endsWith("/credentials")
        ? Response.json({ files: [row] })
        : new Response("private-response-marker", { status: 403 }),
  });
  assertError(await h.get());
  h.advance(2_000_000);
  assertError(await h.get());
  expect(h.calls).toHaveLength(2);
});

test("management rejection drops cached quota even if response cancellation fails", async () => {
  let rejected = false;
  const h = harness({
    request: url => {
      if (rejected) {
        return {
          status: 401,
          body: {
            cancel() {
              throw new Error("private-response-marker");
            },
          },
        } as unknown as Response;
      }
      return Response.json(url.endsWith("/credentials") ? { files: [row] } : envelope());
    },
  });
  expect((await h.get()).windows?.[0].used).toBe(25);
  rejected = true;
  h.advance(300_000);
  assertError(await h.get());
  assertError(await h.get());
  expect(h.calls).toHaveLength(3);
});

test("temporary management/network errors back off 300 seconds without leaking exception text", async () => {
  for (const failure of [500, 429, "network"] as const) {
    const h = harness({
      request: () => {
        if (failure === "network") throw new Error(`${managementKey} private-response-marker`);
        return new Response("private-response-marker", { status: failure });
      },
    });
    assertError(await h.get());
    h.advance(299_999);
    assertError(await h.get());
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    assertError(await h.get());
    expect(h.calls).toHaveLength(2);
  }
});

test("inner non-200 status never creates a valid quota or permanently blocks management", async () => {
  for (const status of [401, 429, 500, 201, "200", undefined]) {
    const h = harness({ usage: { status_code: status, body: JSON.stringify(data()) } });
    assertError(await h.get());
    expect(h.calls).toHaveLength(2);
    h.usage = envelope();
    h.advance(300_000);
    expect((await h.get()).windows?.[0].used).toBe(25);
    expect(h.calls).toHaveLength(4);
  }
});

test("invalid JSON and envelopes do not turn unknown quota into zero", async () => {
  for (const body of ["private-response-marker", "null", "{}", '{"files":{}}']) {
    const h = harness({ request: () => new Response(body) });
    assertError(await h.get());
  }
  for (const usage of [
    { status_code: 200 },
    { status_code: 200, body: {} },
    { status_code: 200, body: "private-response-marker" },
    envelope(null),
    envelope({}),
  ]) {
    assertError(await harness({ usage }).get());
  }
});

test("only valid known percentage windows survive; values over 100 are preserved", async () => {
  const h = harness({
    usage: envelope({
      five_hour: win(125),
      seven_day: win(0, null),
      seven_day_sonnet: win(99),
      new_future_window: { anything: true },
      limits: [{ unknown: true }],
    }),
  });
  expect((await h.get()).windows).toEqual([
    { name: "5 hours", used: 125, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" },
    { name: "7 days", used: 0, span: 604800 },
  ]);
  for (const invalid of [
    null,
    {},
    win(-1),
    win("0" as unknown as number),
    win(true as unknown as number),
    win(null as unknown as number),
    win(1, null),
    win(0, "not-a-date"),
    { utilization: 0 },
  ]) {
    const one = await harness({ usage: envelope({ five_hour: invalid, seven_day: win(10) }) }).get();
    expect(one.windows).toHaveLength(1);
    expect(one.windows?.[0].name).toBe("7 days");
    assertError(await harness({ usage: envelope({ five_hour: invalid }) }).get());
  }
  const body = `{"five_hour":{"utilization":1e999,"resets_at":"${reset}"}}`;
  assertError(await harness({ usage: { status_code: 200, body } }).get());
});

test("oversized credentials and api-call streams are cancelled at their own limits", async () => {
  for (const path of ["/credentials", "/requests/api-call"]) {
    let cancelled = false;
    let pulls = 0;
    const h = harness({
      request: url => {
        if (!url.endsWith(path)) return Response.json({ files: [row] });
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(100_000));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    assertError(await h.get());
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(path === "/credentials" ? 12 : 4);
  }
});

test("five concurrent calls share exactly one credentials plus api-call pair", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const h = harness({
    request: async url => {
      if (url.endsWith("/credentials")) {
        started();
        await gate;
        return Response.json({ files: [row] });
      }
      return Response.json(envelope());
    },
  });
  const pending = Array.from({ length: 5 }, () => h.get());
  await ready;
  expect(h.calls).toHaveLength(1);
  release();
  const results = await Promise.all(pending);
  expect(results.every(result => result.windows?.[0].used === 25 && result.signIn === "kept")).toBe(true);
  expect(h.calls).toHaveLength(2);
});

test("success cache expires at 300s; transient failure preserves at most 900s old readings; repeated failures back off", async () => {
  const h = harness();
  const first = await h.get();
  h.advance(299_999);
  expect(await h.get()).toEqual(first);
  expect(h.calls).toHaveLength(2);
  h.advance(1);
  h.usage = envelope(data(), 500);
  expect(await h.get()).toEqual(first);
  expect(h.calls).toHaveLength(4);
  h.advance(299_999);
  expect(await h.get()).toEqual(first);
  expect(h.calls).toHaveLength(4);
  h.advance(300_001);
  expect(await h.get()).toEqual(first);
  h.advance(1);
  assertError(await h.get());
  h.usage = envelope({ five_hour: win(5), seven_day: win(10) });
  h.advance(300_000);
  assertError(await h.get());
  expect(h.calls).toHaveLength(7);
  expect(h.calls.at(-1)?.url.endsWith("/credentials")).toBe(true);
  h.advance(300_000);
  expect((await h.get()).windows?.[0].used).toBe(5);
  expect(h.calls).toHaveLength(9);
});

test("inner failure never replaces a cached reading with its plausible body", async () => {
  for (const status of [401, 429, 500]) {
    const h = harness();
    const first = await h.get();
    h.advance(300_000);
    h.usage = envelope({ five_hour: win(99) }, status);
    expect(await h.get()).toEqual(first);
  }
});

test("a newly multiple credential pool replaces old routing windows with aside windows", async () => {
  const h = harness();
  await h.get();
  h.advance(300_000);
  h.files = [row, second];
  const result = await h.get();
  expect(result.windows).toHaveLength(4);
  expect(result.windows?.every(window => window.aside === true)).toBe(true);
});

test("cache is isolated by management key and endpoint; selections naming one credential share it", async () => {
  const h = harness();
  await h.get();
  for (const metadata of [
    { managementKey: "test-mgmt-key-other" },
    { managementURL: "https://management.example.invalid/private" },
  ]) {
    await h.get(metadata);
  }
  expect(h.calls).toHaveLength(6);
  for (const credential of ["one", "index-one"]) expect((await h.get({ credential })).windows?.[0].used).toBe(25);
  await h.get();
  expect(h.calls).toHaveLength(6);
  h.advance(15_000);
  await h.get({ credential: "other-selection-same-scope" });
  expect(h.calls).toHaveLength(7);
  expect(h.calls.at(-1)?.url.endsWith("/credentials")).toBe(true);
});

test("management credentials stay at the explicit management endpoint, never the OAuth target", async () => {
  const h = harness();
  await h.get({ managementURL: "https://management.example.invalid/custom/" });
  for (const call of h.calls) {
    expect(call.url.startsWith("https://management.example.invalid/custom/")).toBe(true);
    expect(call.url.startsWith("https://api.anthropic.com/")).toBe(false);
    expect(String(call.init?.body ?? "").includes(managementKey)).toBe(false);
  }
  const bad = harness();
  assertError(await bad.get({ managementURL: "https://user:password@example.invalid/" }));
  expect(bad.calls).toHaveLength(0);
});

test("one shared 15s deadline bounds both stages even if the request ignores cancellation", async () => {
  const controller = new AbortController();
  const budgets: number[] = [];
  const h = harness({
    timeout: ms => {
      budgets.push(ms);
      return budgets.length === 1 ? controller.signal : new AbortController().signal;
    },
    request: (url, init, clock) => {
      expect(init?.signal).toBe(controller.signal);
      if (url.endsWith("/credentials")) {
        clock.advance(10_000);
        return Response.json({ files: [row] });
      }
      clock.advance(6_000);
      controller.abort(new DOMException("private-response-marker", "TimeoutError"));
      return new Promise(() => {});
    },
  });
  assertError(await h.get());
  expect(budgets).toEqual([15000]);
  expect(h.calls).toHaveLength(2);
  assertError(await h.get());
  expect(h.calls).toHaveLength(2);
});

test("single-flight waiters return within the shared request budget", async () => {
  const controllers: AbortController[] = [];
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const h = harness({
    timeout: ms => {
      expect(ms).toBe(15000);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    },
    request: () => {
      started();
      return new Promise(() => {});
    },
  });
  const first = h.get();
  await ready;
  const others = Array.from({ length: 4 }, () => h.get());
  await Promise.resolve();
  await Promise.resolve();
  controllers[0].abort(new DOMException("timed out", "TimeoutError"));
  for (const result of await Promise.all([first, ...others])) assertError(result);
  expect(h.calls).toHaveLength(1);
});

test("getAuth and other internal exceptions always resolve to kept errors", async () => {
  const h = harness();
  assertError(
    await h.read(() => {
      throw new Error(managementKey);
    }),
  );
  assertError(await h.get({ baseURL: "invalid" }));
  assertError(await h.get({ credential: {} }));
  assertError(await h.get({ managementKey: {} }));
  const brokenClock = _internal.createUsage({
    now: () => {
      throw new Error(managementKey);
    },
  });
  assertError(await brokenClock(() => account()));
});

test("real management redirects are rejected without sending the key to their target", async () => {
  let targetRequests = 0;
  const target = createServer((_req, res) => {
    targetRequests++;
    res.end("unexpected");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");

  const source = createServer((_req, res) => {
    const targetPort = (target.address() as AddressInfo).port;
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/leak` });
    res.end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");

  try {
    const read = _internal.createUsage();
    const sourcePort = (source.address() as AddressInfo).port;
    assertError(await read(() => account({ managementURL: `http://127.0.0.1:${sourcePort}` })));
    expect(targetRequests).toBe(0);
  } finally {
    for (const server of [source, target]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test("provider adapter dispatches its own request template and parser through the shared cache", async () => {
  let parsed = 0;
  const template = {
    method: "GET",
    url: "https://usage.example.invalid/mock",
    header: { Authorization: "Bearer $TOKEN$", Accept: "application/json" },
  };
  const adapter: UsageAdapter = {
    async read(apiCall, credential) {
      expect(credential.auth_index).toBe(row.auth_index);
      const body = (await apiCall(template)) as { percent: number };
      parsed++;
      expect(body).toEqual({ percent: 17 });
      return { windows: [{ name: "Mock window", used: body.percent, span: 3600 }] };
    },
  };
  const h = harness({
    adapters: { mock: adapter },
    files: [{ ...row, provider: "mock" }],
    usage: envelope({ percent: 17 }),
  });
  const result = await h.get();
  expect(result).toEqual({ signIn: "kept", windows: [{ name: "Mock window", used: 17, span: 3600 }] });
  expect(JSON.parse(String(h.calls[1].init?.body))).toEqual({ ...template, auth_index: row.auth_index });
  expect(new Headers(h.calls[1].init?.headers).get("authorization")).toBe(`Bearer ${managementKey}`);
  expect(await h.get()).toEqual(result);
  expect(parsed).toBe(1);
  expect(h.calls).toHaveLength(2);
});

test("unsupported providers never fall back to Claude or call api-call, including inherited object names", async () => {
  for (const provider of ["other", "constructor", "__proto__", undefined]) {
    for (const credential of ["", "two", "index-two"]) {
      const unsupported = { ...second, provider: provider as string };
      const h = harness({ files: credential ? [row, unsupported] : [unsupported] });
      const result = await h.get({ credential });
      assertError(result);
      expect(result.error).toBe("当前供应商暂不支持额度查询");
      expect(h.calls).toHaveLength(1);
    }
  }
});

test("automatic selection uses the sole enabled supported credential; a mixed pool stays display-only", async () => {
  const h = harness({
    files: [
      { ...second, provider: "other" },
      row,
      { ...second, auth_index: "disabled", disabled: true },
    ],
  });
  const result = await h.get();
  expect((JSON.parse(String(h.calls[1].init?.body)) as { auth_index: string }).auth_index).toBe(row.auth_index);
  expect(result.windows?.every(w => w.aside === true && w.name.endsWith("(Claude First)"))).toBe(true);
});

test("several supported providers display all or the explicit selection with the aside rule", async () => {
  const adapter: UsageAdapter = {
    read: async apiCall => {
      await apiCall({ method: "GET", url: "https://usage.example.invalid/mock", header: {} });
      return { windows: [{ name: "Mock window", used: 10, span: 3600 }] };
    },
  };
  const h = harness({
    adapters: { mockA: adapter, mockB: adapter },
    files: [
      { ...row, provider: "mockA" },
      { ...second, provider: "mockB" },
    ],
  });
  const all = await h.get();
  expect(all.windows).toHaveLength(2);
  expect(all.windows?.every(window => window.aside)).toBe(true);
  expect(h.calls).toHaveLength(3);
  const result = await h.get({ credential: "index-two" });
  expect(h.calls).toHaveLength(3);
  expect(result.windows).toEqual([{ name: "Mock window (mockB Second)", used: 10, span: 3600, aside: true }]);
  expect(result.signIn).toBe("kept");
});

test("unsupported selection replaces old quota with an error instead of reusing routing windows", async () => {
  const h = harness();
  expect((await h.get()).windows?.[0].used).toBe(25);
  h.advance(300_000);
  h.files = [{ ...row, provider: "other" }];
  assertError(await h.get());
  expect(h.calls).toHaveLength(3);
});

test("new adapters retain the common management rejection circuit breaker", async () => {
  const h = harness({
    adapters: {
      mock: {
        read: async apiCall => {
          await apiCall({ method: "GET", url: "https://usage.example.invalid/mock" });
          throw new Error("must not parse rejected response");
        },
      },
    },
    files: [{ ...row, provider: "mock" }],
    request: url =>
      url.endsWith("/credentials")
        ? Response.json({ files: h.files })
        : new Response("private-response-marker", { status: 403 }),
  });
  for (let i = 0; i < 10; i++) {
    assertError(await h.get());
    h.advance(1_800_000);
  }
  expect(h.calls).toHaveLength(2);
});
