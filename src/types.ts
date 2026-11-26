export type UsageMode = "auto" | "passive-only";

export interface PluginMetadata {
  baseURL: string;
  email: string;
  managementKey?: string;
  managementURL?: string;
  credential?: string;
  modelRouting?: "enabled";
  modelFilter?: string;
  modelGroupPrefix?: "enabled";
  usageMode?: UsageMode;
}

export interface PluginAuth {
  type?: string;
  key?: string;
  metadata?: Partial<PluginMetadata> & Record<string, unknown>;
}

export interface AuthorizeInputs {
  baseURL?: string;
  businessKey?: string;
  managementKey?: string;
  managementURL?: string;
  credential?: string;
  modelRouting?: string;
  modelFilter?: string;
  modelGroupPrefix?: string;
  usageMode?: string;
  checkConnection?: string;
}

export type AuthorizeResult =
  | {
      type: "success";
      key: string;
      metadata: PluginMetadata;
    }
  | {
      type: "failed";
      error: string;
    };

export interface UsageWindow {
  name: string;
  used?: number;
  span?: number;
  resetsAt?: string;
  display?: string;
  aside?: boolean;
  models?: string[];
}

export interface ResetCard {
  until?: string;
  window?: "fiveHour" | "weekly";
}

export interface UsageResets {
  count: number;
  until?: string;
  byWindow?: boolean;
  each?: ResetCard[];
}

export interface UsageResult {
  windows?: UsageWindow[];
  resets?: UsageResets;
  plan?: string;
  error?: string;
  signIn?: "kept";
}

export interface CPACredential {
  provider: string;
  disabled: boolean;
  auth_index: string;
  name?: string;
  id?: string;
  label?: string;
  id_token?: {
    chatgpt_account_id?: string;
  };
  quota?: {
    observed_at?: string;
    signals?: Record<string, unknown> | null;
  };
}

export interface PassiveReading {
  windows: UsageWindow[];
  observedAt: number;
  plan?: string;
  inventory?: boolean;
}

export interface UsageReading {
  windows: UsageWindow[];
  resets?: UsageResets;
  plan?: string;
  inventory?: boolean;
  inventoryAt?: number;
}

export interface ApiCallTemplate {
  method: string;
  url: string;
  header?: Record<string, string>;
}

export type ApiCallFn = (template: ApiCallTemplate, optionalMs?: number) => Promise<unknown>;

export interface AdapterReadContext {
  now: number;
  memo: Record<string, unknown>;
  passive?: PassiveReading;
}

export interface UsageAdapter {
  read(apiCall: ApiCallFn, credential: CPACredential, context: AdapterReadContext): Promise<UsageReading>;
  passive?(credential: CPACredential, now: number): PassiveReading | undefined;
}

export interface ModelDefinitionEntry {
  id?: string;
  thinking?: {
    levels?: unknown;
    min?: number;
    max?: number;
  };
}

export interface ParsedModelFilter {
  include: RegExp[];
  exclude: RegExp[];
}

export interface ModelApiConfig {
  id?: string;
  url?: string;
  npm?: string;
  [key: string]: unknown;
}

export interface ModelCapabilities {
  reasoning?: boolean;
  toolcall?: boolean;
  [key: string]: unknown;
}

export interface ModelEntry {
  id: string;
  name: string;
  limit?: Record<string, unknown>;
  capabilities?: ModelCapabilities;
  variants?: Record<string, Record<string, unknown>>;
  api?: ModelApiConfig;
  [key: string]: unknown;
}

export interface ProviderConfig {
  name?: string;
  npm?: string;
  models?: Record<string, Partial<ModelEntry>>;
  [key: string]: unknown;
}

export interface MagpieConfig {
  provider?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

export interface PromptOption {
  label: string;
  value: string;
}

export interface AuthPrompt {
  type: "text" | "password" | "select";
  key: keyof AuthorizeInputs;
  message: string;
  validate?: (value: string | undefined) => string | undefined;
  options?: PromptOption[];
}

export interface AuthMethod {
  type: "api";
  label: string;
  prompts: AuthPrompt[];
  authorize: (inputs?: AuthorizeInputs) => Promise<AuthorizeResult>;
}

export interface LoaderResult {
  baseURL?: string;
  apiKey?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CacheEntry {
  value?: UsageResult;
  error?: string;
  updatedAt?: number;
  retryAt?: number;
  pending?: Promise<UsageResult>;
}

export interface CredentialListCache {
  at: number;
  files: Promise<CPACredential[]>;
  models?: Promise<Set<string>[]>;
}

export interface UpstreamCredentialState {
  memo: Record<string, unknown>;
  failures: number;
  retryAt: number;
  reading?: UsageReading;
  readAt?: number;
  error?: Error;
  pending?: Promise<UsageReading>;
}

export interface PluginRuntimeState {
  blocked: Map<string, string>;
  cache: Map<string, CacheEntry>;
  lists: Map<string, CredentialListCache>;
  upstream: Map<string, UpstreamCredentialState>;
  activeReads: Map<string, Set<Promise<void>>>;
  resetAll(): void;
  resetScope(scope: string): void;
}

export interface PluginHooks {
  config(cfg: MagpieConfig): Promise<void>;
  auth: {
    provider: "cpa";
    usage: (getAuth: () => PluginAuth | undefined | Promise<PluginAuth | undefined>) => Promise<UsageResult>;
    methods: AuthMethod[];
    loader: (getAuth: () => PluginAuth | undefined | Promise<PluginAuth | undefined>) => Promise<LoaderResult>;
  };
  provider: {
    id: "cpa";
    models(provider?: ProviderConfig, ctx?: { auth?: PluginAuth }): Promise<Record<string, ModelEntry>>;
  };
}
