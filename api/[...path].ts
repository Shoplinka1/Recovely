const BACKEND = 'https://recovely-b77j28.v2.appdeploy.ai';

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const upstreamUrl = `${BACKEND}${url.pathname}${url.search}`;

  try {
    const headers = new Headers(req.headers);

    headers.delete('host');
    headers.delete('content-length');

    const method = req.method || 'GET';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(upstreamUrl, {
        method,
        headers,
        body:
          method === 'GET' || method === 'HEAD'
            ? undefined
            : await req.arrayBuffer(),
        redirect: 'manual',
        signal: controller.signal,
      });

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('transfer-encoding');
      responseHeaders.delete('content-length');

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'The Recovely backend did not respond within 15 seconds.'
        : 'Could not reach the Recovely backend from the Vercel proxy.';

    console.error('Recovely AppDeploy proxy error:', error);

    return new Response(
      JSON.stringify({
        ok: false,
        proxy: true,
        upstream: BACKEND,
        message,
      }),
      {
        status: 504,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
}
