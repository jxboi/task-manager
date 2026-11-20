import { createHmac, timingSafeEqual } from 'node:crypto';
import { betterAuth } from 'better-auth';
import pg from 'pg';

let services;

export function getServices() {
  if (services) return services;

  const deployed = ['production', 'preview'].includes(process.env.VERCEL_ENV);
  const baseURL = process.env.BETTER_AUTH_URL?.trim() ||
    (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : '');
  const url = new URL(baseURL);
  const localHttp = !deployed && url.protocol === 'http:' && url.hostname === 'localhost';
  if ((!localHttp && url.protocol !== 'https:') || url.href !== `${url.origin}/`) {
    throw new Error('Configure BETTER_AUTH_URL as an HTTPS origin or a localhost HTTP origin for development.');
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('Configure BETTER_AUTH_SECRET with at least 32 characters.');
  const connectionString = process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
  if (!connectionString) throw new Error('Configure DATABASE_URL or POSTGRES_URL.');
  const pool = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
  });
  pool.on('error', (error) => console.error('Idle PostgreSQL connection error', error.code));

  const auth = betterAuth({
    baseURL: url.origin,
    basePath: '/api/auth',
    trustedOrigins: [url.origin],
    secret,
    database: pool,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      autoSignIn: true,
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      useSecureCookies: !localHttp,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      // Vercel supplies the trusted client IP. Local requests share one rate-limit bucket.
      ipAddress: { ipAddressHeaders: deployed ? ['x-vercel-forwarded-for'] : [] },
    },
  });

  const csrfKey = createHmac('sha256', secret).update('task-manager/csrf/v1').digest();
  services = { auth, pool, origin: url.origin, csrfKey };
  return services;
}

export function getSession(auth, request) {
  return auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
}

export function csrfToken(csrfKey, sessionId) {
  return createHmac('sha256', csrfKey).update(sessionId).digest('base64url');
}

export function validCsrf(request, csrfKey, sessionId) {
  const supplied = request.headers.get('x-csrf-token') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken(csrfKey, sessionId)));
}
