import { expect, spyOn, test } from "bun:test";
import plugin from "../index.ts";
import type { PluginAuth, ProviderConfig } from "../src/types.ts";

const auth: PluginAuth = {
  type: "api",
  key: "test-biz-key-discovery",
  metadata: {
    baseURL: "https://cpa.example.invalid",
  },
};
const managementAuth: PluginAuth = {
  ...auth,
  metadata: { ...auth.metadata, managementKey: "test-mgmt-key-LEAKCHECK" },
};
const id = "claude-sonnet-4-5-20250929";
const row = { id, type: "model", display_name: "Claude Sonnet", max_input_tokens: 200000, max_tokens: 32000 };
const catalog = (rows: unknown[]) => ({
  data: rows,
  has_more: false,
  first_id: (rows[0] as { id?: string } | undefined)?.id ?? "",
  last_id: (rows.at(-1) as { id?: string } | undefined)?.id ?? "",
});
const discover = async (provider: ProviderConfig = {}, currentAuth: PluginAuth | undefined = auth) =>
  (await plugin()).provider.models(provider, { auth: currentAuth });

test("discovery requests both formats and keeps original IDs and known capabilities", async () => {
  const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push([input, init]);
    const headers = new Headers(init?.headers);
    if (headers.get("anthropic-version") !== "2023-06-01") {
      return Response.json({
        object: "list",
        data: [
          { id, object: "model", owned_by: "anthropic" },
          { id: "claude-new", object: "model" },
        ],
      });
    }
    return Response.json(catalog([row, { ...row, id: "claude-new", display_name: "New Claude" }]));
  }) as typeof fetch);

  try {
    const known = {
      limit: { context: 123456, output: 23456 },
      capabilities: { toolcall: true },
      api: { id: "different-alias", npm: "@ai-sdk/anthropic" },
    };
    const result = await discover({ models: { [id]: known } });
    expect(Object.keys(result)).toEqual([id, "claude-new"]);
    expect(result[id].id).toBe(id);
    expect(result[id].name).toBe("Claude Sonnet");
    expect(result[id].limit).toEqual(known.limit);
    expect(result[id].capabilities).toEqual(known.capabilities);
    expect(result[id].api?.id).toBeUndefined();
    expect(known.api.id).toBe("different-alias");
    expect(result["claude-new"]).toEqual({ id: "claude-new", name: "New Claude" });
    expect(calls).toHaveLength(2);
    const [input, init] = calls.find(([, callInit]) => new Headers(callInit?.headers).has("anthropic-version"))!;
    expect(input).toBe("https://cpa.example.invalid/v1/models");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(auth.key!);
    expect(JSON.stringify([...headers]).includes(String(managementAuth.metadata?.managementKey))).toBe(false);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  } finally {
    spy.mockRestore();
  }
});

test("keeps non-Claude model IDs and excludes only cloaking-encoded IDs", async () => {
  const ids = [id, "gpt-test", "gemini-test", "custom/claude-alias", "claude-fable-5-dd-tset-tpg"];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(catalog(ids.map(modelId => ({ id: modelId }))))
  ) as typeof fetch);
  try {
    const result = await discover();
    expect(Object.keys(result)).toEqual(ids.slice(0, -1));
    for (const modelId of ids.slice(0, -1)) {
      expect(result[modelId]).toEqual({ id: modelId, name: modelId });
    }
  } finally {
    spy.mockRestore();
  }
});

test("missing authentication makes no model request", async () => {
  const spy = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Unexpected request");
  });
  try {
    expect(await (await plugin()).provider.models({})).toEqual({});
    expect(spy.mock.calls).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

test("401 and 403 mark business sign-in expired without retrying", async () => {
  for (const status of [401, 403]) {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response("private error body", { status })
    ) as typeof fetch);
    try {
      let caught: (Error & { signIn?: string }) | undefined;
      try {
        await discover();
      } catch (err) {
        caught = err as Error & { signIn?: string };
      }
      expect(caught).toBeDefined();
      expect(caught?.signIn).toBe("expired");
      expect(caught?.message.includes("private")).toBe(false);
      expect(spy.mock.calls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  }
});

test("500 and network failures throw ordinary errors for host fallback", async () => {
  for (const response of [new Response("private error body", { status: 500 }), null]) {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      if (!response) throw new TypeError("fetch failed");
      return response;
    }) as typeof fetch);
    try {
      let caught: (Error & { signIn?: string }) | undefined;
      try {
        await discover();
      } catch (err) {
        caught = err as Error & { signIn?: string };
      }
      expect(caught).toBeDefined();
      expect(caught?.signIn).toBeUndefined();
      expect(caught?.message.includes("private")).toBe(false);
      expect(spy.mock.calls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  }
});

