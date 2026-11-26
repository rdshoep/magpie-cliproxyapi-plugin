import { expect, test } from "bun:test";
import { _internal } from "../index.ts";
import type { CPACredential, FetchLike } from "../src/types.ts";

const managementKey = "test-mgmt-key-LEAKCHECK";
const baseURL = "https://cpa.example.invalid";
const usageURL = "https://api.anthropic.com/api/oauth/usage";
const start = Date.parse("2026-11-03T20:00:00Z");
const row: CPACredential = { provider: "claude", disabled: false, auth_index: "index-one", name: "one", label: "First" };
const windows = (five = 25, week = 50) => ({
  five_hour: { utilization: five, resets_at: "2026-11-04T00:00:00Z" },
  seven_day: { utilization: week, resets_at: "2026-11-10T00:00:00Z" },
});
const grant = (extra: Record<string, unknown> = {}) => ({
  id: "fable-launch",
  resets_total: 1,
  resets_left: 1,
  type: "weekly",
  starts_at: "2026-11-01T00:00:00Z",
  ends_at: "2026-11-30T00:00:00Z",
  ...extra,
});
const cedar = (grants = [grant()]) => ({ eligible: true, grants });
const envelope = (body: unknown, status_code = 200, header?: Record<string, unknown>) => ({
  status_code,
  body: JSON.stringify(body),
  ...(header ? { header } : {}),
});
const signals = (at: number, extra: Record<string, unknown> = {}) => ({
  observed_at: new Date(at).toISOString(),
  signals: {
    "Anthropic-Ratelimit-Unified-Status": "allowed",
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
    "Anthropic-Ratelimit-Unified-5h-Reset": String(Date.parse("2026-11-04T01:00:00Z") / 1000),
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.17",
    "Anthropic-Ratelimit-Unified-7d-Reset": "1794700800.4",
    ...extra,
  },
});
const signalWindows = [
  { name: "5 hours", used: 42, span: 18000, resetsAt: "2026-11-04T01:00:00.000Z" },
  { name: "7 days", used: 17, span: 604800, resetsAt: "2026-11-15T00:00:00.400Z" },
];

function harness({
  usage = envelope({ ...windows(), cedar_ember: cedar() }),
  files,
}: { usage?: unknown; files?: CPACredential[] | (() => CPACredential[]) } = {}) {
  let clock = start;
  const calls: Array<{ url: string; body: { url?: string } | undefined }> = [];
  const h = {
    usage,
    plain: envelope(windows()),
    files: files ?? [row],
    calls,
    gate: undefined as Promise<void> | undefined,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  const request: FetchLike = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { url?: string }) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/credentials")) {
      return Response.json({ files: typeof h.files === "function" ? h.files() : h.files });
    }
    if (h.gate) await h.gate;
    return Response.json(body?.url === usageURL ? h.plain : h.usage);
  };
  const read = _internal.createUsage({ now: () => clock, request });
  return Object.assign(h, {
    get: (credential?: string) =>
      read(() => ({
        type: "api",
        key: "test-biz-key",
        metadata: { baseURL, managementKey, ...(credential ? { credential } : {}) },
      })),
    inner: () => calls.filter(call => call.url.endsWith("/requests/api-call")).map(call => call.body!.url!),
  });
}

test("selections naming one credential share its upstream read, in flight and cached", async () => {
  const h = harness();
  let release!: () => void;
  h.gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const pending = [h.get(), h.get("one"), h.get("index-one")];
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  for (const result of await Promise.all(pending)) expect(result.windows?.[0].used).toBe(25);
  expect(h.inner()).toHaveLength(1);
  expect(h.calls.filter(call => call.url.endsWith("/credentials"))).toHaveLength(1);
});

test("shared readings are copied before the multi-credential label is added", async () => {
  const h = harness({ files: [row, { ...row, provider: "other", auth_index: "x", name: "x" }] });
  for (const credential of ["one", "index-one", "one"]) {
    expect((await h.get(credential)).windows?.map(w => w.name)).toEqual([
      "5 hours (Claude First)",
      "7 days (Claude First)",
    ]);
  }
  expect(h.inner()).toHaveLength(1);
});

test("recent CPA quota signals supply the windows without another Anthropic read", async () => {
  const h = harness();
  h.files = () => [{ ...row, quota: signals(h.now() - 60_000) }];
  const first = await h.get();
  expect(h.inner()).toHaveLength(1);
  expect(first.resets?.count).toBe(1);
  for (let elapsed = 300_000; elapsed < 1_800_000; elapsed += 300_000) {
    h.advance(300_000);
    const result = await h.get();
    expect(result.windows).toEqual(signalWindows);
    expect(result.resets?.count).toBe(1);
  }
  expect(h.inner()).toHaveLength(1);
  h.advance(300_000);
  h.usage = envelope({ ...windows(), cedar_ember: cedar([grant(), grant({ id: "second" })]) });
  expect((await h.get()).resets?.count).toBe(2);
  expect(h.inner()).toHaveLength(2);
});

