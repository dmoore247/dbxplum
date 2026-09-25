#!/usr/bin/env node
/**
 * FHIR Compliance Proxy
 *
 * Reverse proxy that injects Databricks OAuth bearer token on every request.
 * Allows Inferno (which doesn't support custom auth headers) to test a
 * Databricks-OAuth-gated FHIR server.
 *
 * Also supports injecting a second auth layer (Medplum client credentials)
 * for endpoints that require it.
 */

const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const { execSync } = require('child_process');

// Configuration
const PROXY_PORT = process.env.PROXY_PORT || 3333;
// Bind host. Defaults to 0.0.0.0 so a containerized Inferno can reach the proxy
// via host.docker.internal; override to 127.0.0.1 to restrict to loopback.
const PROXY_HOST = process.env.PROXY_HOST || '0.0.0.0';
const TARGET_URL = process.env.TARGET_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';
const FHIR_BASE_PATH = '/fhir/R4';

// Token cache
let tokenCache = {
  databricks: null,
  databricksExpiry: null,
  medplum: null,
  medplumExpiry: null,
};

/**
 * Refresh Databricks token via CLI.
 * Returns the access_token string.
 * Supports both text and JSON output formats.
 */
function getDatabricksToken() {
  const now = Date.now();

  // Return cached token if valid for another 5 minutes
  if (tokenCache.databricks && tokenCache.databricksExpiry && now < (tokenCache.databricksExpiry - 300000)) {
    console.log(`[proxy] Using cached Databricks token (expires in ${Math.round((tokenCache.databricksExpiry - now) / 1000)}s)`);
    return tokenCache.databricks;
  }

  try {
    console.log('[proxy] Refreshing Databricks token...');
    let tokenData;

    // Try JSON format first, then fall back to text format
    try {
      const output = execSync('databricks auth token -p FHIR -o json', { encoding: 'utf-8' });
      tokenData = JSON.parse(output);
    } catch (e) {
      // Fall back to text format (just the token itself)
      const output = execSync('databricks auth token -p FHIR', { encoding: 'utf-8' }).trim();
      tokenData = {
        access_token: output,
        expires_in: 3600, // Default to 1 hour
      };
    }

    tokenCache.databricks = tokenData.access_token;

    // Parse expiry
    if (tokenData.expiry) {
      tokenCache.databricksExpiry = new Date(tokenData.expiry).getTime();
    } else {
      tokenCache.databricksExpiry = now + ((tokenData.expires_in || 3600) * 1000);
    }

    console.log(`[proxy] Got fresh Databricks token (expires in ${tokenData.expires_in || 3600}s)`);
    return tokenCache.databricks;
  } catch (error) {
    console.error('[proxy] Failed to get Databricks token:', error.message);
    // If refresh fails but we have a cached token, use it anyway
    if (tokenCache.databricks) {
      console.warn('[proxy] Using potentially-expired cached token as fallback');
      return tokenCache.databricks;
    }
    throw error;
  }
}

/**
 * Get a Medplum access token via OAuth2 client_credentials.
 *
 * Requires MEDPLUM_CLIENT_ID + MEDPLUM_CLIENT_SECRET (a Medplum ClientApplication
 * with an AccessPolicy). Returns null if not configured. The token is fetched
 * through the Databricks gateway (which requires the Bearer token on the
 * request), so getDatabricksToken() must succeed first.
 *
 * NOTE: the Databricks gateway REPLACES the Authorization header, so the Medplum
 * token cannot be forwarded that way — it is injected via the __medplum_token
 * cookie, which the medplum-server proxy reads (see apps/medplum-server/start.js).
 */
