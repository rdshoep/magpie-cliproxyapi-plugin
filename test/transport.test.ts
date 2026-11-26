import { once } from "node:events";
import { createServer, type AddressInfo, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, spyOn, test } from "bun:test";
import plugin, { _internal } from "../index.ts";
import type { MagpieConfig, PluginAuth } from "../src/types.ts";

const bizKey = "test-biz-key-transport";
const managementKey = "test-mgmt-key-LEAKCHECK";
const baseURL = "https://cpa.example.invalid";
const auth = (): PluginAuth => ({ type: "api", key: bizKey, metadata: { baseURL, managementKey } });

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

test("URL validation rejects invalid or credential-bearing addresses", () => {
  for (const value of [
    undefined,
    "",
    "  ",
    "not-a-url",
    "/relative",
    "ftp://example.invalid",
    "file:///tmp/cpa",
    "https://user:secret@example.invalid",
    "https://user@example.invalid",
    "https://example.invalid?key=secret",
    "https://example.invalid?",
    "https://example.invalid#x",
    "https://example.invalid#",
  ]) {
    expect(() => _internal.normalizeURL(value)).toThrow();
  }
  for (const [value, expected] of [
    [" https://CPA.example.invalid/v1/// ", baseURL],
    ["https://cpa.example.invalid/proxy/v1/", `${baseURL}/proxy`],
    ["http://127.0.0.1:8317/", "http://127.0.0.1:8317"],
    ["http://[::1]:8317/v1", "http://[::1]:8317"],
  ]) {
    expect(_internal.normalizeURL(value)).toBe(expected);
  }
});

test("config registers only cpa and preserves existing configuration", async () => {
  const hooks = await plugin();
  const cfg: MagpieConfig = {};
  await hooks.config(cfg);
  expect(cfg.provider).toEqual({ cpa: { name: "CLIProxyAPI", npm: "@ai-sdk/anthropic", models: {} } });
  const existing = { name: "Existing", models: { kept: {} } };
  const custom: MagpieConfig = { provider: { cpa: existing, other: {} } };
  await hooks.config(custom);
  expect(custom.provider?.cpa).toBe(existing);
  expect(custom.provider?.other).toEqual({});
});

