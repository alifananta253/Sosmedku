'use strict'
const simple = require('./handlers/simple')
const configured = require('./handlers/configured')

module.exports = function (app, opts) {
  // Setup routes, middleware, and handlers
  app.get('/', simple)
  app.get('/configured', configured(opts))
  app.get("/tripay/callback", (req, res) => {
  res.send("Tripay callback endpoint ready (POST only)");
});
app.post("/tripay/callback", (req, res) => {
  res.json({ success: true });
});
}
