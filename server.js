const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Disable caching so updates appear immediately
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

app.use(express.static(__dirname));

const paymentStatuses = new Map();

const baseUrl = (process.env.MPESA_ENV || 'sandbox').trim() === 'production'
  ? 'https://safaricom.co.ke'
  : 'https://safaricom.co.ke';

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware: Generate Safaricom OAuth Token using native fetch
const getAccessToken = async (req, res, next) => {
  try {
    const key = (process.env.MPESA_CONSUMER_KEY || '').trim();
    const secret = (process.env.MPESA_CONSUMER_SECRET || '').trim();

    if (!key || !secret) {
      return res.status(500).json({
        error: 'Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in Render Environment'
      });
    }

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');

    const response = await fetch(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    );

    const rawText = await response.text();
    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('Non-JSON OAuth Response:', response.status, rawText.slice(0, 300));
      return res.status(502).json({
        error: `Safaricom Firewall Blocked Request (HTTP ${response.status}). Sandbox often blocks shared cloud IPs; Production API works once live.`
      });
    }

    if (!response.ok || !data.access_token) {
      console.error('OAuth Rejected:', response.status, data);
      return res.status(response.status).json({
        error: `Daraja Auth Rejected (${response.status}): ${data.errorMessage || data.error || 'Check Consumer Key & Secret'}`
      });
    }

    req.accessToken = data.access_token;
    next();
  } catch (error) {
    console.error('OAuth Network Error:', error.message);
    res.status(500).json({ error: `Network error connecting to Safaricom: ${error.message}` });
  }
};

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

    const now = new Date();
    const timestamp =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');

    const shortcode = (process.env.MPESA_SHORTCODE || '').trim();
    const passkey = (process.env.MPESA_PASSKEY || '').trim();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const transactionType = (process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline').trim();
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
      AccountReference: plan || 'StarlinkData',
      TransactionDesc: `Starlink ${plan || 'Data'} Bundle`
    };

    const response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
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
      return res.status(response.status).json({
        error: data.errorMessage || data.ResultDesc || 'STK Push rejected by Safaricom'
      });
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
    res.status(500).json({ error: `Failed to send M-Pesa prompt: ${error.message}` });
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
  console.log(`Server running on port ${PORT}`);
});
