// qb-auth.js — QuickBooks OAuth callback handler
// URL: https://www.fcdteam.com/.netlify/functions/qb-auth
'use strict';
const https = require('https');

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};

  // ── Step 1: Return OAuth URL (GET with action=url) ──────────────────────
  if (params.action === 'url') {
    const clientId = process.env.QB_CLIENT_ID;
    if (!clientId) return json(500, { error: 'QB_CLIENT_ID not set in Netlify env' });

    const redirectUri = encodeURIComponent(getRedirectUri());
    const state = Math.random().toString(36).slice(2);
    const scope = encodeURIComponent('com.intuit.quickbooks.accounting');
    const url = `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}&response_type=code&state=${state}`;
    return json(200, { url });
  }

  // ── Step 2: Intuit redirects back here with ?code=...&realmId=... ───────
  const { code, realmId, error } = params;
  if (error) return redirect('/track?qb=denied');
  if (!code || !realmId) return redirect('/track?qb=error');

  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return redirect('/track?qb=no_credentials');

  // Exchange code → tokens
  const creds  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body   = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(getRedirectUri())}`;
  let tokens;
  try {
    tokens = await post('oauth.platform.intuit.com', '/oauth2/v1/tokens/bearer',
      { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body, false);
  } catch (e) {
    return redirect('/track?qb=token_error');
  }

  if (!tokens.access_token) return redirect('/track?qb=token_error');

  // Persist tokens + realmId as Netlify env vars (updates without redeploy)
  const netlifyToken = process.env.NETLIFY_TOKEN;
  const siteId       = process.env.NETLIFY_SITE_ID;
  try {
    await setEnvVars(netlifyToken, siteId, {
      QB_ACCESS_TOKEN:  tokens.access_token,
      QB_REFRESH_TOKEN: tokens.refresh_token,
      QB_REALM_ID:      realmId
    });
  } catch (e) {
    console.error('Failed to save env vars:', e.message);
    return redirect('/track?qb=save_error');
  }

  return redirect('/track?qb=connected');
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function getRedirectUri() {
  return 'https://www.fcdteam.com/.netlify/functions/qb-auth';
}

function json(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) };
}

function redirect(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

function post(host, path, headers, body, isJson = true) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request({ hostname: host, path, method: 'POST',
      headers: { ...headers, 'Content-Length': buf.length }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// Update (or create) Netlify environment variables
async function setEnvVars(token, siteId, vars) {
  // Fetch existing keys
  const existing = await netlifyReq('GET', `/api/v1/sites/${siteId}/env`, token);
  const existingKeys = Array.isArray(existing) ? new Set(existing.map(e => e.key)) : new Set();

  for (const [key, value] of Object.entries(vars)) {
    if (existingKeys.has(key)) {
      await netlifyReq('PATCH', `/api/v1/sites/${siteId}/env/${key}`, token,
        { value, context: 'all' });
    } else {
      await netlifyReq('POST', `/api/v1/sites/${siteId}/env`, token,
        [{ key, values: [{ value, context: 'all' }] }]);
    }
  }
}

function netlifyReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'api.netlify.com', path, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(buf ? { 'Content-Length': buf.length } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}
