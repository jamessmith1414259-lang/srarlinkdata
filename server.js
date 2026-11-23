
const express = require("express");

const app = express();

app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 10000;

const MPESA_ENV = (process.env.MPESA_ENV || "sandbox").toLowerCase();

const DARAJA_BASE =
  MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

// Temporary payment storage for Sandbox testing.
// Replace with a persistent database before going live.
const payments = new Map();

const requiredEnv = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL"
];

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");

  if (/^0[17]\d{8}$/.test(digits)) {
    return "254" + digits.slice(1);
  }

  if (/^[17]\d{8}$/.test(digits)) {
    return "254" + digits;
  }

  if (/^254[17]\d{8}$/.test(digits)) {
    return digits;
  }

  return null;
}

function getPrices() {
  try {
    return JSON.parse(process.env.PACKAGES_JSON || "{}");
  } catch {
    throw new Error("Invalid PACKAGES_JSON configuration");
  }
}

function getTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return (
    values.year +
    values.month +
    values.day +
    values.hour +
    values.minute +
    values.second
  );
}

async function getAccessToken() {
  const credentials = Buffer.from(
    process.env.MPESA_CONSUMER_KEY +
    ":" +
    process.env.MPESA_CONSUMER_SECRET
  ).toString("base64");

  const response = await fetch(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Daraja authentication failed");
  }

  return data.access_token;
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Starlink M-Pesa backend is running",
    environment: MPESA_ENV
  });
});

// Initiate STK Push
app.post("/api/mpesa/stk-push", async (req, res) => {
  const missing = requiredEnv.filter(
    key => !process.env[key]
  );

  if (missing.length) {
    return res.status(503).json({
      success: false,
      error: "Missing payment configuration",
      missing
    });
  }

  try {
    const { packageId, phone } = req.body || {};

    if (!packageId || !phone) {
      return res.status(400).json({
        success: false,
        error: "Package ID and phone number are required"
      });
    }

    const formattedPhone = normalizePhone(phone);

    if (!formattedPhone) {
      return res.status(400).json({
        success: false,
        error: "Invalid Kenyan M-Pesa phone number"
      });
    }

    // The amount is obtained from server configuration,
    // never trusted from the customer's browser.
    const prices = getPrices();
    const amount = Number(prices[String(packageId)]);

    if (!Number.isSafeInteger(amount) || amount < 1) {
      return res.status(400).json({
        success: false,
        error: "Invalid package or package price"
      });
    }

    const token = await getAccessToken();

    const shortcode = process.env.MPESA_SHORTCODE;
    const timestamp = getTimestamp();

    const password = Buffer.from(
      shortcode +
      process.env.MPESA_PASSKEY +
      timestamp
    ).toString("base64");

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType:
        process.env.MPESA_TRANSACTION_TYPE ||
        "CustomerPayBillOnline",
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: String(packageId).slice(0, 12),
      TransactionDesc: "Starlink subscription"
    };

    const response = await fetch(
      `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (
      !response.ok ||
      data.ResponseCode !== "0" ||
      !data.CheckoutRequestID
    ) {
      return res.status(502).json({
        success: false,
        error:
          data.errorMessage ||
          data.ResponseDescription ||
          "STK Push request failed"
      });
    }

    payments.set(data.CheckoutRequestID, {
      packageId: String(packageId),
      phone: formattedPhone,
      amount: amount,
      status: "PENDING",
      createdAt: new Date().toISOString(),
      resultCode: null,
      resultDesc: null,
      mpesaReceiptNumber: null
    });

    return res.json({
      success: true,
      message:
        data.CustomerMessage ||
        "STK Push sent. Enter your M-Pesa PIN.",
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID
    });

  } catch (error) {
    console.error("STK Push error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Unable to initiate payment"
    });
  }
});

// Safaricom payment callback
app.post("/api/mpesa/callback", (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const checkoutId = callback.CheckoutRequestID;
    const payment = payments.get(checkoutId);

    if (payment) {
      payment.resultCode = Number(callback.ResultCode);
      payment.resultDesc = callback.ResultDesc || "";

      payment.status =
        Number(callback.ResultCode) === 0
          ? "PAID"
          : "FAILED";

      const items =
        callback.CallbackMetadata?.Item || [];

      function getValue(name) {
        return items.find(item => item.Name === name)?.Value;
      }

      payment.mpesaReceiptNumber =
        getValue("MpesaReceiptNumber") || null;

      payment.paidAmount =
        getValue("Amount") || null;

      payment.paidPhone =
        getValue("PhoneNumber") || null;

      payment.completedAt = new Date().toISOString();

      payments.set(checkoutId, payment);
    }

    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });

  } catch (error) {
    console.error("Callback error:", error.message);

    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }
});

// Check payment status
app.get(
  "/api/mpesa/status/:checkoutRequestId",
  (req, res) => {
    const payment = payments.get(
      req.params.checkoutRequestId
    );

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment not found"
      });
    }

    return res.json({
      success: true,
      checkoutRequestId:
        req.params.checkoutRequestId,
      status: payment.status,
      packageId: payment.packageId,
      amount: payment.amount,
      resultDesc: payment.resultDesc,
      mpesaReceiptNumber:
        payment.mpesaReceiptNumber
    });
  }
);

// Start server
app.listen(PORT, () => {
  console.log(
    `Starlink Daraja backend running on port ${PORT}`
  );
});
