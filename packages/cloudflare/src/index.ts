import { createAuthHandlers } from "./auth";
import type { Env } from "./do";

export { GitGlanceDO } from "./do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const auth = createAuthHandlers(env);

    try {
      const authEnabled = !!env.AUTH_ISSUER_URL;

      if (authEnabled) {
        if (url.pathname === "/api/auth/login" && request.method === "GET")
          return await auth.loginRedirect();
        if (url.pathname === "/api/auth/callback" && request.method === "GET")
          return await auth.handleCallback(request);
        if (url.pathname === "/api/auth/logout" && request.method === "POST")
          return auth.logout();
        if (url.pathname === "/api/session" && request.method === "GET")
          return await auth.sessionEndpoint(request);
      }

      if (url.pathname === "/ws") {
        const token = url.searchParams.get("token");
        if (token) {
          if (!env.GLANCE_SECRET || token !== env.GLANCE_SECRET) {
            return new Response("Forbidden", { status: 403 });
          }
          const id = env.GIT_GLANCE_DO.idFromName("git-glance");
          return env.GIT_GLANCE_DO.get(id).fetch(request);
        }

        if (authEnabled) await auth.requireSession(request);
        const id = env.GIT_GLANCE_DO.idFromName("git-glance");
        return env.GIT_GLANCE_DO.get(id).fetch(request);
      }

      if (authEnabled) await auth.requireSession(request);
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status === 404) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
      }
      return assetResponse;
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("unhandled error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
