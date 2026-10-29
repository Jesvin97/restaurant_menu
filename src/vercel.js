// Serverless entry logic, kept out of api/index.js so it can be tested.
const config = require('./config');

const plain = (res, code, text) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
};

/**
 * Builds the (req, res) handler Vercel calls. Any start-up failure becomes a readable response
 * (and a log line with the full stack) instead of an opaque FUNCTION_INVOCATION_FAILED.
 */
function makeHandler(load = () => require('./server').createServer()) {
  if (config.missingEnv.length) {
    const msg = `Server is not configured yet. Set these environment variables in the hosting dashboard and redeploy: ${config.missingEnv.join(', ')}`;
    return (req, res) => plain(res, 503, msg);
  }
  try {
    const server = load();
    return (req, res) => server.emit('request', req, res);
  } catch (e) {
    console.error('Startup failed:', e);
    const msg = `Startup failed: ${e.code || e.name}: ${e.message}\nThe full stack trace is in the runtime logs.`;
    return (req, res) => plain(res, 500, msg);
  }
}

module.exports = { makeHandler };
