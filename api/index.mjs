/**
 * Vercel Function entry point.
 * vercel.json serves public/ from the CDN and rewrites every /api/* and /vendor/* request here;
 * the shared handler in server.mjs does the routing, caching and upstream proxying.
 */
export { handler as default } from '../server.mjs';
