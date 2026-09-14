const BACKEND = 'https://recovely-b77j28.v2.appdeploy.ai';

export default async function handler(req: any, res: any) {
  try {
    const originalUrl = req.url || '/api/_healthcheck';
    const upstreamUrl = `${BACKEND}${originalUrl}`;

    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(req.headers || {})) {
      if (
        value == null ||
        key.toLowerCase() === 'host' ||
        key.toLowerCase() === 'content-length'
      ) {
        continue;
      }

      headers[key] = Array.isArray(value)
        ? value.join(', ')
        : String(value);
    }

    const method = req.method || 'GET';

    let body: string | undefined;

    if (method !== 'GET' && method !== 'HEAD') {
      if (typeof req.body === 'string') {
        body = req.body;
      } else if (req.body !== undefined) {
        body = JSON.stringify(req.body);
      }
    }

    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
    });

    res.statusCode = upstream.status;

    upstream.headers.forEach((value, key) => {
      if (
        key.toLowerCase() !== 'transfer-encoding' &&
        key.toLowerCase() !== 'content-length'
      ) {
        res.setHeader(key, value);
      }
    });

    const text = await upstream.text();

    res.end(text);
  } catch (error) {
    console.error('Recovely AppDeploy proxy error:', error);

    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');

    res.end(
      JSON.stringify({
        message: 'Could not reach the Recovely backend.',
      })
    );
  }
}
