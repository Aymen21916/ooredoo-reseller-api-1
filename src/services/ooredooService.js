'use strict';

const axios = require('axios');
const https = require('https');
const env   = require('../config/env');

const ahla_phone_number = process.env.AHLA_PHONE_NUMBER
const ahla_password = process.env.AHLA_PASSWORD
const ahla_code_pin = process.env.AHLA_CODE_PIN

// This acts as memory. It holds the cookie so we don't have to login again.
let ooredooCookie = null;
const httpsAgent = new https.Agent({ rejectUnauthorized: true, family: 4 });

const performOoredooLogin = async () => {
  console.log('[Ooredoo Service] Generating new session cookie...');
  const loginPayload = {
    app_id: "ussd_app", username: ahla_phone_number, password: ahla_password,       
    isdevice: false, device: false, lang: null, app_revision: null,
  };

  const response = await axios.post('https://apps.ooredoo.dz/carrier-prod/api/login', loginPayload, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Linux; Android 11)' },
    httpsAgent, timeout: 15000
  });

  if (response.data.code !== 0) {
    throw new Error('Ooredoo login failed: ' + (response.data.message || 'Unknown error'));
  }

  const setCookieHeader = response.headers['set-cookie'];
  if (setCookieHeader && setCookieHeader.length > 0) {
    ooredooCookie = setCookieHeader.map(c => c.split(';')[0]).join('; ');
  }
};

const callOoredooApi = async (payload) => {
  // 1. If we have no cookie at all (e.g., server just started), login first.
  if (!ooredooCookie) await performOoredooLogin();
  
  const makeRequest = () => axios.post('https://apps.ooredoo.dz/carrier-prod/api/nbservice', payload, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Cookie': ooredooCookie },
    httpsAgent, timeout: 30000, validateStatus: () => true
  });

  // 2. Make the requested USSD API call
  let response = await makeRequest();

  // 3. Detect if Ooredoo rejected our cached cookie
  const isExpired = 
    response.status === 401 || 
    (response.data && response.data.code === 401) || 
    (response.data && response.data.message && String(response.data.message).toLowerCase().includes('expire'));

  // 4. If expired, wipe the memory, login again, and retry the exact same request automatically
  if (isExpired) {
    console.log('[Ooredoo Service] Cookie expired. Re-authenticating silently in background...');
    ooredooCookie = null;
    await performOoredooLogin();
    response = await makeRequest();
  }
  
  return response;
};

module.exports = { callOoredooApi };