const axios = require("axios");

module.exports = async (req, res) => {
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
    return res.status(500).json({ error: "Failed to fetch channels", detail: e?.response?.data || String(e) });
  }
};