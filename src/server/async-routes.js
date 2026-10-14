/**
 * async-routes.js — an error thrown in a route can't take the server down.
 *
 * Express 4 doesn't catch a rejected promise from an async route handler, and
 * Node (15+) exits the process on an unhandled rejection. So a throw anywhere in
 * server.js's ~200 async routes, outside that route's own try, killed the whole
 * Familiar: every surface, every loop, until something restarted it. (Seen live:
 * a provider dropping its connection mid-reply crashed the server through
 * /api/chat's raw path — fixed at the call site in 0.14.66; this is the net
 * under every other route.)
 *
 *   guardAsyncRoutes(app)      — call once, right after `express()`, before any
 *                                route is registered. Every handler given to
 *                                app.get/post/put/patch/delete/all that returns
 *                                a promise has its rejection passed to next(err).
 *   asyncRouteErrorHandler()   — register LAST, after every route: answers
 *                                `{ error }` (the route's own status if it set a
 *                                4xx/5xx one — e.g. the body parser's 400/413 —
 *                                else 500) and logs the route + stack loudly. A
 *                                response that already started is ended, never
 *                                left hanging.
 *
 * Deliberately NOT a process-wide unhandledRejection swallow: that would hide
 * real bugs and leave the request that hit them hanging with no answer.
 */

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

export function guardAsyncRoutes(app) {
  for (const verb of VERBS) {
    const original = app[verb];
    if (typeof original !== 'function') continue;
    app[verb] = function guardedRoute(...args) {
      // app.get('name') with one argument is Express's settings getter.
      if (verb === 'get' && args.length === 1) return original.apply(this, args);
      const [routePath, ...handlers] = args;
      return original.call(this, routePath, ...handlers.map(wrapHandler));
    };
  }
  return app;
}

function wrapHandler(handler) {
  if (Array.isArray(handler)) return handler.map(wrapHandler);
  // Error handlers (err, req, res, next) are recognised by arity — leave them be.
  if (typeof handler !== 'function' || handler.length >= 4) return handler;
  return function guardedHandler(req, res, next) {
    const out = handler.call(this, req, res, next);
    if (out && typeof out.then === 'function') {
      // A bare `throw undefined` must still reach next() as an ERROR: next()
      // with no argument means "carry on to the next route".
      out.then(undefined, (err) => next(err ?? new Error(`${req.method} ${req.originalUrl ?? req.url} rejected without a reason`)));
    }
    return out;
  };
}

export function asyncRouteErrorHandler(log = console) {
  // eslint-disable-next-line no-unused-vars
  return function routeErrorHandler(err, req, res, next) {
    const where = `${req.method} ${req.originalUrl ?? req.url}`;
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) log.error(`[server] ${where} threw — answered ${status}, the server stays up:`, err?.stack ?? err);
    else log.warn(`[server] ${where} → ${status}: ${err?.message ?? err}`);
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    res.status(status).json({ error: err?.message || 'Something went wrong handling this request.' });
  };
}