test("10-second timeout uses a signal and remains a fallback error", async () => {
  let timeout: number | undefined;
  const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    timeout = ms;
    return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    init?.signal?.throwIfAborted();
    return Response.json({});
  }) as typeof fetch);
  try {
    let caught: Error | undefined;
    try {
      await discover();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.name).toBe("TimeoutError");
    expect(timeout).toBe(10000);
  } finally {
    fetchSpy.mockRestore();
    timeoutSpy.mockRestore();
  }
});

test("malformed JSON and invalid list fields trigger fallback", async () => {
  for (const body of ["not JSON", "null", "{}", '{"data":null,"has_more":false}', JSON.stringify({ data: {} })]) {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(body)) as typeof fetch);
    try {
      let caught: (Error & { signIn?: string }) | undefined;
      try {
        await discover();
      } catch (err) {
        caught = err as Error & { signIn?: string };
      }
      expect(caught).toBeDefined();
      expect(caught?.signIn).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  }
});

test("valid empty and cloaking-only catalogs are successful empty results", async () => {
  for (const rows of [[], [{ ...row, id: "claude-fable-5-dd-encoded" }]]) {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json(catalog(rows))
    ) as typeof fetch);
    try {
      expect(await discover()).toEqual({});
    } finally {
      spy.mockRestore();
    }
  }
});

test("both model-list formats stop oversized chunked responses and cancel their bodies", async () => {
  for (const oversizedFormat of ["openai", "anthropic"] as const) {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(300000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const format = new Headers(init?.headers).has("anthropic-version") ? "anthropic" : "openai";
      return format === oversizedFormat ? new Response(stream) : Response.json(catalog([row]));
    }) as typeof fetch);
    try {
      if (oversizedFormat === "openai") {
        await expect(discover()).rejects.toThrow(/大小限制/);
      } else {
        expect(await discover()).toEqual({ [id]: { id, name: id } });
      }
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThanOrEqual(6);
    } finally {
      spy.mockRestore();
    }
  }
});

test("skips malformed rows and tolerates omitted type and has_more metadata", async () => {
  for (const has_more of [undefined, false, true]) {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({
        data: [null, {}, { id: "" }, { id: 3 }, { id: "  " }, { id, display_name: "Valid Claude" }],
        has_more,
      })
    ) as typeof fetch);
    try {
      expect(await discover()).toEqual({ [id]: { id, name: "Valid Claude" } });
    } finally {
      spy.mockRestore();
    }
  }
});

test("arbitrary model IDs remain own data properties without changing the model map prototype", async () => {
  const ids = ["__proto__", "constructor", "toString"];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(catalog(ids.map(modelId => ({ id: modelId }))))
  ) as typeof fetch);
  try {
    const models = await discover();
    expect(Object.getPrototypeOf(models)).toBe(Object.prototype);
    expect(Object.keys(models)).toEqual(ids);
    for (const modelId of ids) expect(models[modelId]).toEqual({ id: modelId, name: modelId });
    expect(Object.keys(JSON.parse(JSON.stringify(models)))).toEqual(ids);
  } finally {
    spy.mockRestore();
  }
});

test("management definitions expose deduplicated levels and match dated or [1m] IDs", async () => {
  const dated = "claude-opus-5-5-20261001[1m]";
  const legacy = "claude-sonnet-4-5";
  const calls: Array<[string, RequestInit | undefined]> = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const s = String(input);
    calls.push([s, init]);
    if (s.endsWith("/routing/model-definitions/claude")) {
      return Response.json({
        channel: "claude",
        models: [
          { id: "claude-opus-5-5", thinking: { levels: [" low ", "medium", "low", " ", "high"] } },
          { id: legacy, thinking: { min: 1024, max: 32000 } },
        ],
      });
    }
    return Response.json(catalog([{ id: dated }, { id: legacy }]));
  }) as typeof fetch);
  try {
    const result = await discover({}, managementAuth);
    expect(result[dated].variants).toEqual({ low: {}, medium: {}, high: {} });
    expect(result[dated].capabilities?.reasoning).toBe(true);
    expect(result[legacy]).toEqual({ id: legacy, name: legacy });
    expect(calls).toHaveLength(4);
    const modelCall = calls.find(
      ([input, init]) => input.endsWith("/v1/models") && new Headers(init?.headers).has("anthropic-version"),
    )!;
    const definitionCall = calls.find(([input]) => input.endsWith("/routing/model-definitions/claude"))!;
    const modelHeaders = new Headers(modelCall[1]?.headers);
    const definitionHeaders = new Headers(definitionCall[1]?.headers);
    expect(modelHeaders.get("x-api-key")).toBe(auth.key!);
    expect(modelHeaders.get("authorization")).toBeNull();
    expect(definitionHeaders.get("authorization")).toBe(`Bearer ${managementAuth.metadata?.managementKey}`);
    expect(definitionCall[1]?.redirect).toBe("error");
  } finally {
    spy.mockRestore();
  }
});

