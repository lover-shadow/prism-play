import { adminJson } from './admin-auth';

export async function readAdminBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const reader = request.body?.getReader();
  if (!reader) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 8192) { await reader.cancel(); return adminJson({ code: 'VALIDATION_ERROR' }, 400); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
    return value as Record<string, unknown>;
  } catch {
    return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  }
}
