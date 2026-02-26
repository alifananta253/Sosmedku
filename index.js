const express = require("express")
const httpErrors = require("http-errors")
const pino = require("pino")
const pinoHttp = require("pino-http")

const app = express()
const logger = pino()

// middleware
app.use(pinoHttp({ logger }))
app.use(express.json()) // penting untuk JSON body

// routes
require("./routes")(app) 

// 404 handler
app.use((req, res, next) => {
  next(httpErrors(404, `Route not found: ${req.url}`))
})

// error handler
app.use((err, req, res, next) => {
  if (err.status >= 500) logger.error(err)
  res.status(err.status || 500).json({
    messages: [{
      code: err.code || "InternalServerError",
      message: err.message,
    }]
  })
})

// **tidak ada app.listen / ready callback**
module.exports = app
