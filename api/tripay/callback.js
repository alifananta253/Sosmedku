const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  // PENTING: di Vercel jangan pakai file serviceAccountKey.json.
  // Pakai env FIREBASE_SERVICE_ACCOUNT (string JSON)
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).send("Tripay callback endpoint ready (POST only)");
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });

  try {
    const body = req.body || {};
    const got = req.headers["x-callback-signature"] || "";

    console.log("📩 CALLBACK MASUK", new Date().toISOString());
    console.log("signature:", got);
    console.log("body:", body);

    if (!got || Object.keys(body).length === 0) {
      return res.status(400).json({ success: false, message: "Empty body/signature" });
    }

    // vercel: signature biasanya dihitung dari JSON stringify body
    const expected = crypto
      .createHmac("sha256", process.env.TRIPAY_PRIVATE_KEY)
      .update(JSON.stringify(body))
      .digest("hex");

    if (expected !== got) {
      console.log("❌ SIGNATURE INVALID", { expected, got });
      return res.status(403).json({ success: false, message: "Invalid signature" });
    }

    const merchantRef = String(body.merchant_ref || "");
    const status = String(body.status || "");
    const amount = Number(body.amount || 0);

    // merchant_ref format: TOPUP-<uid>-<timestamp>
    let uid = null;
    if (merchantRef.startsWith("TOPUP-")) {
      const withoutPrefix = merchantRef.substring("TOPUP-".length);
      const lastDash = withoutPrefix.lastIndexOf("-");
      if (lastDash > 0) uid = withoutPrefix.substring(0, lastDash);
    }
    if (!uid) return res.json({ success: true });

    const userRef = db.collection("users").doc(uid);
    const topupRef = userRef.collection("topups").doc(merchantRef);

    await db.runTransaction(async (t) => {
      const snap = await t.get(topupRef);
      const prevStatus = snap.exists ? String(snap.data()?.status || "") : "";

      t.set(topupRef, { status, amount, rawCallback: body, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      if (status === "PAID" && prevStatus !== "PAID") {
        t.set(userRef, { saldo: admin.firestore.FieldValue.increment(amount), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    });

    console.log("✅ CALLBACK VALID", { merchantRef, status, amount, uid });
    return res.json({ success: true });
  } catch (e) {
    console.error("Callback error:", e);
    return res.status(500).json({ success: false, message: String(e) });
  }
};