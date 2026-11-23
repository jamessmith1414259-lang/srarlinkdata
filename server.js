
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "100kb" }));

// ===================================
// CONFIGURATION
// ===================================

const PORT = process.env.PORT || 10000;

const MPESA_ENV = (process.env.MPESA_ENV || "sandbox").toLowerCase();

const DARAJA_BASE =
  MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const payments = new Map();

const REQUIRED_ENV = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL"
];

// Website files are in the repository root.
// server.js is inside the server folder.
const WEBSITE_DIR = path.join(__dirname, "..");

// ===================================
// CORS
// ===================================

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN || ""
)
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ===================================
// PHONE NUMBER VALIDATION
// ===================================

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

// ===================================
// PACKAGE PRICES
// ===================================

function getPrices() {
  try {
    return JSON.parse(
      process.env.PACKAGES_JSON || "{}"
    );
  } catch {
    throw new Error("Invalid PACKAGES_JSON");
  }
}

// ===================================
// DARAJA TIMESTAMP
// ===================================

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

  parts.forEach(part => {
    values[part.type] = part.value;
  });

  return (
    values.year +
    values.month +
    values.day +
    values.hour +
    values.minute +
    values.second
  );
}

// ===================================
// GET DARAJA ACCESS TOKEN
// ===================================

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
    throw new Error(
      data.errorMessage || "Daraja authentication failed"
    );
  }

  return data.access_token;
}

// ===================================
// HEALTH CHECK
// ===================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "SRALINK website and M-Pesa backend running",
    environment: MPESA_ENV
  });
});

// ===================================
// INITIATE STK PUSH
// ===================================

app.post("/api/mpesa/stk-push", async (req, res) => {
  const missing = REQUIRED_ENV.filter(
    key => !process.env[key]
  );

  if (missing.length) {
    return res.status(503).json({
      success: false,
      error: "Missing environment configuration",
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

    const transactionType =
      process.env.MPESA_TRANSACTION_TYPE ||
      "CustomerPayBillOnline";

    const isBuyGoods =
      transactionType === "CustomerBuyGoodsOnline";

    if (
      ![
        "CustomerPayBillOnline",
        "CustomerBuyGoodsOnline"
      ].includes(transactionType)
    ) {
      return res.status(400).json({
        success: false,
        error: "Unsupported M-Pesa transaction type"
      });
    }

    if (
      isBuyGoods &&
      !process.env.MPESA_TILL_NUMBER
    ) {
      return res.status(503).json({
        success: false,
        error: "MPESA_TILL_NUMBER is required for Buy Goods"
      });
    }

    const formattedPhone = normalizePhone(phone);

    if (!formattedPhone) {
      return res.status(400).json({
        success: false,
        error: "Invalid Kenyan M-Pesa phone number"
      });
    }

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

    const partyB = isBuyGoods
      ? process.env.MPESA_TILL_NUMBER
      : shortcode;

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: partyB,
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: String(packageId).slice(0, 12),
      TransactionDesc: "Starlink payment"
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
      console.error("Daraja response:", data);

      return res.status(502).json({
        success: false,
        error:
          data.errorMessage ||
          data.ResponseDescription ||
          "STK Push failed"
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
      error: "Unable to initiate M-Pesa payment"
    });
  }
});

// ===================================
// SAFARICOM PAYMENT CALLBACK
// ===================================

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
        return items.find(
          item => item.Name === name
        )?.Value;
      }

      payment.mpesaReceiptNumber =
        getValue("MpesaReceiptNumber") || null;

      payment.paidAmount =
        getValue("Amount") || null;

      payment.paidPhone =
        getValue("PhoneNumber") || null;

      payment.completedAt =
        new Date().toISOString();

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

// ===================================
// CHECK PAYMENT STATUS
// ===================================

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
      checkoutRequestId: req.params.checkoutRequestId,
      status: payment.status,
      packageId: payment.packageId,
      amount: payment.amount,
      resultDesc: payment.resultDesc,
      mpesaReceiptNumber: payment.mpesaReceiptNumber
    });
  }
);

// ===================================
// WEBSITE FILES
// ===================================

// Do not expose backend source or project files.
app.use((req, res, next) => {
  const blocked =
    /^\/server(?:\/|$)/i.test(req.path) ||
    /^\/(?:package(?:-lock)?\.json|\.env.*|README\.md)$/i.test(req.path);

  if (blocked) {
    return res.sendStatus(404);
  }

  next();
});

// Serve index.html and the other website pages
// from the repository's root directory.
app.use(express.static(WEBSITE_DIR, {
  index: "index.html",
  dotfiles: "ignore"
}));

// Friendly message if the homepage is missing.
app.get("/", (req, res) => {
  res.status(404).send(
    "SRALINK homepage not found. Please check that index.html exists in the repository root."
  );
});

// ===================================
// START SERVER
// ===================================

app.listen(PORT, () => {
  console.log(
    `SRALINK website and Daraja backend running on port ${PORT}`
  );

  console.log(
    `M-Pesa environment: ${MPESA_ENV}`
  );

  console.log(
    `Website directory: ${WEBSITE_DIR}`
  );
});
