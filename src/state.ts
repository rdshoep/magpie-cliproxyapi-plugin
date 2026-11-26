import { createHash } from "node:crypto";
import type {
  CacheEntry,
  CredentialListCache,
  PluginRuntimeState,
  UpstreamCredentialState,
} from "./types.ts";

/**
 * Derive an opaque cache & circuit-breaker scope key from management endpoint + key hash.
 */
export function managementScope(base: string, managementKey: string): string {
  return `${base}|${createHash("sha256").update(managementKey).digest("hex").slice(0, 12)}`;
}

function keyMatchesScope(compositeKey: string, scope: string): boolean {
  try {
    const parsed = JSON.parse(compositeKey) as unknown;
    return Array.isArray(parsed) && parsed[0] === scope;
  } catch {
    return false;
  }
}

/**
 * Create an isolated in-memory runtime state container for caches, single-flight locks, and circuit breakers.
 */
export function createRuntimeState(): PluginRuntimeState {
  const blocked = new Map<string, string>();
  const cache = new Map<string, CacheEntry>();
  const lists = new Map<string, CredentialListCache>();
  const upstream = new Map<string, UpstreamCredentialState>();
  const activeReads = new Map<string, Set<Promise<void>>>();

  return {
    blocked,
    cache,
    lists,
    upstream,
    activeReads,
    resetAll() {
      blocked.clear();
      cache.clear();
      lists.clear();
      upstream.clear();
    },
    resetScope(scope: string) {
      blocked.delete(scope);
      lists.delete(scope);
      for (const key of cache.keys()) {
        if (keyMatchesScope(key, scope)) cache.delete(key);
      }
      for (const key of upstream.keys()) {
        if (keyMatchesScope(key, scope)) upstream.delete(key);
      }
    },
  };
}
