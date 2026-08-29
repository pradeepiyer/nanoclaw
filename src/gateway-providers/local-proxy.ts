/**
 * Minimal local credential proxy for the 'local' gateway provider.
 *
 * Listens on a random port on the host, forwards requests to
 * api.anthropic.com, and injects the real auth token — so containers
 * only need ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN=placeholder,
 * which are not credential-shaped values and pass validateSpec.
 */
import http from 'http';
import https from 'https';

export interface LocalProxy {
  port: number;
  stop(): void;
}

export function startLocalProxy(realToken: string): Promise<LocalProxy> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const target = new URL(req.url ?? '/', 'https://api.anthropic.com');
      // Forward all headers but replace auth and fix the host.
      const fwdHeaders: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        // Drop connection-management headers that don't survive proxying.
        if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(k)) continue;
        fwdHeaders[k] = v as string | string[];
      }
      fwdHeaders['host'] = 'api.anthropic.com';
      fwdHeaders['authorization'] = `Bearer ${realToken}`;
      delete fwdHeaders['x-api-key']; // OAuth tokens use Authorization, not x-api-key

      const options: https.RequestOptions = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: target.pathname + target.search,
        method: req.method,
        headers: fwdHeaders,
      };

      const proxy = https.request(options, (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      });

      proxy.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
      });

      req.pipe(proxy);
    });

    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get proxy port'));
        return;
      }
      resolve({
        port: addr.port,
        stop: () => server.close(),
      });
    });

    server.on('error', reject);
  });
}
