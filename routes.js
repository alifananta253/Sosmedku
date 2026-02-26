// routes.js
'use strict'

const simple = require('./handlers/simple')
const configured = require('./handlers/configured')

module.exports = function (app) {
  // Setup routes
  app.get('/', simple)
  app.get('/configured', configured({}))

  app.get('/tripay/callback', (req, res) => {
    res.send("Tripay callback endpoint ready (POST only)")
  })

  app.post('/tripay/callback', (req, res) => {
    res.json({ success: true })
  })
}
