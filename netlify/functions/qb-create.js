// qb-create.js — Create an expense/purchase in QuickBooks Online
// POST /.netlify/functions/qb-create
'use strict';
const https = require('https');

// Category → QB expense account name (used to find account by name via QB query)
const CATEGORY_MAP = {
  'plumbing':   'Plumbing',
  'electrical': 'Electrical',
  'gas':        'Gas',
  'bathroom':   'Bathroom Remodel',
  'wood':       'Materials & Supplies',
  'other':      'Job Related Costs'
};

// Fallback account names to search for if specific one not found
const FALLBACK_ACCOUNT_NAMES = ['Job Related Costs', 'Job Materials', 'Materials & Supplies', 'Cost of Goods Sold', 'Expenses'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // Verify internal secret
  const auth = (event.headers.authorization || '').replace('Bearer ', '');
  if (auth !== process.env.FCD_SECRET) return json(401, { error: 'Unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { amount, category, name, job_site, description, type, date, items_bought } = body;
  if (!amount || isNaN(parseFloat(amount))) return json(400, { error: 'Invalid amount' });

  let accessToken  = process.env.QB_ACCESS_TOKEN;
  const refreshToken = process.env.QB_REFRESH_TOKEN;
  const realmId    = process.env.QB_REALM_ID;
  if (!realmId) return json(401, { error: 'QB not connected. Click Connect QB first.' });

  // Find the right expense account in QB
  let accountRef;
  try {
    accountRef = await findExpenseAccount(accessToken, realmId, category);
    if (!accountRef) throw new Error('No account found');
  } catch (e) {
    // If unauthorized, refresh token and retry
    if (e.message === 'UNAUTHORIZED') {
      accessToken = await refreshQBToken(refreshToken);
      if (!accessToken) return json(401, { error: 'QB token expired. Please reconnect QB.' });
      accountRef = await findExpenseAccount(accessToken, realmId, category);
    }
    if (!accountRef) return json(500, { error: 'Could not find QB expense account. Please check your chart of accounts.' });
  }

  // Find payment account dynamically (don't hardcode ID '1' — differs per QB company)
  let paymentAccountRef = { value: '1', name: 'Cash' };
  try {
    paymentAccountRef = await findPaymentAccount(accessToken, realmId);
  } catch (e) { /* use default */ }

  // Build memo line
  const memo = [name, job_site, items_bought || description].filter(Boolean).join(' · ');
  const txnDate = date ? date.split('T')[0] : new Date().toISOString().split('T')[0];

  // QB Purchase (Cash) payload
  const purchase = {
    PaymentType: 'Cash',
    AccountRef:  paymentAccountRef, // payment from Cash/Checking (found dynamically)
    TxnDate:     txnDate,
    PrivateNote: memo,
    Line: [{
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount:     parseFloat(amount),
      Description: items_bought || description || category || 'FCD Purchase',
      AccountBasedExpenseLineDetail: {
        AccountRef:      accountRef,
        BillableStatus:  'NotBillable'
      }
    }]
  };

  // Create in QB
  let result;
  try {
    result = await qbRequest(accessToken, realmId, 'POST', '/purchase', purchase);
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      accessToken = await refreshQBToken(refreshToken);
      if (!accessToken) return json(401, { error: 'QB token expired. Please reconnect.' });
      result = await qbRequest(accessToken, realmId, 'POST', '/purchase', purchase);
    } else {
      throw e;
    }
  }

  if (result && result.Purchase) {
    return json(200, {
      success: true,
      qb_id:        result.Purchase.Id,
      sync_token:   result.Purchase.SyncToken,
      doc_number:   result.Purchase.DocNumber,
      account_used: accountRef.name
    });
  }

  // QB returned a fault
  const fault = result && result.Fault;
  const errMsg = fault && fault.Error && fault.Error[0] ? fault.Error[0].Message : 'Unknown QB error';
  return json(500, { error: errMsg, detail: fault });
};

// ── Find payment account (checking/cash) for Purchase "paid from" ────────────
async function findPaymentAccount(token, realmId) {
  const query = encodeURIComponent("SELECT * FROM Account WHERE AccountType IN ('Bank', 'Other Current Asset') MAXRESULTS 30");
  const result = await qbRequest(token, realmId, 'GET', `/query?query=${query}`, null);
  const accounts = (result.QueryResponse && result.QueryResponse.Account) || [];
  const prefNames = ['checking', 'cash', 'petty', 'bank'];
  for (const pref of prefNames) {
    const match = accounts.find(a => a.Name.toLowerCase().includes(pref));
    if (match) return { value: match.Id, name: match.Name };
  }
  return accounts.length ? { value: accounts[0].Id, name: accounts[0].Name } : { value: '1', name: 'Cash' };
}

// ── Find expense account by category name, with fallback ─────────────────────
async function findExpenseAccount(token, realmId, category) {
  const catKey = (category || 'other').toLowerCase().split('/')[0].trim();
  const preferred = CATEGORY_MAP[catKey] || 'Job Related Costs';

  // Query QB for expense/COGS accounts
  const query = encodeURIComponent("SELECT * FROM Account WHERE AccountType IN ('Cost of Goods Sold', 'Expense') MAXRESULTS 100");
  const result = await qbRequest(token, realmId, 'GET', `/query?query=${query}`, null);
  const accounts = (result.QueryResponse && result.QueryResponse.Account) || [];

  if (!accounts.length) return null;

  // Try to match preferred name
  const findByName = (name) => accounts.find(a => a.Name.toLowerCase().includes(name.toLowerCase()));

  let match = findByName(preferred);
  if (!match) {
    for (const fallback of FALLBACK_ACCOUNT_NAMES) {
      match = findByName(fallback);
      if (match) break;
    }
  }
  // Last resort: first expense account
  if (!match) match = accounts[0];

  return match ? { value: match.Id, name: match.Name } : null;
}

// ── Refresh QB access token ───────────────────────────────────────────────────
async function refreshQBToken(refreshToken) {
  if (!refreshToken) return null;
  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body  = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;

  const tokens = await httpPost('oauth.platform.intuit.com', '/oauth2/v1/tokens/bearer',
    { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);

  if (!tokens.access_token) return null;

  // Persist refreshed tokens
  await setEnvVars({
    QB_ACCESS_TOKEN:  tokens.access_token,
    QB_REFRESH_TOKEN: tokens.refresh_token || refreshToken
  });

  return tokens.access_token;
}

// ── QB API request ────────────────────────────────────────────────────────────
function qbRequest(token, realmId, method, path, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const fullPath = `/v3/company/${realmId}${path}${path.includes('?') ? '&' : '?'}minorversion=65`;
    const req = https.request({
      hostname: 'quickbooks.api.intuit.com',
      path: fullPath, method,
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

function httpPost(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request({ hostname: host, path, method: 'POST',
      headers: { ...headers, 'Content-Length': buf.length }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function json(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.fcdteam.com' }, body: JSON.stringify(obj) };
}

function cors() {
  return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': 'https://www.fcdteam.com', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
}

async function setEnvVars(vars) {
  const token  = process.env.NETLIFY_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;
  const existing = await netlifyReq('GET', `/api/v1/sites/${siteId}/env`, token);
  const existingKeys = Array.isArray(existing) ? new Set(existing.map(e => e.key)) : new Set();
  for (const [key, value] of Object.entries(vars)) {
    if (existingKeys.has(key)) {
      await netlifyReq('PATCH', `/api/v1/sites/${siteId}/env/${key}`, token, { value, context: 'all' });
    } else {
      await netlifyReq('POST', `/api/v1/sites/${siteId}/env`, token, [{ key, values: [{ value, context: 'all' }] }]);
    }
  }
}

function netlifyReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'api.netlify.com', path, method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(buf ? { 'Content-Length': buf.length } : {}) }
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
