declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): this;
    digest(encoding: "hex" | "base64"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:http" {
  import type { Socket } from "node:net";

  export interface IncomingHttpHeaders {
    [key: string]: string | string[] | undefined;
  }

  export interface IncomingMessage extends AsyncIterable<Uint8Array | string> {
    url?: string;
    method?: string;
    headers: IncomingHttpHeaders;
    socket: { destroy(): void };
  }

  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): this;
    write(chunk: string | Uint8Array): boolean;
    end(data?: string | Uint8Array): this;
    on(event: "close", listener: () => void): this;
  }

  export interface AddressInfo {
    port: number;
    address: string;
    family: string;
  }

  export interface Server {
    listen(port?: number, hostname?: string, listeningListener?: () => void): this;
    address(): AddressInfo | string | null;
    close(callback?: (err?: Error) => void): this;
    closeAllConnections(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }

  export function createServer(
    requestListener: (req: IncomingMessage, res: ServerResponse) => unknown,
  ): Server;
}

declare module "node:events" {
  export function once(emitter: unknown, eventName: string): Promise<unknown[]>;
}

declare module "bun:test" {
  export interface Expect {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
    toContain(item: unknown): void;
    toMatch(pattern: string | RegExp): void;
    toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): void;
    toHaveLength(length: number): void;
    toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown): void;
    rejects: {
      toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): Promise<void>;
    };
    not: Expect;
  }

  export function expect(actual: unknown): Expect;
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;

  export interface Mock<T extends (...args: never[]) => unknown> {
    mock: {
      calls: Parameters<T>[];
    };
    mockImplementation(impl: T): this;
    mockReturnValue(value: ReturnType<T>): this;
    mockRestore(): void;
    mockClear(): void;
  }

  export function spyOn<T extends object, K extends keyof T>(
    obj: T,
    method: K,
  ): T[K] extends (...args: never[]) => unknown ? Mock<T[K]> : never;
}

interface ImportMeta {
  readonly main?: boolean;
}

declare function setImmediate(callback: () => void): unknown;

declare const process: {
  readonly argv: string[];
  exitCode?: number;
  readonly stdout: { write(chunk: string): boolean };
  readonly stderr: { write(chunk: string): boolean };
};