test("user variants and reasoning capability override generated values", async () => {
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) =>
    String(input).endsWith("/routing/model-definitions/claude")
      ? Response.json({ models: [{ id, thinking: { levels: ["low", "high"] } }] })
      : Response.json(catalog([{ id }]))
  ) as typeof fetch);
  try {
    const configured = {
      variants: { custom: { reasoningEffort: "custom" } },
      capabilities: { reasoning: false, toolcall: true },
    };
    const result = await discover({ models: { [id]: configured } }, managementAuth);
    expect(result[id].variants).toEqual(configured.variants);
    expect(result[id].capabilities).toEqual(configured.capabilities);
  } finally {
    spy.mockRestore();
  }
});

test("management definition failures downgrade without breaking discovery", async () => {
  for (const failure of [
    () => new Response("denied", { status: 401 }),
    () => new Response("failed", { status: 500 }),
    () => new Response("not JSON"),
    () => {
      throw new Error("timeout");
    },
  ]) {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      if (String(input).endsWith("/routing/model-definitions/claude")) return failure();
      return Response.json(catalog([{ id }]));
    }) as typeof fetch);
    try {
      const result = await discover({}, managementAuth);
      expect(result).toEqual({ [id]: { id, name: id } });
      expect(spy.mock.calls).toHaveLength(4);
    } finally {
      spy.mockRestore();
    }
  }
});

test("explicit management URL uses the shared v8 routing base", async () => {
  const explicitAuth: PluginAuth = {
    ...managementAuth,
    metadata: {
      ...managementAuth.metadata,
      managementURL: "https://cpa.example.invalid/v8/management",
    },
  };
  const calls: Array<[string, RequestInit | undefined]> = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const s = String(input);
    calls.push([s, init]);
    return s.endsWith("/routing/model-definitions/claude")
      ? Response.json({ models: [{ id, thinking: { levels: ["low"] } }] })
      : Response.json(catalog([{ id }]));
  }) as typeof fetch);
  try {
    const result = await discover({}, explicitAuth);
    expect(result[id].variants).toEqual({ low: {} });
    expect(calls).toHaveLength(4);
    expect(
      calls.some(([input]) => input === "https://cpa.example.invalid/v8/management/routing/model-definitions/claude"),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("no management key skips model definitions", async () => {
  const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(catalog([{ id }]))
  ) as typeof fetch);
  try {
    expect(await discover()).toEqual({ [id]: { id, name: id } });
    expect(spy.mock.calls).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
});

test("a management rejection during discovery stops later usage reads with the same key", async () => {
  const calls: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const s = String(input);
    calls.push(s);
    if (s.includes("/v8/management/")) return new Response("denied", { status: 401 });
    return Response.json(catalog([row]));
  }) as typeof fetch);
  try {
    const instance = await plugin();
    await instance.provider.models({}, { auth: managementAuth });
    await instance.provider.models({}, { auth: managementAuth });
    const usage = await instance.auth.usage(() => managementAuth);
    expect(usage.error).toMatch(/管理接口拒绝访问|管理密钥无效/);
    expect(calls.filter(url => url.includes("/v8/management/"))).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
});

