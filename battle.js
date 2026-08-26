export const config = { runtime: 'edge' };

// How often to send a keep-alive byte while waiting for the model.
const KEEPALIVE_MS = 4000;

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API not configured' }), {
      status: 500,
      headers: JSON_HEADERS
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: JSON_HEADERS
    });
  }

  // We answer with 200 immediately and start writing bytes, so that Vercel does
  // not time the function out while the model is still generating. The body is
  // padded with spaces until the real JSON arrives. JSON.parse ignores leading
  // whitespace, so the client needs no changes.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let done = false;

      const keepAlive = setInterval(() => {
        if (!done) {
          try {
            controller.enqueue(encoder.encode(' '));
          } catch {
            // Stream already closed by the client.
          }
        }
      }, KEEPALIVE_MS);

      // First byte goes out right away.
      controller.enqueue(encoder.encode(' '));

      try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(body)
        });

        const text = await upstream.text();
        done = true;
        clearInterval(keepAlive);
        controller.enqueue(encoder.encode(text));
        controller.close();
      } catch (err) {
        done = true;
        clearInterval(keepAlive);
        controller.enqueue(
          encoder.encode(JSON.stringify({ error: { message: err.message } }))
        );
        controller.close();
      }
    }
  });

  return new Response(stream, { status: 200, headers: JSON_HEADERS });
}
