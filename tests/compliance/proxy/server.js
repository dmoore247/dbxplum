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
const { execSync } = require('child_process');

// Configuration
const PROXY_PORT = process.env.PROXY_PORT || 3333;
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
 * Get Medplum token from environment.
 * In a real setup, this would refresh from Medplum's token endpoint.
 * For now, it's a static value provided by the user.
 */
function getMedplumToken() {
  // TODO: Support medplum auth once credentials are provided
  // For now, return null (Medplum auth will be injected when available)
  return process.env.MEDPLUM_TOKEN || null;
}

/**
 * Make a proxied request to the target server
 */
function proxyRequest(srcReq, srcRes) {
  const srcUrl = url.parse(srcReq.url, true);
  const targetPath = srcUrl.pathname + (srcUrl.search || '');

  // Construct the full target URL
  const targetUrlObj = new URL(TARGET_URL);
  targetUrlObj.pathname = targetPath;

  console.log(`[proxy] ${srcReq.method} ${srcReq.url} -> ${targetUrlObj.href}`);

  // Get fresh auth tokens
  const databricksToken = getDatabricksToken();
  const medplumToken = getMedplumToken();

  // Set up headers for the target request
  const targetReqHeaders = { ...srcReq.headers };
  delete targetReqHeaders.host; // Remove host header to avoid conflicts

  // Add Databricks OAuth bearer token
  targetReqHeaders['Authorization'] = `Bearer ${databricksToken}`;

  // Add Medplum auth if available (might be a different header or same)
  // For now, we only do Databricks. Medplum will come later.

  // Make the request
  const protocol = TARGET_URL.startsWith('https') ? https : http;

  const targetReq = protocol.request(targetUrlObj, {
    method: srcReq.method,
    headers: targetReqHeaders,
  }, (targetRes) => {
    // Copy status and headers
    srcRes.writeHead(targetRes.statusCode, targetRes.headers);

    // Stream the response body
    targetRes.pipe(srcRes);
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
  proxyRequest(req, res);
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  FHIR Compliance Proxy                                    ║
╠═══════════════════════════════════════════════════════════╣
║  Listening on: http://127.0.0.1:${PROXY_PORT}
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
