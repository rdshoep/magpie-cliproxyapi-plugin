import { expect, spyOn, test } from "bun:test";
import plugin, { _internal } from "../index.ts";
import type { CPACredential, FetchLike, PluginAuth } from "../src/types.ts";

const start = Date.parse("2026-11-14T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const auth: PluginAuth = {
  type: "api",
  key: "fictional-business",
  metadata: {
    baseURL: "https://cpa.example.invalid",
    managementKey: "fictional-management",
  },
};
const file = (name: string, provider = "codex"): CPACredential => ({
  name,
  provider,
  auth_index: `${name}-index`,
  disabled: false,
});
const usage = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 25,
      limit_window_seconds: 18000,
      reset_at: start / 1000 + 86400,
    },
  },
};
const credit = (id = "first", expires_at = iso(start + 86400000)) => ({
  id,
  status: "available",
  reset_type: "codex_rate_limits",
  expires_at,
});
const inventory = () => ({ available_count: 2, credits: [credit("later", iso(start + 172800000)), credit()] });
const signals = (at: number) => ({
  observed_at: iso(at),
  signals: {
    "x-codex-primary-used-percent": "40",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(start / 1000 + 86400),
    "x-codex-secondary-used-percent": "50",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(start / 1000 + 604800),
  },
});

function harness(files: CPACredential[] = [file("one")]) {
  let clock = start;
  const h = {
    files,
    payload: structuredClone(usage) as Record<string, unknown>,
    inventory: inventory() as unknown,
    models: {} as Record<string, unknown>,
    calls: [] as Array<{ url: string; init?: RequestInit }>,
    inventoryStatus: 200,
    modelStatus: {} as Record<string, number>,
    usageStatus: 0,
    inventoryFailure: false,
    inventoryManagementStatus: 0,
    modelGate: undefined as (() => Promise<void>) | undefined,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };

  const request: FetchLike = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    expect(/config|api-key|download|consume|reset_rate_limits/.test(url)).toBe(false);
    h.calls.push({ url, init });
    if (path.endsWith("/credentials")) return Response.json({ files: h.files });
    if (path.endsWith("/credentials/models")) {
      expect(init?.method).toBe("GET");
      const name = new URL(url).searchParams.get("name") ?? "";
      if (h.modelGate) await h.modelGate();
      return Response.json(h.models[name] ?? { models: [] }, { status: h.modelStatus[name] ?? 200 });
    }
    expect(path.endsWith("/requests/api-call")).toBe(true);
    const body = JSON.parse(String(init?.body)) as { method: string; url: string };
    expect(body.method).toBe("GET");
    expect(/consume|reset_rate_limits/.test(body.url)).toBe(false);
    const resets = body.url.endsWith("/rate-limit-reset-credits");
    expect(
      resets || body.url.endsWith("/wham/usage") || body.url.includes("anthropic.com/api/oauth/usage"),
    ).toBe(true);
    if (resets && h.inventoryFailure) throw new TypeError("private transport details");
    if (resets && h.inventoryManagementStatus) return new Response("private", { status: h.inventoryManagementStatus });
    if (body.url.endsWith("/wham/usage") && h.usageStatus) {
      return Response.json({ status_code: h.usageStatus, body: "{}" });
    }
    const data = body.url.includes("anthropic.com")
      ? { five_hour: { utilization: 25, resets_at: iso(start + 86400000) } }
      : resets
        ? h.inventory
        : h.payload;
    return Response.json({ status_code: resets ? h.inventoryStatus : 200, body: JSON.stringify(data) });
  };

  const read = _internal.createUsage({ now: () => clock, request });

  return Object.assign(h, {
    get: (routing = true, credential?: string) =>
      read(() => ({
        ...auth,
        metadata: {
          ...auth.metadata,
          ...(routing ? { modelRouting: "enabled" as const } : {}),
          ...(credential ? { credential } : {}),
        },
      })),
    inner: (suffix: string) =>
      h.calls.filter(c => c.init?.body && (JSON.parse(String(c.init.body)) as { url: string }).url.endsWith(suffix)),
    memberships: () => h.calls.filter(c => new URL(c.url).pathname.endsWith("/credentials/models")),
  });
}