test("mixed pools always take original OpenAI IDs, regardless of cloaking or Claude credential presence", async () => {
  for (const withClaude of [true, false]) {
    for (const cloaked of [true, false]) {
      const calls: Array<RequestInit | undefined> = [];
      const ids = [...(withClaude ? [id] : []), "gpt-test", "gemini-test"];
      const spy = spyOn(globalThis, "fetch").mockImplementation((async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls.push(init);
        const anthropic = new Headers(init?.headers).has("anthropic-version");
        return Response.json({
          data: ids
            .map(modelID => ({
              id: anthropic && cloaked && !modelID.startsWith("claude-") ? `claude-fable-5-dd-${modelID}` : modelID,
              ...(anthropic ? { display_name: `Named ${modelID}` } : {}),
            }))
            .concat([{ id: "claude-fable-5-dd-never" }]),
        });
      }) as typeof fetch);
      try {
        const result = await discover();
        expect(Object.keys(result)).toEqual(ids);
        for (const modelID of ids) expect(result[modelID].id).toBe(modelID);
        if (withClaude) expect(result[id].name).toBe(`Named ${id}`);
        expect(Object.keys(result).some(modelId => modelId.startsWith("claude-fable-5-dd-"))).toBe(false);
        expect(calls).toHaveLength(2);
        expect(calls[0]?.signal).toBe(calls[1]?.signal);
        expect(new Headers(calls[0]?.headers).get("authorization")).toBe(`Bearer ${auth.key}`);
      } finally {
        spy.mockRestore();
      }
    }
  }
});

test("pure Claude discovery deep-equals the main model and thinking-level output", async () => {
  const known = { limit: { context: 123456, output: 23456 }, api: { id: "alias", npm: "@ai-sdk/anthropic" } };
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).includes("/routing/")) {
      return Response.json({
        models: [{ id: "claude-sonnet-4-5", thinking: { levels: ["low", "high"] } }],
      });
    }
    return Response.json({
      data: [{ id, ...(new Headers(init?.headers).has("anthropic-version") ? { display_name: "Claude Sonnet" } : {}) }],
    });
  }) as typeof fetch);
  try {
    expect(await discover({ models: { [id]: known } }, managementAuth)).toEqual({
      [id]: {
        id,
        name: "Claude Sonnet",
        limit: known.limit,
        api: { npm: "@ai-sdk/anthropic" },
        variants: { low: {}, high: {} },
        capabilities: { reasoning: true },
      },
    });
  } finally {
    spy.mockRestore();
  }
});

test("either model-list format rejects business 401/403 instead of falling back to a partial list", async () => {
  for (const status of [401, 403]) {
    for (const rejectedFormat of ["openai", "anthropic"] as const) {
      const spy = spyOn(globalThis, "fetch").mockImplementation((async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const format = new Headers(init?.headers).has("anthropic-version") ? "anthropic" : "openai";
        return format === rejectedFormat ? new Response("private", { status }) : Response.json(catalog([row]));
      }) as typeof fetch);
      try {
        let caught: (Error & { signIn?: string }) | undefined;
        try {
          await discover();
        } catch (err) {
          caught = err as Error & { signIn?: string };
        }
        expect(caught?.signIn).toBe("expired");
        expect(caught?.message.includes("private")).toBe(false);
        expect(spy.mock.calls).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    }
  }
});

test("business rejection wins over the other list's transient failure, including failed body cancellation", async () => {
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) =>
    new Headers(init?.headers).has("anthropic-version")
      ? ({ ok: false, status: 403, body: { cancel() { throw new Error("private"); } } } as unknown as Response)
      : new Response("temporary", { status: 500 })
  ) as typeof fetch);
  try {
    let caught: (Error & { signIn?: string }) | undefined;
    try {
      await discover();
    } catch (err) {
      caught = err as Error & { signIn?: string };
    }
    expect(caught?.signIn).toBe("expired");
    expect(caught?.message).toMatch(/403/);
  } finally {
    spy.mockRestore();
  }
});

test("Anthropic name-list failures degrade to IDs while OpenAI list failures remain fatal", async () => {
  const failures = [
    () => new Response("private", { status: 503 }),
    () => {
      throw new TypeError("fetch failed");
    },
    () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
    () => new Response("not JSON"),
    () => Response.json({ data: {} }),
  ];
  for (const failure of failures) {
    for (const rejectedFormat of ["openai", "anthropic"] as const) {
      const spy = spyOn(globalThis, "fetch").mockImplementation((async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const format = new Headers(init?.headers).has("anthropic-version") ? "anthropic" : "openai";
        return format === rejectedFormat ? failure() : Response.json(catalog([row, { id: "gpt-test" }]));
      }) as typeof fetch);
      try {
        if (rejectedFormat === "openai") {
          await expect(discover()).rejects.toThrow();
        } else {
          expect(await discover()).toEqual({
            [id]: { id, name: id },
            "gpt-test": { id: "gpt-test", name: "gpt-test" },
          });
        }
        expect(spy.mock.calls).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    }
  }
});
