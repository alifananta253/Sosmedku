const crypto = require("crypto")
const admin = require("firebase-admin")

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

function initFirebase() {
  if (admin.apps.length) return

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT env")

  let sa
  try {
    sa = JSON.parse(raw)
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON")
  }

  if (sa.private_key) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n")
  }

  admin.initializeApp({ credential: admin.credential.cert(sa) })
}

module.exports = async (req, res) => {
  try {
    initFirebase()
    const db = admin.firestore()

    if (req.method === "GET") {
      return res.status(200).send("Tripay callback endpoint ready (POST only)")
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", ["GET", "POST"])
      return res.status(405).json({ success: false, message: "Method not allowed" })
    }

    const got = req.headers["x-callback-signature"] || ""
    if (!got) return res.status(400).json({ success: false, message: "Missing x-callback-signature" })

    const privateKey = process.env.TRIPAY_PRIVATE_KEY
    if (!privateKey) return res.status(500).json({ success: false, message: "Missing TRIPAY_PRIVATE_KEY env" })

    const rawBody = await readRawBody(req) // ✔️ valid await
    if (!rawBody) return res.status(400).json({ success: false, message: "Empty body" })

    let body
    try {
      body = JSON.parse(rawBody)
    } catch {
      return res.status(400).json({ success: false, message: "Body is not valid JSON" })
    }

    const expected = crypto
      .createHmac("sha256", privateKey)
      .update(rawBody)
      .digest("hex")

    if (expected !== got) {
      return res.status(403).json({ success: false, message: "Invalid signature" })
    }

    const merchantRef = String(body.merchant_ref || "")
    const status = String(body.status || "")
    const amount = Number(body.amount || 0)

    let uid = null
    if (merchantRef.startsWith("TOPUP-")) {
      const withoutPrefix = merchantRef.substring("TOPUP-".length)
      const lastDash = withoutPrefix.lastIndexOf("-")
      if (lastDash > 0) uid = withoutPrefix.substring(0, lastDash)
    }

    if (!uid) return res.json({ success: true })

    const userRef = db.collection("users").doc(uid)
    const topupRef = userRef.collection("topups").doc(merchantRef)

    await db.runTransaction(async (t) => {
      const snap = await t.get(topupRef)
      const prevStatus = snap.exists ? String(snap.data()?.status || "") : ""

      t.set(
        topupRef,
        {
          status,
          amount,
          rawCallback: body,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )

      if (status === "PAID" && prevStatus !== "PAID") {
        t.set(
          userRef,
          {
            saldo: admin.firestore.FieldValue.increment(amount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      }
    })

    return res.json({ success: true })
  } catch (e) {
    console.error("Callback error:", e)
    return res.status(500).json({ success: false, message: e.message })
  }
}
