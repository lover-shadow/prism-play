import type {
  CatalogChangesResponse,
  CatalogResponse,
  ChannelsResponse,
  DevicePingResponse,
  DeviceTier,
  ErrorCode,
  ErrorResponse,
  MonetizationConfig,
  PlaybackInfo,
  RelatedResponse,
  RedeemRequest,
  RedeemSuccessResponse,
  SearchResponse,
  SourcesResponse,
  SuggestionsResponse,
  TitleDetail,
  VersionResponse
} from '../../../edge/src/types/api';

/**
 * Typed client for the edge contract. DTOs are imported from `edge/src/types/api.ts` on purpose: one
 * definition of the wire shape for both halves, so a contract edit cannot land on one side only.
 */

export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE';
  readonly status: number;

  constructor(code: ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE', status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** 404 is the contract's anti-probing answer for "missing", "withdrawn" and "private, not admitted". */
  get treatedAsMissing(): boolean {
    return this.code === 'NOT_FOUND' || this.status === 404;
  }
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export type QueryValue = string | number | undefined;

function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/** The private opt-in credential. RAM only: no setter ever writes, and cold start means absent. */
export interface SessionHolder {
  read(): string | null;
  write(token: string | null): void;
}

export class PrismApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private sessionHolder: SessionHolder | null = null;
  private authorization: string | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Injection instead of import so the storage layer owns the "never persisted" guarantee. */
  bindSessionHolder(holder: SessionHolder): void {
    this.sessionHolder = holder;
  }

  setAuthorization(token: string | null): void {
    this.authorization = token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extra };
    if (this.authorization !== null) headers.Authorization = `Bearer ${this.authorization}`;
    const session = this.sessionHolder?.read() ?? null;
    if (session !== null) headers['X-Private-Session'] = session;
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch {
      throw new ApiError('NETWORK_ERROR', 0, '网络不可用，请检查连接后重试');
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(errorCodeOf(text), response.status, errorMessageOf(text));
    }
    if (response.status === 204 || text === '') throw new ApiError('UNEXPECTED_RESPONSE', response.status, '服务端返回空响应');
    return JSON.parse(text) as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { headers: this.headers() });
  }

  channels(): Promise<ChannelsResponse> {
    return this.get('/api/channels');
  }

  sources(channel?: string): Promise<SourcesResponse> {
    return this.get(`/api/sources${queryString({ channel })}`);
  }

  catalog(input: { channel: string; category?: string; page?: number; pageSize?: number; revision?: number }): Promise<CatalogResponse> {
    return this.get(`/api/catalog${queryString(input)}`);
  }

  changes(after: number, limit?: number): Promise<CatalogChangesResponse> {
    return this.get(`/api/catalog/changes${queryString({ after, limit })}`);
  }

  search(input: { q: string; channel?: string; tag?: string; page?: number; pageSize?: number }): Promise<SearchResponse> {
    return this.get(`/api/search${queryString(input)}`);
  }

  suggestions(q: string): Promise<SuggestionsResponse> {
    return this.get(`/api/search/suggestions${queryString({ q })}`);
  }

  title(titleId: string): Promise<TitleDetail> {
    return this.get(`/api/titles/${encodeURIComponent(titleId)}`);
  }

  related(titleId: string): Promise<RelatedResponse> {
    return this.get(`/api/titles/${encodeURIComponent(titleId)}/related`);
  }

  playback(episodeId: number): Promise<PlaybackInfo> {
    return this.get(`/api/episodes/${episodeId}/playback`);
  }

  monetization(): Promise<MonetizationConfig> {
    return this.get('/api/config/monetization');
  }

  version(): Promise<VersionResponse> {
    return this.get('/api/version');
  }

  ping(): Promise<DevicePingResponse> {
    return this.get('/api/device/ping');
  }

  redeem(body: RedeemRequest): Promise<RedeemSuccessResponse> {
    return this.request('/api/redeem', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
  }

  /**
   * AC-02: the returned credential is handed to the injected holder and never stored by this client.
   * `acknowledged` is what the server records as the explicit opt-in request.
   */
  async openPrivateSession(): Promise<number> {
    const response = await this.request<{ sessionToken: string; expiresInSeconds: number }>('/api/private-sessions', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ acknowledged: true })
    });
    this.sessionHolder?.write(response.sessionToken);
    return response.expiresInSeconds;
  }

  async closePrivateSession(): Promise<void> {
    await this.request('/api/private-sessions', { method: 'DELETE', headers: this.headers() });
    this.sessionHolder?.write(null);
  }

  /** Cold start / full exit path: drop the in-memory credential without a server round trip. */
  forgetPrivateSessionLocally(): void {
    this.sessionHolder?.write(null);
  }
}

const KNOWN_CODES: readonly string[] = [
  'COUPON_NOT_FOUND',
  'COUPON_REVOKED',
  'COUPON_DEVICE_LIMIT_EXCEEDED',
  'COUPON_INVALID_FORMAT',
  'DEVICE_ID_INVALID',
  'RATE_LIMITED',
  'PRIVATE_SESSION_REQUIRED',
  'TIER_INSUFFICIENT',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'PLATFORM_UNSUPPORTED',
  'CREDENTIAL_EXPIRED',
  'VALIDATION_ERROR',
  'PROXY_SIGNATURE_INVALID',
  'CATALOG_REVISION_CONFLICT',
  'CATALOG_CURSOR_EXPIRED'
];

function parseError(text: string): ErrorResponse | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
    return { success: false, code: candidate.code as ErrorCode, message: candidate.message };
  } catch {
    return null;
  }
}

function errorCodeOf(text: string): ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE' {
  const parsed = parseError(text);
  if (parsed === null) return 'UNEXPECTED_RESPONSE';
  return KNOWN_CODES.includes(parsed.code) ? parsed.code : 'UNEXPECTED_RESPONSE';
}

function errorMessageOf(text: string): string {
  return parseError(text)?.message ?? '服务端返回了无法识别的错误';
}

export type { DeviceTier };
