const express = require('express');
const path = require('path');
const https = require('https');
require('dotenv').config();

const app = express();
app.use(express.json());

// Reuse TLS connections to Safaricom for faster STK pushes
const httpsAgent = new https.Agent({ keepAlive: true });

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

app.use(express.static(__dirname));

// Stores payment statuses and order details (plan, phone, amount) by CheckoutRequestID
const paymentStatuses = new Map();

// In-memory cache for Safaricom OAuth Token (~55 mins)
let cachedToken = null;
let tokenExpiryTime = 0;

const envMode = (process.env.MPESA_ENV || 'sandbox').trim().toLowerCase();
const baseUrl = envMode === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// Helper: Send instant message to your Telegram
async function sendTelegramAlert(messageText) {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!botToken || !chatId) {
    console.warn('Telegram alert skipped: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return;
  }

  try {
    const url = `https://telegram.org{botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Telegram notification error:', err.message);
  }
}

// Helper: Generate exact East Africa Time (EAT / UTC+3) timestamp for Safaricom
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

// Middleware: Get Cached Safaricom OAuth Token
const getAccessToken = async (req, res, next) => {
  try {
    if (cachedToken && Date.now() < tokenExpiryTime) {
      req.accessToken = cachedToken;
      return next();
    }

    const key = (process.env.MPESA_CONSUMER_KEY || '').trim();
    const secret = (process.env.MPESA_CONSUMER_SECRET || '').trim();

    if (!key || !secret) {
      return res.status(500).json({
        error: 'Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in Render Environment'
      });
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

    const rawText = await response.text();
    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('Non-JSON OAuth Response:', response.status, authUrl, rawText.slice(0, 300));
      return res.status(502).json({
        error: `Safaricom Firewall Blocked Request (HTTP ${response.status}) on ${authUrl}`
      });
    }

    if (!response.ok || !data.access_token) {
      console.error('OAuth Rejected:', response.status, authUrl, data);
      return res.status(response.status).json({
        error: `Daraja Auth Error (${response.status}) at ${authUrl}: ${data.errorMessage || data.fault?.faultstring || JSON.stringify(data)}`
      });
    }

    cachedToken = data.access_token;
    tokenExpiryTime = Date.now() + (55 * 60 * 1000);
    req.accessToken = cachedToken;
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

    const timestamp = getNairobiTimestamp();
    const shortcode = (process.env.MPESA_SHORTCODE || '').trim();
    const passkey = (process.env.MPESA_PASSKEY || '').trim();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const transactionType = (process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline').trim();
    const partyB = (process.env.MPESA_PARTY_B || shortcode).trim();
    const cleanPlan = plan || 'Starlink Data';
    const cleanAmount = Math.ceil(Number(amount));

    const stkPayload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: cleanAmount,
      PartyA: phone,
      PartyB: partyB,
      PhoneNumber: phone,
      CallBackURL: (process.env.MPESA_CALLBACK_URL || '').trim(),
      AccountReference: cleanPlan.slice(0, 12),
      TransactionDesc: `Starlink ${cleanPlan}`.slice(0, 13)
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

    const rawText = await response.text();
    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({
        error: `STK Push Firewall/HTML Response (HTTP ${response.status}) at ${stkUrl}`
      });
    }

    if (!response.ok) {
      console.error('STK Push Rejected:', response.status, data);
      if (response.status === 401) {
        cachedToken = null;
        tokenExpiryTime = 0;
      }
      return res.status(response.status).json({
        error: `STK Error (${response.status}): ${data.errorMessage || data.ResultDesc || JSON.stringify(data)}`
      });
    }

    if (data.CheckoutRequestID) {
      paymentStatuses.set(data.CheckoutRequestID, {
        status: 'PENDING',
        phone: phone,
        amount: cleanAmount,
        plan: cleanPlan,
        message: 'Waiting for PIN entry...'
      });
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('STK Push Error:', error.message);
    res.status(500).json({ error: `Failed to send M-Pesa prompt: ${error.message}` });
  }
});

// Route 2: Safaricom Callback URL + Telegram Alert
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callbackData = req.body?.Body?.stkCallback;
    if (!callbackData) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid payload' });
    }

    const checkoutRequestId = callbackData.CheckoutRequestID;
    const existingOrder = paymentStatuses.get(checkoutRequestId) || {};
    console.log('M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));

    if (callbackData.ResultCode === 0) {
      const metadata = callbackData.CallbackMetadata?.Item || [];
      const receiptItem = metadata.find((item) => item.Name === 'MpesaReceiptNumber');
      const amountItem = metadata.find((item) => item.Name === 'Amount');
      const phoneItem = metadata.find((item) => item.Name === 'PhoneNumber');

      const receipt = receiptItem ? receiptItem.Value : 'Confirmed';
      const paidAmount = amountItem ? amountItem.Value : (existingOrder.amount || 'N/A');
      const customerPhone = phoneItem ? phoneItem.Value : (existingOrder.phone || 'N/A');
      const selectedPlan = existingOrder.plan || 'Starlink Bundle';

      paymentStatuses.set(checkoutRequestId, {
        ...existingOrder,
        status: 'SUCCESS',
        receipt: receipt,
        message: `Payment confirmed! Receipt: ${receipt}`
      });

      // Send instant Telegram notification for paid order
      const telegramMsg =
        `✅ <b>NEW STARLINK PAYMENT RECEIVED!</b>\n\n` +
        `📦 <b>Package:</b> ${selectedPlan}\n` +
        `💰 <b>Amount:</b> KSh ${paidAmount}\n` +
        `📱 <b>Phone:</b> ${customerPhone}\n` +
        `🧾 <b>M-Pesa Receipt:</b> <code>${receipt}</code>\n` +
        `⏰ <b>Time:</b> ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}`;

      await sendTelegramAlert(telegramMsg);
    } else {
      paymentStatuses.set(checkoutRequestId, {
        ...existingOrder,
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
  
