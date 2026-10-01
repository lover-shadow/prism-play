const JSON_HEADERS: HeadersInit = { 'Content-Type': 'application/json; charset=utf-8' };

export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

/** AC-02 / API-SPEC §六: anything touching private data must not be storable by any cache. */
export function noStoreJson(data: unknown, status = 200): Response {
  return jsonResponse(data, status, { 'Cache-Control': 'no-store' });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}
