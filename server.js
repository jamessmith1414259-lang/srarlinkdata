
const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  next();
});

app.use(express.static(__dirname));

const paymentStatuses = new Map();
const pendingTransactions = new Map();

const envMode = (process.env.MPESA_ENV || 'sandbox')
  .trim()
  .toLowerCase();

const baseUrl = envMode === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// TELEGRAM NOTIFICATIONS

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}

function maskPhone(phone) {
  const number = String(phone || '');
  return number.length >= 4
    ? '******' + number.slice(-3)
    : 'Hidden';
}

async function sendTelegram(message) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!token || !chatId) {
    console.error('Telegram configuration is missing.');
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML'
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error('Telegram notification failed:', result);
    } else {
      console.log('Telegram notification delivered.');
    }
  } catch (error) {
    console.error('Telegram connection error:', error.message);
  }
}

// HOME PAGE

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// NAIROBI TIMESTAMP

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

// SAFARICOM ACCESS TOKEN

const getAccessToken = async (req, res, next) => {
  try {
    const key = (process.env.MPESA_CONSUMER_KEY || '').trim();
    const secret = (process.env.MPESA_CONSUMER_SECRET || '').trim();

    if (!key || !secret) {
      return res.status(500).json({
        error: 'Missing M-Pesa API credentials.'
      });
    }

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');

    const authUrl =
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`;

    const response = await fetch(authUrl, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json'
      }
    });

    const rawText = await response.text();

    let data = {};

    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        error: `Safaricom OAuth response error (${response.status}).`
      });
    }

    if (!response.ok || !data.access_token) {
      return res.status(response.status).json({
        error: 'Safaricom authentication failed.'
      });
    }

    req.accessToken = data.access_token;
    next();

  } catch (error) {
    console.error('OAuth error:', error.message);

    res.status(500).json({
      error: 'Network error connecting to Safaricom.'
    });
  }
};

// ROUTE 1: M-PESA STK PUSH

app.post('/api/stkpush', getAccessToken, async (req, res) => {
  try {
    let { phone, amount, plan } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        error: 'Phone number and amount are required.'
      });
    }

    phone = phone.toString().replace(/\s+/g, '');

    if (phone.startsWith('0')) {
      phone = '254' + phone.slice(1);
    }

    if (phone.startsWith('+')) {
      phone = phone.slice(1);
    }

    if (!/^254[17]\d{8}$/.test(phone)) {
      return res.status(400).json({
        error: 'Invalid Kenyan phone number.'
      });
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: 'Invalid payment amount.'
      });
    }

    const finalAmount = Math.ceil(numericAmount);
    const selectedPlan = String(plan || 'Data Package').slice(0, 30);

    const timestamp = getNairobiTimestamp();

    const shortcode =
      (process.env.MPESA_SHORTCODE || '174379').trim();

    const passkey =
      (process.env.MPESA_PASSKEY || '').trim();

    if (!passkey) {
      return res.status(500).json({
        error: 'Missing MPESA_PASSKEY configuration.'
      });
    }

    const password = Buffer.from(
      `${shortcode}${passkey}${timestamp}`
    ).toString('base64');

    const transactionType =
      (process.env.MPESA_TRANSACTION_TYPE ||
        'CustomerPayBillOnline').trim();

    const partyB =
      (process.env.MPESA_PARTY_B || shortcode).trim();

    const stkPayload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: finalAmount,
      PartyA: phone,
      PartyB: partyB,
      PhoneNumber: phone,
      CallBackURL: (process.env.MPESA_CALLBACK_URL || '').trim(),
      AccountReference: selectedPlan.slice(0, 12),
      TransactionDesc: `Payment ${selectedPlan}`.slice(0, 13)
    };

    if (!stkPayload.CallBackURL) {
      return res.status(500).json({
        error: 'Missing MPESA_CALLBACK_URL configuration.'
      });
    }

    const stkUrl =
      `${baseUrl}/mpesa/stkpush/v1/processrequest`;

    const response = await fetch(stkUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${req.accessToken}`
      },
      body: JSON.stringify(stkPayload)
    });

    const rawText = await response.text();

    let data = {};

    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        error: 'Invalid Safaricom STK response.'
      });
    }

    if (!response.ok) {
      console.error('STK rejected:', data);

      return res.status(response.status).json({
        error: data.errorMessage || 'STK Push failed.'
      });
    }

    if (data.CheckoutRequestID) {
      const transaction = {
        phone: maskPhone(phone),
        amount: finalAmount,
        plan: selectedPlan,
        createdAt: new Date().toISOString()
      };

      pendingTransactions.set(
        data.CheckoutRequestID,
        transaction
      );

      paymentStatuses.set(data.CheckoutRequestID, {
        status: 'PENDING',
        message: 'Waiting for payment confirmation.'
      });

      // TELEGRAM: STK INITIATED

      await sendTelegram(
        `🟡 <b>NEW PAYMENT REQUEST</b>\n\n` +
        `📦 Plan: ${escapeHTML(selectedPlan)}\n` +
        `💰 Amount: KES ${finalAmount}\n` +
        `📱 Phone: ${transaction.phone}\n` +
        `🆔 Checkout ID:\n<code>${escapeHTML(data.CheckoutRequestID)}</code>\n\n` +
        `⏳ Status: Awaiting customer confirmation`
      );
    }

    res.status(200).json(data);

  } catch (error) {
    console.error('STK Push error:', error.message);

    res.status(500).json({
      error: 'Failed to send M-Pesa prompt.'
    });
  }
});

