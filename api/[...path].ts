const BACKEND = 'https://recovely-b77j28.v2.appdeploy.ai';

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const upstreamUrl = `${BACKEND}${url.pathname}${url.search}`;

  try {
    const headers = new Headers(req.headers);

    headers.delete('host');
    headers.delete('content-length');

    const method = req.method || 'GET';

    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : await req.arrayBuffer();

    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
    });

    const responseHeaders = new Headers(upstream.headers);

    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('content-length');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Recovely AppDeploy proxy error:', error);

    return new Response(
      JSON.stringify({
        ok: false,
        message: 'Could not reach the Recovely backend.',
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }
}
