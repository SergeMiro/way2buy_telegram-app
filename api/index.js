// Vercel serverless entry point. The Express app is imported as a handler —
// server/index.js skips app.listen() when process.env.VERCEL is set.
// Static assets (public/**) are served by Vercel's CDN, not by this function;
// vercel.json rewrites only /api/* and /telegram/* here.
import app from '../server/index.js';

export default app;
