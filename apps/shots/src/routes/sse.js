// src/routes/sse.js
import express from 'express';

export function sseRoutes(engine) {
  const r = express.Router();

  // one place to open an SSE stream
  function openSSE(req, res) {
    // 1) headers once
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',  // avoid proxies & compression
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'                   // nginx: disable buffering
    });

    // 2) send a quick comment so the client considers the stream "open"
    res.write(':\n\n');

    // 3) initial retry hint + first payload
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(engine.viewModel())}\n\n`);

    // 4) keepalive (some proxies will kill idle connections)
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(':\n\n');
    }, 15000);

    // 5) clean up on disconnect
    const onClose = () => {
      clearInterval(heartbeat);
      engine.removeListener(res);
    };
    req.on('close', onClose);
    req.on('end', onClose);

    // 6) register this client to receive broadcasts
    engine.addListener(res);
  }

  r.get('/viewer', (req, res) => {
    if (!engine.running) engine.start();
    openSSE(req, res);
  });

  r.get('/admin', (req, res) => {
    if (!engine.running) engine.start();
    openSSE(req, res);
  });

  return r;
}