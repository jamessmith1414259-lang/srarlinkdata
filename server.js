const express = require('express');
const path = require('path');
const https = require('https');
require('dotenv').config();

const app = express();
app.use(express.json());

// Reuse TLS connections to Safaricom to eliminate SSL handshake delays
const httpsAgent = new https.Agent({ keepAlive: true });

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

app.use(express.static(__dirname));

const paymentStatuses = new Map();

// In-memory cache for Safaricom OAuth Token (valid for ~59 mins)
let cachedToken = null;
let tokenExpiryTime = 0;

const envMode = (process.env.MPESA_ENV || 'sandbox').trim().toLowerCase();
const baseUrl = envMode === 'production'
  ? 'https://safaricom.co.ke'
  : 'https://safaricom.co.ke';

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint for UptimeRobot to prevent Render cold starts
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

function getNairobiTimestamp() {
  const now = new Date();
  const eatTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  return (
    eatTime.getUTCFullYear().toString() +
    String(eatTime.getUTCMonth() + 1).padStart(2, '0') +
    String(eatTime.getUTCDate()).padStart(2, '0') +
    String(eatTime.getUTCHours()).padStart(2, '0') +
    String(eatTime.getUTCMinutes()).padStart(2, '0') +
    String(eatTime.getUTCSeconds()).padStart(2, '0')
  );
}

// Middleware: Get Cached OAuth Token (0ms delay when cached!)
const getAccessToken = async (req, res, next) => {
  try {
    // Return cached token immediately if still valid (with 2-minute safety buffer)
    if (cachedToken && Date.now() < tokenExpiryTime) {
      req.accessToken = cachedToken;
      return next();
    }

    const key = (process.env.MPESA_CONSUMER_KEY || '').trim();
    const secret = (process.env.MPESA_CONSUMER_SECRET || '').trim();

    if (!key || !secret) {
      return res.status(500).json({ error: 'Missing M-Pesa keys in Render Environment' });
    }

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const authUrl = `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`;

    const response = await fetch(authUrl, {
      method: 'GET',
      agent: httpsAgent,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      console.error('OAuth Rejected:', response.status, data);
      return res.status(response.status).json({ error: 'Failed to authenticate with Safaricom' });
    }

    // Cache token for 55 minutes (3,300,000 ms)
    cachedToken = data.access_token;
    tokenExpiryTime = Date.now() + (55 * 60 * 1000);
    req.accessToken = cachedToken;
    next();
  } catch (error) {
    console.error('OAuth Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// Pre-warm the OAuth token right when the server boots up
async function prewarmToken() {
  try {
    const key = (process.env.MPESA_CONSUMER_KEY || '').trim();
    const secret = (process.env.MPESA_CONSUMER_SECRET || '').trim();
    if (!key || !secret) return;

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const res = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const data = await res.json();
    if (data.access_token) {
      cachedToken = data.access_token;
      tokenExpiryTime = Date.now() + (55 * 60 * 1000);
      console.log('Safaricom OAuth token pre-warmed and cached.');
    }
  } catch (e) {}
}

// Route 1: Trigger M-Pesa STK Push
app.post('/api/stkpush', getAccessToken, async (req, res) => {
  try {
    let { phone, amount, plan } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: 'Phone number and amount are required' });
    }

    phone = phone.toString().replace(/\s+/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (phone.startsWith('+')) phone = phone.slice(1);

    const timestamp = getNairobiTimestamp();
    const shortcode = (process.env.MPESA_SHORTCODE || '').trim();
    const passkey = (process.env.MPESA_PASSKEY || '').trim();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const transactionType = (process.env.MPESA_TRANSACTION_TYPE || 'CustomerBuyGoodsOnline').trim();
    const partyB = (process.env.MPESA_PARTY_B || shortcode).trim();

    const stkPayload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: Math.ceil(Number(amount)),
      PartyA: phone,
      PartyB: partyB,
      PhoneNumber: phone,
      CallBackURL: (process.env.MPESA_CALLBACK_URL || '').trim(),
      AccountReference: (plan || 'StarlinkData').slice(0, 12),
      TransactionDesc: `Starlink ${plan || 'Data'}`.slice(0, 13)
    };

    const stkUrl = `${baseUrl}/mpesa/stkpush/v1/processrequest`;
    const response = await fetch(stkUrl, {
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${req.accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify(stkPayload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('STK Push Rejected:', response.status, data);
      // If token expired unexpectedly, clear cache for next request
      if (response.status === 401) {
        cachedToken = null;
        tokenExpiryTime = 0;
      }
      return res.status(response.status).json({ error: data.errorMessage || 'STK Push failed' });
    }

    if (data.CheckoutRequestID) {
      paymentStatuses.set(data.CheckoutRequestID, {
        status: 'PENDING',
        message: 'Waiting for PIN entry...'
      });
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('STK Push Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Route 2: Safaricom Callback URL
app.post('/api/mpesa/callback', (req, res) => {
  try {
    const callbackData = req.body?.Body?.stkCallback;
    if (!callbackData) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid payload' });
    }

    const checkoutRequestId = callbackData.CheckoutRequestID;
    console.log('M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));

    if (callbackData.ResultCode === 0) {
      const metadata = callbackData.CallbackMetadata?.Item || [];
      const receiptItem = metadata.find((item) => item.Name === 'MpesaReceiptNumber');
      const receipt = receiptItem ? receiptItem.Value : 'Confirmed';

      paymentStatuses.set(checkoutRequestId, {
        status: 'SUCCESS',
        receipt: receipt,
        message: `Payment confirmed! Receipt: ${receipt}`
      });
    } else {
      paymentStatuses.set(checkoutRequestId, {
        status: 'FAILED',
        message: callbackData.ResultDesc || 'Payment cancelled or failed.'
      });
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback processing error:', err);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// Route 3: Frontend polling endpoint
app.get('/api/payment-status/:checkoutRequestId', (req, res) => {
  const statusObj = paymentStatuses.get(req.params.checkoutRequestId);
  if (!statusObj) {
    return res.status(404).json({ status: 'UNKNOWN', message: 'Transaction not found' });
  }
  res.json(statusObj);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${envMode} mode`);
  prewarmToken();
});
