import type { IncomingMessage, ServerResponse } from 'node:http';

const BACKEND = 'https://recovely-b77j28.v2.appdeploy.ai';

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const originalUrl = req.url || '/api';
    const target = new URL(originalUrl, 'http://vercel.local');
    const upstreamUrl = `${BACKEND}${target.pathname}${target.search}`;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null || key.toLowerCase() === 'host' || key.toLowerCase() === 'content-length') continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    const method = req.method || 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);

    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
    });

    res.statusCode = upstream.status;

    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding' || key.toLowerCase() === 'content-length') return;
      res.setHeader(key, value);
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.end(responseBody);
  } catch (error) {
    console.error('AppDeploy API proxy failure', error);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Could not reach the Recovely backend.' }));
  }
}
