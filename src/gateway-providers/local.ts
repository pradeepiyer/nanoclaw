/**
 * Local gateway provider — no remote service required.
 *
 * Starts a minimal HTTP proxy on the host that injects CLAUDE_CODE_OAUTH_TOKEN
 * (or ANTHROPIC_API_KEY) into requests forwarded to api.anthropic.com.
 * Containers receive only the proxy URL + a placeholder token, which are
 * not credential-shaped and pass validateSpec.
 *
 * Enable with NANOCLAW_GATEWAY_PROVIDER=local in .env.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerGatewayProvider } from './gateway-provider-registry.js';
import { startLocalProxy } from './local-proxy.js';

let proxyPort: number | null = null;

registerGatewayProvider('local', () => ({
  kind: 'local',
  async contribute() {
    const dotenv = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    const realToken = dotenv.CLAUDE_CODE_OAUTH_TOKEN || dotenv.ANTHROPIC_API_KEY;

    if (!realToken) {
      throw new Error(
        'Local gateway requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env',
      );
    }

    if (!proxyPort) {
      const proxy = await startLocalProxy(realToken);
      proxyPort = proxy.port;
      log.info('Local credential proxy started', { port: proxyPort });
    }

    return {
      env: {
        ANTHROPIC_BASE_URL: `http://host.docker.internal:${proxyPort}`,
        ANTHROPIC_AUTH_TOKEN: 'placeholder',
      },
    };
  },
}));