test("Codex selects Responses and only its channel definitions, preserving IDs and API options", async () => {
  const rows = [
    { id: "gpt-test-20261114[1m]", owned_by: "openai" },
    { id: "alias", owned_by: "openai" },
    { id: "claude-test", owned_by: "openai" },
    { id: "compat", owned_by: "custom" },
    { id: "unknown" },
  ];
  const paths: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
    const s = String(url);
    paths.push(s);
    if (s.includes("model-definitions/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fictional-management");
      return Response.json({
        models: [
          { id: "gpt-test", thinking: { levels: [" low ", "xhigh", "low"] } },
          { id: "alias", thinking: { levels: ["high"] } },
          { id: "compat", thinking: { levels: ["max"] } },
        ],
      });
    }
    return Response.json({ data: rows });
  }) as typeof fetch);

  try {
    const hooks = await plugin();
    const configured = { api: { id: "wrong-alias", url: "https://override.example.invalid", npm: "@ai-sdk/anthropic" } };
    const models = await hooks.provider.models(
      {
        models: {
          [rows[0].id]: configured,
          alias: { variants: { custom: {} }, capabilities: { reasoning: false } },
        },
      },
      { auth },
    );
    expect(models[rows[0].id].api).toEqual({ url: configured.api.url, npm: "@ai-sdk/openai" });
    expect(models[rows[0].id].variants).toEqual({ low: {}, xhigh: {} });
    expect(models[rows[0].id].id).toBe(rows[0].id);
    expect(configured.api.id).toBe("wrong-alias");
    expect(models.alias.variants).toEqual({ custom: {} });
    expect(models.alias.capabilities?.reasoning).toBe(false);
    for (const id of ["claude-test", "compat", "unknown"]) expect(models[id].api).toBeUndefined();
    expect(paths).toHaveLength(4);
    expect(paths.map(url => new URL(url).pathname).sort()).toEqual([
      "/v1/models",
      "/v1/models",
      "/v8/management/routing/model-definitions/claude",
      "/v8/management/routing/model-definitions/codex",
    ]);
    const bare = await hooks.provider.models({}, { auth: { ...auth, metadata: { baseURL: auth.metadata?.baseURL } } });
    expect(bare.alias.api?.npm).toBe("@ai-sdk/openai");
    expect(bare.alias.variants).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("Claude and Codex definitions run in parallel and fail independently", async () => {
  for (const failing of ["claude", "codex"]) {
    const releases: Array<() => void> = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("model-definitions/")) {
        await new Promise<void>(resolve => {
          releases.push(resolve);
        });
        return s.endsWith(failing)
          ? new Response("bad", { status: 500 })
          : Response.json({
              models: [
                { id: "gpt-test", thinking: { levels: ["xhigh"] } },
                { id: "claude-test", thinking: { levels: ["max"] } },
              ],
            });
      }
      return Response.json({
        data: [
          { id: "gpt-test", owned_by: "openai" },
          { id: "claude-test", owned_by: "anthropic" },
        ],
      });
    }) as typeof fetch);

    try {
      const pending = (await plugin()).provider.models({}, { auth });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(releases).toHaveLength(2);
      releases.forEach(resolve => resolve());
      const models = await pending;
      expect(models[failing === "claude" ? "gpt-test" : "claude-test"].capabilities?.reasoning).toBe(true);
      expect(models[failing === "claude" ? "claude-test" : "gpt-test"].variants).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  }
});

test("Codex reset cards use GET-only inventory, correct headers and sorted Magpie shape", async () => {
  const h = harness([{ ...file("one"), id_token: { chatgpt_account_id: "fictional-account" } }]);
  const result = await h.get();
  expect(result.resets).toEqual({
    count: 2,
    byWindow: false,
    until: iso(start + 86400000),
    each: [{ until: iso(start + 86400000) }, { until: iso(start + 172800000) }],
  });
  const req = JSON.parse(String(h.inner("/rate-limit-reset-credits")[0].init?.body)) as {
    header: Record<string, string>;
  };
  expect(req.header["Chatgpt-Account-Id"]).toBe("fictional-account");
  expect(req.header["OpenAI-Beta"]).toBe("codex-1");
  expect(req.header.Originator).toBe("Codex Desktop");
  expect(req.header.Accept).toBe("application/json");
  expect(JSON.stringify(result).includes("fictional-account")).toBe(false);
  expect(result.resets?.each?.every(card => !Object.hasOwn(card, "window"))).toBe(true);
});

test("Codex usage inventory wins and avoids a details request; mismatched counts omit each", async () => {
  const h = harness();
  h.payload.rate_limit_reset_credits = inventory();
  expect((await h.get()).resets?.count).toBe(2);
  expect(h.inner("/rate-limit-reset-credits")).toHaveLength(0);
  const mismatch = harness();
  (mismatch.inventory as { available_count: number }).available_count = 3;
  expect((await mismatch.get()).resets).toEqual({ count: 3, byWindow: false, until: iso(start + 86400000) });
});

