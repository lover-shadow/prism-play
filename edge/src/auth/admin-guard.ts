import type { Clock } from '../core/clock';
import { readAdminSession, sameOrigin, type AdminEnv } from './admin-session';
import { adminJson } from '../routes/admin-auth';

export async function guardAdmin(request: Request, env: AdminEnv, clock: Clock): Promise<Response | null> {
  const origin = request.headers.get('Origin');
  if ((origin !== null && !sameOrigin(request)) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return adminJson({ code: 'FORBIDDEN' }, 403);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request)) return adminJson({ code: 'FORBIDDEN' }, 403);
  if (!await readAdminSession(request, env, clock)) return adminJson({ code: 'UNAUTHENTICATED' }, 401);
  return null;
}