// ROUTE 2: SAFARICOM CALLBACK

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callbackData = req.body?.Body?.stkCallback;

    if (!callbackData) {
      return res.status(400).json({
        ResultCode: 1,
        ResultDesc: 'Invalid payload'
      });
    }

    const checkoutRequestId = callbackData.CheckoutRequestID;

    const transaction =
      pendingTransactions.get(checkoutRequestId) || {
        phone: 'Unavailable',
        amount: 'Unavailable',
        plan: 'Unavailable'
      };

    console.log(
      'M-Pesa Callback Received:',
      JSON.stringify(callbackData, null, 2)
    );

    if (callbackData.ResultCode === 0) {

      const metadata =
        callbackData.CallbackMetadata?.Item || [];

      const receiptItem = metadata.find(
        item => item.Name === 'MpesaReceiptNumber'
      );

      const receipt = receiptItem
        ? receiptItem.Value
        : 'Confirmed';

      paymentStatuses.set(checkoutRequestId, {
        status: 'SUCCESS',
        receipt: receipt,
        message: `Payment confirmed! Receipt: ${receipt}`
      });

      // TELEGRAM: SUCCESSFUL PAYMENT

      await sendTelegram(
        `🟢 <b>PAYMENT SUCCESSFUL</b>\n\n` +
        `📦 Plan: ${escapeHTML(transaction.plan)}\n` +
        `💰 Amount: KES ${escapeHTML(transaction.amount)}\n` +
        `📱 Phone: ${escapeHTML(transaction.phone)}\n` +
        `🧾 M-Pesa Receipt: <code>${escapeHTML(receipt)}</code>\n` +
        `🆔 Checkout ID:\n<code>${escapeHTML(checkoutRequestId)}</code>\n\n` +
        `✅ Status: Payment confirmed`
      );

    } else {

      const failureReason =
        callbackData.ResultDesc || 'Payment cancelled or failed.';

      paymentStatuses.set(checkoutRequestId, {
        status: 'FAILED',
        message: failureReason
      });

      // TELEGRAM: FAILED PAYMENT

      await sendTelegram(
        `🔴 <b>PAYMENT FAILED</b>\n\n` +
        `📦 Plan: ${escapeHTML(transaction.plan)}\n` +
        `💰 Amount: KES ${escapeHTML(transaction.amount)}\n` +
        `📱 Phone: ${escapeHTML(transaction.phone)}\n` +
        `📝 Reason: ${escapeHTML(failureReason)}\n` +
        `🆔 Checkout ID:\n<code>${escapeHTML(checkoutRequestId)}</code>\n\n` +
        `❌ Status: Payment unsuccessful`
      );
    }

    res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });

  } catch (error) {
    console.error('Callback processing error:', error);

    res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });
  }
});

// ROUTE 3: PAYMENT STATUS POLLING

app.get('/api/payment-status/:checkoutRequestId', (req, res) => {

  const statusObj = paymentStatuses.get(
    req.params.checkoutRequestId
  );

  if (!statusObj) {
    return res.status(404).json({
      status: 'UNKNOWN',
      message: 'Transaction not found'
    });
  }

  res.json(statusObj);
});

// SERVER

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT} in ${envMode} mode (${baseUrl})`
  );
});
                                 
