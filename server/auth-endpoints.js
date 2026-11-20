import { csrfToken, getSession } from './auth.js';
import { checkMutation, endpoint, json, readObject, RequestError, requireSession } from './http.js';

export function authMutation(path) {
  return endpoint(['POST'], async (request, services) => {
    if (new URL(request.url).pathname !== `/api/auth/${path}`) {
      throw new RequestError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
    }
    const origin = checkMutation(request, services.origins);
    if (path === 'sign-out') {
      await requireSession(request, services, true);
      await readObject(request.clone());
    }
    return services.authByOrigin.get(origin).handler(request);
  }, { authErrors: true });
}

export const sessionEndpoint = endpoint(['GET'], async (request, { auth, csrfKey }) => {
  const active = await getSession(auth, request);
  if (!active) return json({ user: null, csrfToken: null });
  const { user: { name, email }, session } = active;
  return json({ user: { name, email }, csrfToken: csrfToken(csrfKey, session.id) });
});
