// Vercel entry point: one function serves every route (see vercel.json rewrites).
module.exports = require('../src/vercel').makeHandler();
