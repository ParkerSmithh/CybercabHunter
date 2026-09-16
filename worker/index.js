export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'cybercabhunter-worker',
        time: new Date().toISOString()
      });
    }

    // Everything else falls through to the static site (same files GitHub Pages serves).
    return env.ASSETS.fetch(request);
  }
};
