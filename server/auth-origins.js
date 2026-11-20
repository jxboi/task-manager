function previewOrigin(host) {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host ?? '')) {
    throw new Error('Configure Vercel Preview hostnames without a scheme or path.');
  }
  return new URL(`https://${host}`).origin;
}

export function resolveAuthOrigins(env) {
  if (env.VERCEL_ENV === 'preview') {
    const origins = [previewOrigin(env.VERCEL_URL)];
    if (env.VERCEL_BRANCH_URL) origins.push(previewOrigin(env.VERCEL_BRANCH_URL));
    return [...new Set(origins)];
  }

  const url = new URL(env.BETTER_AUTH_URL?.trim() ?? '');
  const localHttp = env.VERCEL_ENV !== 'production' &&
    url.protocol === 'http:' && url.hostname === 'localhost';
  if ((!localHttp && url.protocol !== 'https:') || url.href !== `${url.origin}/`) {
    throw new Error('Configure BETTER_AUTH_URL as an HTTPS origin or a localhost HTTP origin for development.');
  }
  return [url.origin];
}
