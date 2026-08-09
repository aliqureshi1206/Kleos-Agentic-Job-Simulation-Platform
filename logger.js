// logger.js — minimal structured logging with an optional Sentry hook.
//
// No dependency is required to use this. If SENTRY_DSN is set AND
// @sentry/node has been installed (npm install @sentry/node), errors are
// also forwarded there. Otherwise everything just goes to stdout/stderr as
// single-line JSON, which Railway/Render/Fly/Papertrail/etc can all ingest
// without any extra configuration.

let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
    console.log('Sentry error reporting enabled.');
  } catch (e) {
    console.warn('SENTRY_DSN is set but @sentry/node is not installed. Run `npm install @sentry/node` to enable it — falling back to console-only logging for now.');
  }
}

function logError(err, context = {}) {
  const entry = {
    level: 'error',
    time: new Date().toISOString(),
    message: (err && err.message) || String(err),
    stack: err && err.stack,
    ...context
  };
  console.error(JSON.stringify(entry));
  if (Sentry) Sentry.captureException(err, { extra: context });
}

function logInfo(message, context = {}) {
  console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), message, ...context }));
}

module.exports = { logError, logInfo };
