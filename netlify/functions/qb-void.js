// qb-void.js — Void (soft-delete) a QuickBooks expense
// POST /.netlify/functions/qb-void
// Body: { qb_id, sync_token }
'use strict';
const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const auth = (event.headers.authorization || '').replace('Bearer ', '');
  if (auth !== process.env.FCD_SECRET) return json(401, { error: 'Unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { qb_id, sync_token } = body;
  if (!qb_id) return json(400, { error: 'Missing qb_id' });

  let accessToken   = process.env.QB_ACCESS_TOKEN;
  const refreshToken = process.env.QB_REFRESH_TOKEN;
  const realmId     = process.env.QB_REALM_ID;
  if (!realmId) return json(401, { error: 'QB not connected' });

  // QB void: POST /purchase?operation=void with the purchase object
  // We need the current SyncToken to void — if not provided, fetch it first
  let st = sync_token;
  if (!st) {
    try {
      const existing = await qbRequest(accessToken, realmId, 'GET', `/purchase/${qb_id}`, null);
      st = existing.Purchase && existing.Purchase.SyncToken;
    } catch (e) {
      if (e.message === 'UNAUTHORIZED') {
        accessToken = await refreshQBToken(refreshToken);
        if (!accessToken) return json(401, { error: 'QB token expired. Please reconnect.' });
        const existing = await qbRequest(accessToken, realmId, 'GET', `/purchase/${qb_id}`, null);
        st = existing.Purchase && existing.Purchase.SyncToken;
      }
    }
  }

  if (!st) return json(404, { error: 'QB transaction not found or already voided' });

  // Void it
  const voidPayload = { Id: String(qb_id), SyncToken: String(st), sparse: true };
  let result;
  try {
    result = await qbRequest(accessToken, realmId, 'POST', `/purchase?operation=void`, voidPayload);
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      accessToken = await refreshQBToken(refreshToken);
      if (!accessToken) return json(401, { error: 'QB token expired. Please reconnect.' });
      result = await qbRequest(accessToken, realmId, 'POST', `/purchase?operation=void`, voidPayload);
    } else throw e;
  }

  if (result && result.Purchase) {
    return json(200, { success: true, voided: true, qb_id });
  }

  const fault = result && result.Fault;
  const errMsg = fault && fault.Error && fault.Error[0] ? fault.Error[0].Message : 'Failed to void';
  return json(500, { error: errMsg });
};

function qbRequest(token, realmId, method, path, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const sep = path.includes('?') ? '&' : '?';
    const req = https.request({
      hostname: 'quickbooks.api.intuit.com',
      path: `/v3/company/${realmId}${path}${sep}minorversion=65`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(buf ? { 'Content-Length': buf.length } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('UNAUTHORIZED'));
        try { resolve(JSON.parse(d)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function refreshQBToken(refreshToken) {
  if (!refreshToken) return null;
  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const tokens = await new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: 'oauth.platform.intuit.com', path: '/oauth2/v1/tokens/bearer', method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(buf); req.end();
  });
  return tokens.access_token || null;
}

function json(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.fcdteam.com' }, body: JSON.stringify(obj) };
}
function cors() {
  return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': 'https://www.fcdteam.com', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
}
