// index.js
'use strict'

const express = require('express')
const httpErrors = require('http-errors')
const pino = require('pino')
const pinoHttp = require('pino-http')

const app = express()
const logger = pino()

// Middleware
app.use(pinoHttp({ logger }))
app.use(express.json()) // penting untuk JSON body

// Routes
require('./routes')(app)

// 404 handler
app.use((req, res, next) => {
  next(httpErrors(404, `Route not found: ${req.url}`))
})

// Error handler
app.use((err, req, res, next) => {
  if (err.status >= 500) {
    logger.error(err)
  }
  res.status(err.status || 500).json({
    messages: [{
      code: err.code || 'InternalServerError',
      message: err.message
    }]
  })
})

// Export Express app sebagai handler serverless
module.exports = app    }
  }
  process.on('uncaughtException', unhandledError)
  process.on('unhandledRejection', unhandledError)

  // Create the express app
  const app = express()


  // Common middleware
  // app.use(/* ... */)
  app.use(pinoHttp({ logger }))
      
  // Register routes
  // @NOTE: require here because this ensures that even syntax errors
  // or other startup related errors are caught logged and debuggable.
  // Alternativly, you could setup external log handling for startup
  // errors and handle them outside the node process.  I find this is
  // better because it works out of the box even in local development.
  require('./routes')(app, opts)

  // Common error handlers
  app.use(function fourOhFourHandler (req, res, next) {
    next(httpErrors(404, `Route not found: ${req.url}`))
  })
  app.use(function fiveHundredHandler (err, req, res, next) {
    if (err.status >= 500) {
      logger.error(err)
    }
    res.status(err.status || 500).json({
      messages: [{
        code: err.code || 'InternalServerError',
        message: err.message
      }]
    })
  })

  // Start server
  server = app.listen(opts.port, opts.host, function (err) {
    if (err) {
      return ready(err, app, server)
    }

    // If some other error means we should close
    if (serverClosing) {
      return ready(new Error('Server was closed before it could start'))
    }

    serverStarted = true
    const addr = server.address()
    logger.info(`Started at ${opts.host || addr.host || 'localhost'}:${addr.port}`)
    ready(err, app, server)
  })
}

