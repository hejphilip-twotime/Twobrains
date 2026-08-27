export const config = { runtime: 'edge' };

// Vercel stops an edge function that has not sent an initial response within
// 25 seconds. The model regularly needs longer than that, so this function
// starts writing bytes immediately and keeps trickling them out while it waits,
// then appends the real JSON at the end.
//
// The content type matters as much as the trickle: with application/json the
// response gets buffered on the way out and none of the keep-alive bytes
// actually leave the server, which is what made the first attempt at this fail.
// text/plain plus the no-transform and no-buffering headers keeps the pipe open.
// The client reads the body as text and parses it, so leading whitespace is fine.

const KEEPALIVE_MS = 3000;

const STREAM_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*'
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: { message: 'API not configured' } }), {
      status: 200,
      headers: STREAM_HEADERS
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid request' } }), {
      status: 200,
      headers: STREAM_HEADERS
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let finished = false;

      // First byte goes out before anything else happens.
      controller.enqueue(encoder.encode(' '));

      const keepAlive = setInterval(() => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(' '));
        } catch {
          // Client went away.
        }
      }, KEEPALIVE_MS);

      const finish = (text) => {
        if (finished) return;
        finished = true;
        clearInterval(keepAlive);
        try {
          controller.enqueue(encoder.encode(text));
          controller.close();
        } catch {
          // Already closed.
        }
      };

      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      })
        .then((upstream) => upstream.text())
        .then((text) => finish(text))
        .catch((err) => finish(JSON.stringify({ error: { message: err.message } })));
    }
  });

  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
}
