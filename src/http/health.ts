import { createServer, type Server } from 'node:http';

/**
 * The only public listener: `GET /health` answers `{"status":"ok"}` so the host sees a live
 * port. It reports nothing else and touches neither the database nor Redis.
 */
export function startHealthServer(port: number, host = '0.0.0.0'): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** Stops accepting connections and drops idle keep-alive ones. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
