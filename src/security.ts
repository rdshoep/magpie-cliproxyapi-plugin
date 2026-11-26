/**
 * Mask a credential or secret, retaining at most the first 4 and last 4 characters.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

/**
 * Redact known secrets and common API credential patterns from arbitrary text.
 */
export function redactText(text: string, secrets: readonly (string | undefined)[] = []): string {
  if (!text) return "";
  let output = text;

  const uniqueSecrets = [...new Set(secrets.map(s => (typeof s === "string" ? s.trim() : "")).filter(Boolean))]
    .sort((a, b) => b.length - a.length);

  for (const secret of uniqueSecrets) {
    output = output.split(secret).join(maskSecret(secret));
  }

  output = output.replace(
    /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{6,})/gi,
    (_match, prefix: string, token: string) =>
      token.includes("****") ? `${prefix}${token}` : `${prefix}${maskSecret(token)}`,
  );

  output = output.replace(
    /((?:x-api-key|authorization)\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{6,})/gi,
    (_match, prefix: string, token: string) =>
      token.includes("****") ? `${prefix}${token}` : `${prefix}${maskSecret(token)}`,
  );

  output = output.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, token =>
    token.includes("****") ? token : maskSecret(token),
  );

  return output;
}

/**
 * Create a sanitized Error that never exposes raw secrets or upstream error bodies.
 */
export function toSafeError(
  _error: unknown,
  fallbackMessage: string,
  secrets: readonly (string | undefined)[] = [],
): Error {
  return new Error(redactText(fallbackMessage, secrets));
}

/**
 * Read and parse a JSON Response body while enforcing a hard byte size cap.
 */
export async function readJSON(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("CPA 响应体超过大小限制");
    }
    return JSON.parse(text);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation errors after exceeding the safety limit.
        }
        throw new Error("CPA 响应体超过大小限制");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(text + decoder.decode());
}
