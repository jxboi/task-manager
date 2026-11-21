import { createHmac, timingSafeEqual } from 'node:crypto';
import { betterAuth } from 'better-auth';
import pg from 'pg';
import { resolveAuthOrigins } from './auth-origins.js';
import { demoLoginPlugin, demoUserId, isDemoLoginEnabled } from './demo-login.js';

let services;

export function getServices() {
  if (services) return services;

  const deployed = ['production', 'preview'].includes(process.env.VERCEL_ENV);
  const origins = resolveAuthOrigins(process.env);

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

  // Use a static base URL for each allowed origin, independent of proxy headers.
  const authByOrigin = new Map(origins.map((origin) => [origin, betterAuth({
    baseURL: origin,
    basePath: '/api/auth',
    trustedOrigins: origins,
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
    plugins: [demoLoginPlugin(pool)],
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: { '/demo': { window: 10, max: 3 } },
    },
    advanced: {
      useSecureCookies: origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      // Vercel supplies the trusted client IP. Local requests share one rate-limit bucket.
      ipAddress: { ipAddressHeaders: deployed ? ['x-vercel-forwarded-for'] : [] },
    },
  })]));

  const csrfKey = createHmac('sha256', secret).update('task-manager/csrf/v1').digest();
  services = { auth: authByOrigin.get(origins[0]), authByOrigin, origins, pool, csrfKey };
  return services;
}

export async function getSession(auth, request) {
  const active = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (active?.user.id === demoUserId && !isDemoLoginEnabled()) return null;
  return active;
}

export function csrfToken(csrfKey, sessionId) {
  return createHmac('sha256', csrfKey).update(sessionId).digest('base64url');
}

export function validCsrf(request, csrfKey, sessionId) {
  const supplied = request.headers.get('x-csrf-token') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken(csrfKey, sessionId)));
}
