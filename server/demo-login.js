import { APIError, createAuthEndpoint, createAuthMiddleware, formCsrfMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';

const demoEmail = 'demo@example.test';
export const demoUserId = 'preview-demo';

export function isDemoLoginEnabled(env = process.env) {
  return env.VERCEL_ENV === 'preview';
}

async function findOrCreateDemoUser(pool) {
  const { rows: [created] } = await pool.query(
    `INSERT INTO "user" (id, email, name, "createdAt", "updatedAt")
     VALUES ($1, $2, 'Demo', now(), now())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [demoUserId, demoEmail],
  );
  if (created) return created;

  // Match both identifiers so a pre-existing account with the email cannot become the demo.
  const { rows: [user] } = await pool.query(
    'SELECT * FROM "user" WHERE id = $1 AND email = $2', [demoUserId, demoEmail],
  );
  return user;
}

export function demoLoginPlugin(pool) {
  return {
    id: 'preview-demo-login',
    hooks: {
      before: [{
        matcher: ({ path }) => path === '/sign-up/email' || path === '/sign-in/email',
        handler: createAuthMiddleware(async (ctx) => {
          const email = ctx.body?.email;
          if (typeof email !== 'string' || email.toLowerCase() !== demoEmail) return;
          if (ctx.path === '/sign-up/email') {
            throw new APIError('UNPROCESSABLE_ENTITY', {
              code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
              message: 'Use another email address.',
            });
          }
          throw new APIError('UNAUTHORIZED', {
            code: 'INVALID_EMAIL_OR_PASSWORD',
            message: 'Invalid email or password.',
          });
        }),
      }],
    },
    endpoints: {
      signInDemo: createAuthEndpoint('/demo', {
        method: 'POST',
        use: [formCsrfMiddleware],
      }, async (ctx) => {
        if (!isDemoLoginEnabled()) throw new APIError('NOT_FOUND');
        const user = await findOrCreateDemoUser(pool);
        if (!user) throw new APIError('CONFLICT', { message: 'Demo account is unavailable.' });

        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw new APIError('INTERNAL_SERVER_ERROR');
        await setSessionCookie(ctx, { session, user }, false);
        return ctx.json({ ok: true });
      }),
    },
  };
}
