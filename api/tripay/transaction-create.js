const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function requireAuth(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new Error("Missing Bearer token");
  return await admin.auth().verifyIdToken(token);
}

function createTripaySignature({ merchantRef, amount }) {
  return crypto
    .createHmac("sha256", process.env.TRIPAY_PRIVATE_KEY)
    .update(process.env.TRIPAY_MERCHANT_CODE + merchantRef + amount)
    .digest("hex");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const email = decoded.email || "customer@email.com";
    const name = decoded.name || (email.includes("@") ? email.split("@")[0] : "Customer");

    const { method, amount } = req.body || {};
    if (!method) return res.status(400).json({ error: "method required" });

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 1000) {
      return res.status(400).json({ error: "amount invalid (min 1000)" });
    }

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

    // simpan user doc jika belum ada
    await db.collection("users").doc(uid).set(
      {
        email,
        saldo: admin.firestore.FieldValue.increment(0),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // simpan topup doc PENDING
    await db.collection("users").doc(uid).collection("topups").doc(merchantRef).set({
      merchantRef,
      method,
      amount: amt,
      status: "PENDING",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      rawCreate: r.data,
    });

    // ✅ seperti server.js: return r.data
    // ✅ plus merchant_ref untuk Flutter listen
    return res.json({
      ...r.data,
      merchant_ref: merchantRef,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Failed to create transaction",
      detail: e?.response?.data || String(e),
    });
  }
};