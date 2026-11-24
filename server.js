const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Store recent payment statuses in memory so checkout.html can verify payment
const paymentStatuses = new Map();

const baseUrl = process.env.MPESA_ENV === 'production'
  ? 'https://safaricom.co.ke'
  : 'https://safaricom.co.ke';

// Serve index.html on root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware: Generate Safaricom OAuth Token
const getAccessToken = async (req, res, next) => {
  try {
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const response = await axios.get(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    req.accessToken = response.data.access_token;
    next();
  } catch (error) {
    console.error('OAuth Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to authenticate with Safaricom Daraja' });
  }
};

// Route 1: Trigger M-Pesa STK Push
app.post('/api/stkpush', getAccessToken, async (req, res) => {
  try {
    let { phone, amount, plan } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: 'Phone number and amount are required' });
    }

    // Format phone number to 2547XXXXXXXX or 2541XXXXXXXX
    phone = phone.toString().replace(/\s+/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (phone.startsWith('+')) phone = phone.slice(1);

    // Generate Timestamp (YYYYMMDDHHMMSS)
    const now = new Date();
    const timestamp =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    // Use 'CustomerBuyGoodsOnline' if using a Till Number, otherwise 'CustomerPayBillOnline'
    const transactionType = process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
    // For Till numbers, PartyB is your Till Number while BusinessShortCode is your Store/HO number
    const partyB = process.env.MPESA_PARTY_B || shortcode;

    const stkPayload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: Math.ceil(Number(amount)),
      PartyA: phone,
      PartyB: partyB,
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: plan || 'StarlinkData',
      TransactionDesc: `Starlink ${plan || 'Data'} Bundle`
    };

    const response = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      stkPayload,
      { headers: { Authorization: `Bearer ${req.accessToken}` } }
    );

    // Save initial pending state
    if (response.data.CheckoutRequestID) {
      paymentStatuses.set(response.data.CheckoutRequestID, {
        status: 'PENDING',
        message: 'Waiting for PIN entry...'
      });
    }

    res.status(200).json(response.data);
  } catch (error) {
    console.error('STK Push Error:', error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.errorMessage || 'Failed to send M-Pesa prompt'
    });
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
      // Extract M-Pesa Receipt Number
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

// Route 3: Frontend polling endpoint to check payment status
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