async function getMedplumToken() {
  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const now = Date.now();
  if (tokenCache.medplum && tokenCache.medplumExpiry && now < (tokenCache.medplumExpiry - 300000)) {
    return tokenCache.medplum;
  }

  const databricksToken = getDatabricksToken();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const tokenUrl = new URL('/oauth2/token', TARGET_URL);
  const options = {
    hostname: tokenUrl.hostname,
    port: 443,
    path: tokenUrl.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${databricksToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.access_token) {
            tokenCache.medplum = json.access_token;
            tokenCache.medplumExpiry = now + ((json.expires_in || 3600) * 1000);
            console.log(`[proxy] Got Medplum token (expires in ${json.expires_in || 3600}s)`);
            resolve(json.access_token);
          } else {
            console.error(`[proxy] Medplum token error: ${res.statusCode} ${Buffer.concat(chunks).toString().slice(0, 200)}`);
            resolve(null);
          }
        } catch (e) {
          console.error(`[proxy] Medplum token parse error: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.error(`[proxy] Medplum token request error: ${e.message}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Make a proxied request to the target server
 */
async function proxyRequest(srcReq, srcRes) {
  // Resolve the incoming request path+query against the target origin. Using the
  // URL constructor's second arg preserves the query string intact (assigning to
  // .pathname would percent-encode the "?" and corrupt FHIR search params).
  const targetUrlObj = new URL(srcReq.url, TARGET_URL);

  console.log(`[proxy] ${srcReq.method} ${srcReq.url} -> ${targetUrlObj.href}`);

  // Get fresh auth tokens
  const databricksToken = getDatabricksToken();
  const medplumToken = await getMedplumToken();

  // Set up headers for the target request
  const targetReqHeaders = { ...srcReq.headers };
  delete targetReqHeaders.host; // Remove host header to avoid conflicts
  // Ask upstream for identity encoding so we can rewrite the (text) body without
  // having to decompress. We still handle gzip defensively on the way back.
  targetReqHeaders['accept-encoding'] = 'identity';

  // Add Databricks OAuth bearer token (passes the Databricks gateway)
  targetReqHeaders['Authorization'] = `Bearer ${databricksToken}`;

  // Inject Medplum token via the __medplum_token cookie (the gateway replaces
  // the Authorization header, so the medplum-server proxy reads this cookie).
  if (medplumToken) {
    const existing = targetReqHeaders['cookie'] ? targetReqHeaders['cookie'] + '; ' : '';
    targetReqHeaders['cookie'] = `${existing}__medplum_token=${medplumToken}`;
  }

  // Make the request
  const protocol = TARGET_URL.startsWith('https') ? https : http;

  // Public origin of THIS proxy, as the client (Inferno) addresses it. FHIR
  // Bundle pagination links (Bundle.link[next], Bundle.entry.fullUrl) come back
  // pointing at TARGET_URL; if we stream them through unchanged, the client
  // follows page 2+ straight to the Databricks gateway WITHOUT the injected
  // auth → 302 login → missing resources. Rewrite them to point back here.
  const clientHost = srcReq.headers.host || `127.0.0.1:${PROXY_PORT}`;
  const proxyOrigin = `http://${clientHost}`;
  const targetOrigin = new URL(TARGET_URL).origin;

  const targetReq = protocol.request(targetUrlObj, {
    method: srcReq.method,
    headers: targetReqHeaders,
  }, (targetRes) => {
    const ctype = targetRes.headers['content-type'] || '';
    const isJson = /json/i.test(ctype);
    if (!isJson) {
      // Non-JSON (binary attachments, etc.): stream through untouched.
      srcRes.writeHead(targetRes.statusCode, targetRes.headers);
      targetRes.pipe(srcRes);
      return;
    }
    // Buffer JSON so we can rewrite absolute target URLs back to the proxy.
    const chunks = [];
    targetRes.on('data', (c) => chunks.push(c));
    targetRes.on('end', () => {
      let raw = Buffer.concat(chunks);
      // Decompress if the upstream ignored our identity request and gzipped it.
      const enc = (targetRes.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip') raw = zlib.gunzipSync(raw);
        else if (enc === 'deflate') raw = zlib.inflateSync(raw);
        else if (enc === 'br') raw = zlib.brotliDecompressSync(raw);
      } catch (e) {
        console.error(`[proxy] decompress (${enc}) failed: ${e.message}`);
      }
      // Replace every absolute target-origin URL with the proxy origin. Covers
      // Bundle.link.url, Bundle.entry.fullUrl, and any other self-referential
      // links, regardless of JSON escaping of "/".
      const body = raw.toString('utf-8').split(targetOrigin).join(proxyOrigin);
      const buf = Buffer.from(body, 'utf-8');
      const outHeaders = { ...targetRes.headers };
      // We send plain, uncompressed text now.
      delete outHeaders['content-encoding'];
      delete outHeaders['transfer-encoding'];
      outHeaders['content-length'] = Buffer.byteLength(buf);
      srcRes.writeHead(targetRes.statusCode, outHeaders);
      srcRes.end(buf);
    });
  });

  // Handle errors
  targetReq.on('error', (error) => {
    console.error(`[proxy] Error proxying request: ${error.message}`);
    srcRes.writeHead(502, { 'Content-Type': 'application/json' });
    srcRes.end(JSON.stringify({
      error: 'Bad Gateway',
      message: error.message,
    }));
  });

  // Forward the request body
  srcReq.pipe(targetReq);
}

/**
 * Main HTTP server
 */
const server = http.createServer((req, res) => {
  // Add CORS headers to support browser-based tests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', targetUrl: TARGET_URL }));
    return;
  }

  // Proxy all other requests
  proxyRequest(req, res).catch((err) => {
    console.error(`[proxy] Unhandled proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    }
  });
});

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  FHIR Compliance Proxy                                    ║
╠═══════════════════════════════════════════════════════════╣
║  Listening on: http://${PROXY_HOST}:${PROXY_PORT}
║  Target FHIR server: ${TARGET_URL}
║  FHIR base path: ${FHIR_BASE_PATH}
║  Health check: http://127.0.0.1:${PROXY_PORT}/health
╚═══════════════════════════════════════════════════════════╝

Use Inferno to test against: http://127.0.0.1:${PROXY_PORT}${FHIR_BASE_PATH}

Proxied endpoints will automatically include Databricks OAuth bearer token.
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[proxy] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[proxy] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});
