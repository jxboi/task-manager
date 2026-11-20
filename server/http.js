import { assertSchemaCurrent } from './schema-guard.js';
import { getServices, getSession, validCsrf } from './auth.js';

export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function invalid(message) {
  return new RequestError(400, 'INVALID_INPUT', message);
}

export function json(value, status = 200) {
  return Response.json(value, { status });
}

export function checkMutation(request, origins) {
  const origin = request.headers.get('origin');
  if (!origins.includes(origin) || origin !== new URL(request.url).origin) {
    throw new RequestError(403, 'INVALID_ORIGIN', 'The request must come from this site.');
  }
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw invalid('Send application/json.');
  return origin;
}

export async function readObject(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send a JSON object.');
  return body;
}

export async function requireSession(request, services, mutation) {
  const active = await getSession(services.auth, request);
  if (!active) throw new RequestError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  if (mutation && !validCsrf(request, services.csrfKey, active.session.id)) {
    throw new RequestError(403, 'INVALID_CSRF', 'Your session changed. Refresh and try again.');
  }
  return active;
}

export function endpoint(methods, handle, { authErrors = false } = {}) {
  function errorResponse(status, code, message) {
    const error = { code, message };
    return json(authErrors ? error : { error }, status);
  }

  return {
    async fetch(request) {
      let response;
      if (!methods.includes(request.method)) {
        response = errorResponse(405, 'METHOD_NOT_ALLOWED', 'This method is unavailable.');
        response.headers.set('Allow', methods.join(', '));
      } else {
        try {
          const services = getServices();
          await assertSchemaCurrent(services.pool);
          response = await handle(request, services);
        } catch (error) {
          if (error instanceof RequestError) {
            response = errorResponse(error.status, error.code, error.message);
          } else {
            console.error('API request failed', error.name, error.code);
            response = errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Try again.');
          }
        }
      }

      // Preserve all of Better Auth’s Set-Cookie values.
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}