test("signals newer than a cached read replace its windows; old, partial or odd signals are ignored", async () => {
  const h = harness();
  expect((await h.get()).windows?.[0].used).toBe(25);
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  h.advance(60_000);
  expect((await h.get()).windows?.[0].used).toBe(25);
  h.advance(240_000);
  expect((await h.get()).windows).toEqual(signalWindows);
  expect(h.inner()).toHaveLength(1);

  const bad = [
    (at: number) => signals(at - 300_001),
    (at: number) => signals(at + 60_001),
    () => ({ observed_at: "soon", signals: {} }),
    (at: number) => signals(at, { "Anthropic-Ratelimit-Unified-7d-Utilization": undefined }),
    (at: number) => signals(at, { "Anthropic-Ratelimit-Unified-5h-Utilization": "-0.1" }),
    (at: number) => signals(at, { "Anthropic-Ratelimit-Unified-5h-Utilization": "1e3" }),
    (at: number) => signals(at, { "Anthropic-Ratelimit-Unified-5h-Reset": String(at / 1000) }),
    (at: number) => signals(at, { "Anthropic-Ratelimit-Unified-5h-Reset": "9".repeat(20) }),
    (at: number) => ({ observed_at: new Date(at).toISOString(), signals: null }),
  ];
  for (const quota of bad) {
    const one = harness();
    one.files = () => [{ ...row, quota: quota(one.now()) }];
    expect((await one.get()).windows?.[0].used).toBe(25);
    one.advance(300_000);
    expect((await one.get()).windows?.[0].used).toBe(25);
    expect(one.inner()).toHaveLength(2);
  }
});

test("a credential whose opt-in query is refused reads the plain URL for a day, and signals then suffice", async () => {
  const h = harness({ usage: envelope({}, 403) });
  await h.get();
  expect(h.inner()).toEqual([`${usageURL}?cedar_ember=1`, usageURL]);
  h.advance(300_000);
  await h.get();
  expect(h.inner().slice(2)).toEqual([usageURL]);
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  for (let i = 0; i < 12; i++) {
    h.advance(300_000);
    expect((await h.get()).windows).toEqual(signalWindows);
  }
  expect(h.inner()).toHaveLength(3);
  h.files = [row];
  h.advance(86_400_000);
  await h.get();
  expect(h.inner().slice(3)).toEqual([`${usageURL}?cedar_ember=1`, usageURL]);
});

test("upstream 429 honours Retry-After and repeated failures double the pause up to an hour", async () => {
  const h = harness({ usage: envelope({}, 429, { "Retry-After": ["1800"] }) });
  const result = await h.get();
  expect(result.error).toMatch(/限流/);
  for (let i = 0; i < 5; i++) {
    h.advance(300_000);
    expect(typeof (await h.get()).error).toBe("string");
  }
  expect(h.inner()).toHaveLength(1);
  h.usage = envelope({}, 500);
  h.advance(300_000);
  await h.get();
  expect(h.inner()).toHaveLength(2);
  const gaps: number[] = [];
  let last = h.now();
  for (let i = 0; i < 60; i++) {
    h.advance(300_000);
    const before = h.inner().length;
    await h.get();
    if (h.inner().length > before) {
      gaps.push(h.now() - last);
      last = h.now();
    }
  }
  expect(gaps.slice(0, 5)).toEqual([600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  h.usage = envelope(windows(5));
  h.advance(3_600_000);
  expect((await h.get()).windows?.[0].used).toBe(5);
});

test("an HTTP-date Retry-After counts too; past or invalid values fall back to the backoff", async () => {
  for (const [header, expected] of [
    [{ "retry-after": [new Date(start + 2_700_000).toUTCString()] }, 2_700_000],
    [{ "Retry-After": ["0"] }, 300_000],
    [{ "Retry-After": ["later"] }, 300_000],
    [undefined, 300_000],
    [{ "Retry-After": ["99999999"] }, 3_600_000],
  ] as const) {
    const h = harness({ usage: envelope({}, 429, header) });
    await h.get();
    h.advance(expected - 1);
    await h.get();
    expect(h.inner()).toHaveLength(1);
    h.advance(300_000);
    await h.get();
    expect(h.inner()).toHaveLength(2);
  }
});

test("an upstream failure falls back to recent CPA signals instead of an error", async () => {
  const h = harness({ usage: envelope({}, 429, { "Retry-After": ["3600"] }) });
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  const result = await h.get();
  expect(result).toEqual({ signIn: "kept", windows: signalWindows });
  for (let i = 0; i < 11; i++) {
    h.advance(300_000);
    expect(await h.get()).toEqual(result);
  }
  expect(h.inner()).toHaveLength(1);
});

test("cached reset cards that have since expired are dropped at display time", async () => {
  const h = harness({
    usage: envelope({
      ...windows(),
      cedar_ember: cedar([grant({ ends_at: "2026-11-03T20:10:00Z" }), grant({ id: "later" })]),
    }),
  });
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  expect((await h.get()).resets?.count).toBe(2);
  h.advance(600_000);
  expect((await h.get()).resets).toEqual({
    count: 1,
    until: "2026-11-30T00:00:00.000Z",
    each: [{ until: "2026-11-30T00:00:00.000Z", window: "weekly" }],
  });
  expect(h.inner()).toHaveLength(1);
});