test("authorize is local, normalizes metadata and returns the business key separately", async () => {
  const hooks = await plugin();
  expect(hooks.auth.provider).toBe("cpa");
  const method = hooks.auth.methods[0];
  expect(method.type).toBe("api");
  expect(method.prompts.map(({ key, type }) => [key, type])).toEqual([
    ["baseURL", "text"],
    ["businessKey", "password"],
    ["managementKey", "password"],
    ["managementURL", "text"],
    ["credential", "text"],
    ["modelRouting", "select"],
    ["modelFilter", "text"],
    ["modelGroupPrefix", "select"],
    ["usageMode", "select"],
    ["checkConnection", "select"],
  ]);

  const spy = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Unexpected network request");
  });
  try {
    const result = await method.authorize({
      baseURL: "https://cpa.example.invalid:8317/v1/",
      businessKey: ` ${bizKey} `,
      managementURL: "https://management.example.invalid/v8/management/",
      managementKey: ` ${managementKey} `,
      credential: " credential-one ",
    });
    expect(result).toEqual({
      type: "success",
      key: bizKey,
      metadata: {
        baseURL: "https://cpa.example.invalid:8317",
        email: "cpa@cpa.example.invalid:8317",
        managementURL: "https://management.example.invalid/v8/management",
        managementKey,
        credential: "credential-one",
      },
    });
    if (result.type === "success") {
      expect("businessKey" in result.metadata).toBe(false);
      expect("key" in result.metadata).toBe(false);
      expect(JSON.stringify(result.metadata).includes(bizKey)).toBe(false);
    }

    expect(await method.authorize({ baseURL, businessKey: bizKey })).toEqual({
      type: "success",
      key: bizKey,
      metadata: { baseURL, email: "cpa@cpa.example.invalid" },
    });
    expect(
      await method.authorize({
        baseURL,
        businessKey: bizKey,
        managementKey: " ",
        managementURL: " ",
        credential: " ",
      }),
    ).toEqual(await method.authorize({ baseURL, businessKey: bizKey }));

    const keyPrompt = method.prompts[1];
    for (const businessKey of [undefined, "", " \t\n "]) {
      expect(keyPrompt.validate?.(businessKey)).toBe("请填写业务 API Key");
      expect(await method.authorize({ baseURL, businessKey })).toEqual({
        type: "failed",
        error: "请填写业务 API Key",
      });
    }
    expect(keyPrompt.validate?.(` ${bizKey} `)).toBeUndefined();
    expect((await method.authorize({ baseURL })).type).toBe("failed");
    expect(
      (await method.authorize({ baseURL, businessKey: bizKey, managementURL: "https://user:secret@example.invalid" }))
        .type,
    ).toBe("failed");
    expect((await method.authorize({ baseURL: "not-a-url", businessKey: bizKey })).type).toBe("failed");
    expect(spy.mock.calls).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

test("loader keeps request data, caller UA and cancellation signal without adding management credentials", async () => {
  const hooks = await plugin();
  const loader = await hooks.auth.loader(auth);
  expect(loader.baseURL).toBe(`${baseURL}/v1`);
  expect(loader.apiKey).toBe(bizKey);
  expect(await hooks.auth.loader(() => undefined)).toEqual({});

  const response = new Response('{"error":"rate_limited"}', { status: 429 });
  const spy = spyOn(globalThis, "fetch").mockImplementation((async () => response) as typeof fetch);
  try {
    const input = new URL(`${baseURL}/v1/messages`);
    const headers = new Headers({
      "x-api-key": bizKey,
      "user-agent": "test-caller",
      "content-type": "application/json",
    });
    const body = JSON.stringify({ model: "claude-test", messages: [] });
    const controller = new AbortController();
    const result = await loader.fetch!(input, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "follow",
    });
    expect(result).toBe(response);
    expect(result.status).toBe(429);
    expect(await result.text()).toBe('{"error":"rate_limited"}');
    expect(spy.mock.calls).toHaveLength(1);
    const [receivedInput, init] = spy.mock.calls[0];
    expect(receivedInput).toBe(input);
    expect(init?.headers).toBe(headers);
    expect(init?.body).toBe(body);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Headers).get("user-agent")).toBe("test-caller");
    expect(JSON.stringify([...(init?.headers as Headers)]).includes(managementKey)).toBe(false);
    expect(String(init?.body).includes(managementKey)).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test("real fetch rejects redirects without reaching the destination", async () => {
  let redirected = 0;
  await withLocalServer(
    (_req, res) => {
      redirected++;
      res.end("unexpected");
    },
    async target => {
      await withLocalServer(
        (_req, res) => {
          res.writeHead(302, { Location: `${target}/destination` });
          res.end();
        },
        async source => {
          const loader = await (await plugin()).auth.loader(() => ({
            ...auth(),
            metadata: { baseURL: source, managementKey },
          }));
          await expect(loader.fetch!(`${source}/v1/messages`)).rejects.toThrow(TypeError);
          expect(redirected).toBe(0);
        },
      );
    },
  );
});

test("abort signal cancels an in-flight request", async () => {
  let received!: () => void;
  const started = new Promise<void>(resolve => {
    received = resolve;
  });
  await withLocalServer(
    () => received(),
    async base => {
      const loader = await (await plugin()).auth.loader(() => ({ ...auth(), metadata: { baseURL: base } }));
      const controller = new AbortController();
      const pending = loader.fetch!(`${base}/v1/messages`, { signal: controller.signal });
      await started;
      controller.abort();
      let caught: Error | undefined;
      try {
        await pending;
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.name).toBe("AbortError");
    },
  );
});