test("Codex inventory failures and malformed blocks keep windows and back off per credential", async () => {
  for (const status of [400, 403, 404, 429, 500]) {
    const h = harness();
    h.inventoryStatus = status;
    expect((await h.get()).resets).toBeUndefined();
    for (let i = 1; i < 6; i++) {
      h.advance(300000);
      expect((await h.get()).windows?.[0].used).toBe(25);
    }
    expect(h.inner("/rate-limit-reset-credits")).toHaveLength(1);
    h.advance(300000);
    h.inventoryStatus = 200;
    expect((await h.get()).resets?.count).toBe(2);
    expect(h.inner("/rate-limit-reset-credits")).toHaveLength(2);
  }
  for (const blk of [
    null,
    {},
    { available_count: -1 },
    { available_count: "2" },
    { available_count: 1.5 },
    { ...inventory(), credits: [credit(), credit()] },
  ]) {
    const h = harness();
    h.inventory = blk;
    expect((await h.get()).resets).toBeUndefined();
    expect((await h.get()).windows).toHaveLength(1);
  }
});

test("fresh Codex signals read only inventory, once every 30 minutes, with shared memo", async () => {
  const h = harness();
  for (let i = 0; i <= 6; i++) {
    h.files[0].quota = signals(h.now());
    const result = await h.get();
    expect(result.windows?.[0].used).toBe(40);
    expect(result.resets?.count).toBe(2);
    if (i < 6) h.advance(300000);
  }
  expect(h.inner("/wham/usage")).toHaveLength(0);
  expect(h.inner("/rate-limit-reset-credits")).toHaveLength(2);
  await h.get(true, "one");
  await h.get(true, "one-index");
  expect(h.inner("/rate-limit-reset-credits")).toHaveLength(2);
});

test("Codex cached cards expire and multi-credential views omit resets", async () => {
  const h = harness();
  h.inventory = { available_count: 1, credits: [credit("short", iso(start + 300000))] };
  expect((await h.get()).resets?.count).toBe(1);
  h.advance(300000);
  expect((await h.get()).resets).toBeUndefined();
  const pool = harness([file("one"), file("two")]);
  expect((await pool.get()).resets).toBeUndefined();
  expect((await pool.get(true, "one")).resets?.count).toBe(2);
});

test("Codex null inventory and transport failures do not create repeated detail reads", async () => {
  const h = harness();
  h.payload.rate_limit_reset_credits = null;
  h.inventoryFailure = true;
  expect((await h.get()).windows).toHaveLength(1);
  h.advance(300000);
  await h.get();
  expect(h.inner("/rate-limit-reset-credits")).toHaveLength(1);
  expect((await h.get()).resets).toBeUndefined();
  for (const status of [401, 403]) {
    const denied = harness();
    denied.inventoryManagementStatus = status;
    expect((await denied.get()).error).toMatch(/管理接口拒绝访问|管理密钥无效/);
    const count = denied.calls.length;
    denied.advance(3600000);
    await denied.get();
    expect(denied.calls).toHaveLength(count);
  }
});

test("an inventory-only refresh retains the known Codex plan", async () => {
  const h = harness();
  expect((await h.get()).plan).toBe("plus");
  h.advance(1800000);
  h.files[0].quota = signals(h.now());
  expect((await h.get()).plan).toBe("plus");
  expect(h.inner("/wham/usage")).toHaveLength(1);
  expect(h.inner("/rate-limit-reset-credits")).toHaveLength(2);
});

test("a stalled optional inventory times out before the shared budget and keeps valid windows", async () => {
  let inventorySignal: AbortSignal | undefined;
  const read = _internal.createUsage({
    now: () => start,
    timeout: ms => AbortSignal.timeout(ms === 3000 ? 5 : ms),
    request: async (url, init) => {
      if (String(url).endsWith("/credentials")) return Response.json({ files: [file("one")] });
      const template = JSON.parse(String(init?.body)) as { url: string };
      if (template.url.endsWith("/rate-limit-reset-credits")) {
        inventorySignal = init?.signal ?? undefined;
        return new Promise(() => {});
      }
      return Response.json({ status_code: 200, body: JSON.stringify(usage) });
    },
  });
  const alive = setTimeout(() => {}, 1000);
  try {
    const result = await read(() => auth);
    expect(result.windows?.[0].used).toBe(25);
    expect(result.resets).toBeUndefined();
    expect(inventorySignal?.aborted).toBe(true);
  } finally {
    clearTimeout(alive);
  }
});

test("a late usage response skips optional inventory to preserve its valid windows", async () => {
  let now = start;
  let details = 0;
  const read = _internal.createUsage({
    now: () => now,
    request: async (url, init) => {
      if (String(url).endsWith("/credentials")) return Response.json({ files: [file("one")] });
      if ((JSON.parse(String(init?.body)) as { url: string }).url.endsWith("/rate-limit-reset-credits")) details++;
      now += 14500;
      return Response.json({ status_code: 200, body: JSON.stringify(usage) });
    },
  });
  expect((await read(() => auth)).windows?.[0].used).toBe(25);
  expect(details).toBe(0);
});

