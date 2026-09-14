const BACKEND = 'https://api-v2.appdeploy.ai/app/recovely-b77j28';

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);

    const upstreamUrl =
      `${BACKEND}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);

    headers.delete('host');
    headers.delete('content-length');

    const method = req.method || 'GET';

    const response = await fetch(upstreamUrl, {
      method,
      headers,
      body:
        method === 'GET' || method === 'HEAD'
          ? undefined
          : await req.arrayBuffer(),
      redirect: 'manual',
    });

    const responseHeaders = new Headers(response.headers);

    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('content-length');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Recovely AppDeploy proxy error:', error);

    return new Response(
      JSON.stringify({
        message: 'Could not reach the Recovely backend.',
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
}
