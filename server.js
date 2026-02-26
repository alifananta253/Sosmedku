require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));
app.use(express.urlencoded({ extended: true }));

// =============================
// Firebase Admin init
// =============================
admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccountKey.json")),
});
const db = admin.firestore();

// =============================
// Auth middleware: ambil user dari Firebase login Flutter
// Header: Authorization: Bearer <idToken>
// =============================
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // { uid, email, name?, ... }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", detail: String(e) });
  }
}

// =============================
// Helper Tripay signature
// signature create transaction = HMAC_SHA256(merchant_code + merchant_ref + amount, private_key)
// =============================
function createTripaySignature({ merchantRef, amount }) {
  return crypto
    .createHmac("sha256", process.env.TRIPAY_PRIVATE_KEY)
    .update(process.env.TRIPAY_MERCHANT_CODE + merchantRef + amount)
    .digest("hex");
}

// =============================
// 0) Health check
// =============================
app.get("/", (req, res) => res.send("Backend Tripay Running 🚀"));

// =============================
// 1) GET payment channels
// =============================
app.get("/tripay/channels", async (req, res) => {
  try {
    const url = `${process.env.TRIPAY_BASE_URL}/merchant/payment-channel`;
    const r = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.TRIPAY_API_KEY}`,
        Accept: "application/json",
      },
      timeout: 15000,
    });
    return res.status(200).json(r.data);
  } catch (e) {
    const status = e?.response?.status || 500;
    return res.status(status).json({
      error: "Failed to fetch channels",
      detail: e?.response?.data || String(e),
    });
  }
});

// =============================
// 2) POST create transaction (Wajib login)
// Body: { method: "OVO", amount: 10000 }
// =============================
app.post("/tripay/transaction/create", requireAuth, async (req, res) => {
  try {
    const { method, amount } = req.body;

    if (!method) return res.status(400).json({ error: "method required" });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 100) {
      return res.status(400).json({ error: "amount invalid (min 100)" });
    }

    const uid = req.user.uid;
    const email = req.user.email || "customer@email.com";
    const name = req.user.name || (email.includes("@") ? email.split("@")[0] : "Customer");

    const merchantRef = `TOPUP-${uid}-${Date.now()}`;
    const signature = createTripaySignature({ merchantRef, amount: amt });

    const payload = {
      method,
      merchant_ref: merchantRef,
      amount: amt,
      customer_name: name,
      customer_email: email,
      order_items: [{ sku: "TOPUP", name: "Top Up Saldo", price: amt, quantity: 1 }],
      callback_url: process.env.TRIPAY_CALLBACK_URL,
      return_url: process.env.TRIPAY_RETURN_URL || "https://example.com",
      signature,
    };

    const r = await axios.post(
      `${process.env.TRIPAY_BASE_URL}/transaction/create`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.TRIPAY_API_KEY}`,
          Accept: "application/json",
        },
        timeout: 20000,
      }
    );

    // Simpan transaksi pending di Firestore
    await db.collection("users").doc(uid).set(
      {
        email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await db.collection("users").doc(uid).collection("topups").doc(merchantRef).set({
      merchantRef,
      method,
      amount: amt,
      status: "PENDING",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      rawCreate: r.data,
    });

    return res.json(r.data);
  } catch (e) {
    const status = e?.response?.status || 500;
    return res.status(status).json({
      error: "Failed to create transaction",
      detail: e?.response?.data || String(e),
    });
  }
});

// =============================
// 3A) GET untuk test di browser
// =============================
app.get("/tripay/callback", (req, res) => {
  res.status(200).send("Tripay callback endpoint ready (POST only)");
});

// =============================
// 3B) POST Tripay callback (dipanggil Tripay)
// =============================
app.post("/tripay/callback", async (req, res) => {
  try {
    const body = req.body || {};
    const raw = req.rawBody || "";
    const got = req.header("X-Callback-Signature") || "";

    console.log("📩 CALLBACK MASUK", new Date().toISOString());
    console.log("signature header:", got);
    console.log("raw length:", raw.length);
    console.log("body:", body);

    if (!raw || Object.keys(body).length === 0) {
      return res.status(400).json({ success: false, message: "Empty body" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.TRIPAY_PRIVATE_KEY)
      .update(raw) // ✅ pakai RAW body
      .digest("hex");

    if (expected !== got) {
      console.log("❌ SIGNATURE INVALID");
      console.log("expected:", expected);
      return res.status(403).json({ success: false, message: "Invalid signature" });
    }

    const merchantRef = String(body.merchant_ref || "");
    const status = String(body.status || "");
    const amount = Number(body.amount || 0);

    // ✅ parse uid aman: TOPUP-<uid>-<timestamp>
    let uid = null;
    if (merchantRef.startsWith("TOPUP-")) {
      const withoutPrefix = merchantRef.substring("TOPUP-".length);
      const lastDash = withoutPrefix.lastIndexOf("-");
      if (lastDash > 0) uid = withoutPrefix.substring(0, lastDash);
    }
    console.log("UID hasil parse:", uid);

    if (!uid) {
      console.log("⚠️ UID tidak terbaca dari merchant_ref:", merchantRef);
      return res.json({ success: true });
    }

    const userRef = db.collection("users").doc(uid);
    const topupRef = userRef.collection("topups").doc(merchantRef);

    await db.runTransaction(async (t) => {
      const snap = await t.get(topupRef);
      const prevStatus = snap.exists ? String(snap.data()?.status || "") : "";

      t.set(topupRef, {
        status,
        amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        rawCallback: body,
      }, { merge: true });

      if (status === "PAID" && prevStatus !== "PAID") {
        t.set(userRef, {
          saldo: admin.firestore.FieldValue.increment(amount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });

    console.log("✅ CALLBACK VALID", { merchantRef, status, amount, uid });
    return res.json({ success: true });
  } catch (e) {
    console.error("Callback error:", e);
    return res.status(500).json({ success: false, message: String(e) });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));