test("model routing opt-in defaults off and authorize only persists an explicit enable", async () => {
  const method = (await plugin()).auth.methods[0];
  const prompt = method.prompts.find(p => p.key === "modelRouting")!;
  expect(prompt.type).toBe("select");
  expect(prompt.options?.[0].value).toBe("disabled");
  expect(prompt.message).toMatch(/config API keys, openai-compatibility or plugins/);
  for (const modelRouting of [undefined, "disabled", "true"]) {
    const res = await method.authorize({
      baseURL: auth.metadata?.baseURL as string,
      businessKey: auth.key,
      modelRouting,
    });
    expect(res.type === "success" ? res.metadata.modelRouting : "unexpected").toBeUndefined();
  }
  const enabledRes = await method.authorize({
    baseURL: auth.metadata?.baseURL as string,
    businessKey: auth.key,
    modelRouting: "enabled",
  });
  expect(enabledRes.type === "success" ? enabledRes.metadata.modelRouting : undefined).toBe("enabled");
  const h = harness([file("one"), file("two")]);
  expect((await h.get(false)).windows?.every(w => w.aside)).toBe(true);
  expect(h.memberships()).toHaveLength(0);
});

test("model routing includes only exclusive IDs, dedupes membership and shares its 15s cache", async () => {
  const h = harness([file("one", "claude"), file("two")]);
  h.models.one = { models: [{ id: "claude-only" }, { id: "shared" }, { id: "SHARED" }] };
  h.models.two = { models: [{ id: "gpt-only" }, { id: "shared" }, { id: "gpt-only" }] };
  const [first, second] = await Promise.all([h.get(), h.get()]);
  expect(first).toEqual(second);
  expect(first.windows?.map(w => w.models)).toEqual([["claude-only"], ["gpt-only"]]);
  expect(first.windows?.every(w => !Object.hasOwn(w, "aside"))).toBe(true);
  expect(h.memberships()).toHaveLength(2);
  await h.get(false);
  expect(h.memberships()).toHaveLength(2);
  h.advance(300000);
  await h.get();
  expect(h.memberships()).toHaveLength(4);
});

test("unknown or failed model membership leaves the entire pool aside; explicit selection skips it", async () => {
  for (const failure of [500, "malformed", "empty", "shared", "unsupported"] as const) {
    const h = harness([file("one"), file("two", failure === "unsupported" ? "other" : "codex")]);
    h.models.one = { models: [{ id: "gpt-only" }] };
    h.models.two =
      failure === "malformed"
        ? { models: [{}] }
        : { models: failure === "shared" ? [{ id: "GPT-ONLY" }] : [] };
    if (failure === 500) h.modelStatus.two = 500;
    const result = await h.get();
    if (failure === "empty") expect(result.windows?.[0].models).toEqual(["gpt-only"]);
    else expect(result.windows?.every(w => w.aside && !w.models)).toBe(true);
    const before = h.memberships().length;
    expect((await h.get(true, "one")).windows?.every(w => w.aside)).toBe(true);
    expect(h.memberships()).toHaveLength(before);
  }
  const single = harness();
  expect((await single.get()).windows?.[0].aside).toBeUndefined();
  expect(single.memberships()).toHaveLength(0);
});

test("model membership management rejection stops the scope; concurrency stays at two", async () => {
  const h = harness(Array.from({ length: 5 }, (_, i) => file(String(i))));
  let running = 0;
  let peak = 0;
  h.modelGate = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>(resolve => setImmediate(resolve));
    running--;
  };
  await h.get();
  expect(peak).toBe(2);
  for (const status of [401, 403]) {
    const denied = harness([file("one"), file("two"), file("three")]);
    denied.modelStatus.one = status;
    expect((await denied.get()).error).toMatch(/管理接口拒绝访问|管理密钥无效/);
    const before = denied.calls.length;
    denied.advance(3600000);
    await denied.get(false, "two");
    expect(denied.calls).toHaveLength(before);
  }
});

test("model membership accepts credential ID, encodes names and leaves failed usage rows aside", async () => {
  const h = harness([{ ...file("one"), name: undefined, id: "file/id" }, file("two & private")]);
  h.models["file/id"] = { models: [{ id: "one-only" }] };
  h.models["two & private"] = { models: [{ id: "two-only" }] };
  expect((await h.get()).windows?.map(w => w.models)).toEqual([["one-only"], ["two-only"]]);
  expect(h.memberships().some(c => c.url.endsWith("name=two%20%26%20private"))).toBe(true);
  h.advance(300000);
  h.files[1].provider = "claude";
  h.usageStatus = 500;
  const result = await h.get();
  expect(result.windows?.find(w => w.name === "Codex one-inde")?.aside).toBe(true);
  expect(result.windows?.find(w => w.name.includes("5 hours"))?.models).toEqual(["two-only"]);
});
