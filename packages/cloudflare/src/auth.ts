import { createClient } from "@openauthjs/openauth/client";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

export type AuthEnv = {
  AUTH_ISSUER_URL: string;
  AUTH_CLIENT_ID: string;
  APP_PUBLIC_URL: string;
  OWNER_EMAIL: string;
  DEV_AUTH_EMAIL?: string;
};

export type Session = {
  email: string;
  tokens?: {
    access: string;
    refresh: string;
    expiresIn: number;
  };
};

type AccessVerifyResult =
  | { kind: "ok"; email: string }
  | { kind: "expired" }
  | { kind: "invalid" };

const REFRESH_TIMEOUT_MS = 10_000;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string } = {},
) {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  cookie += `; Path=${opts.path ?? "/"}`;
  if (opts.secure !== false) cookie += `; Secure`;
  if (opts.httpOnly !== false) cookie += `; HttpOnly`;
  cookie += `; SameSite=${opts.sameSite ?? "Lax"}`;
  return cookie;
}

function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function envAccessCookie(value: string, maxAge: number) {
  return serializeCookie("auth_access_token", value, { maxAge });
}

function envRefreshCookie(value: string) {
  return serializeCookie("auth_refresh_token", value, { maxAge: 60 * 60 * 24 * 365 });
}

function clearCookie(name: string) {
  return serializeCookie(name, "", { maxAge: 0 });
}

export function createAuthHandlers(env: AuthEnv) {
  let jwksUrl: string | null = null;
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  function getJwks() {
    const url = `${env.AUTH_ISSUER_URL}/.well-known/jwks.json`;
    if (!jwks || jwksUrl !== url) {
      jwksUrl = url;
      jwks = createRemoteJWKSet(new URL(url));
    }
    return jwks;
  }

  async function verifyAccessToken(token: string, retryOnFailure: boolean): Promise<AccessVerifyResult> {
    for (let attempt = 0; attempt < (retryOnFailure ? 2 : 1); attempt++) {
      try {
        const { payload } = await jwtVerify(token, getJwks(), { issuer: env.AUTH_ISSUER_URL });
        if (payload.mode !== "access") return { kind: "invalid" };
        const properties = payload.properties as { email?: unknown } | undefined;
        return typeof properties?.email === "string"
          ? { kind: "ok", email: normalizeEmail(properties.email) }
          : { kind: "invalid" };
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) return { kind: "expired" };
        if (error instanceof joseErrors.JWSSignatureVerificationFailed && attempt === 0) {
          jwksUrl = null;
          jwks = null;
          continue;
        }
        return { kind: "invalid" };
      }
    }
    return { kind: "invalid" };
  }

  async function parseTokenResponse(response: Response) {
    const jsonBody = await response.json().catch(() => null);
    if (!jsonBody || typeof jsonBody !== "object" || Array.isArray(jsonBody)) return null;
    const tokens = jsonBody as Record<string, unknown>;
    if (
      typeof tokens.access_token !== "string" ||
      typeof tokens.refresh_token !== "string" ||
      typeof tokens.expires_in !== "number"
    ) {
      return null;
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    };
  }

  async function rotateRefreshToken(refreshToken: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const response = await fetch(`${env.AUTH_ISSUER_URL}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const parsed = await parseTokenResponse(response);
      if (!parsed) return null;
      return {
        access: parsed.accessToken,
        refresh: parsed.refreshToken,
        expiresIn: parsed.expiresIn,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function authenticate(request: Request, options?: { refresh?: boolean }): Promise<Session | null> {
    if (env.DEV_AUTH_EMAIL && isLocalRequest(request)) {
      return { email: normalizeEmail(env.DEV_AUTH_EMAIL) };
    }

    const accessToken = getCookie(request, "auth_access_token") ?? "";
    const refreshToken = getCookie(request, "auth_refresh_token") ?? "";
    if (!accessToken && !refreshToken) return null;

    const verified = accessToken ? await verifyAccessToken(accessToken, true) : { kind: "invalid" as const };
    if (verified.kind === "ok") return { email: verified.email };

    const shouldRefresh = options?.refresh ?? true;
    if (shouldRefresh && refreshToken) {
      const rotated = await rotateRefreshToken(refreshToken);
      if (!rotated) return null;
      const reverified = await verifyAccessToken(rotated.access, false);
      if (reverified.kind !== "ok") return null;
      return { email: reverified.email, tokens: rotated };
    }

    return null;
  }

  async function requireSession(request: Request, options?: { refresh?: boolean }): Promise<Session> {
    const session = await authenticate(request, options);
    if (!session) throw new Response("Unauthorized", { status: 401 });
    if (session.email !== normalizeEmail(env.OWNER_EMAIL)) {
      throw new Response("Forbidden", { status: 403 });
    }
    return session;
  }

  function withSessionCookies(response: Response, session: Session) {
    if (!session.tokens) return response;
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", envAccessCookie(session.tokens.access, session.tokens.expiresIn));
    headers.append("Set-Cookie", envRefreshCookie(session.tokens.refresh));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  async function loginRedirect(): Promise<Response> {
    const client = createClient({ clientID: env.AUTH_CLIENT_ID, issuer: env.AUTH_ISSUER_URL });
    const { url } = await client.authorize(`${env.APP_PUBLIC_URL}/api/auth/callback`, "code", {
      provider: "google",
    });
    return Response.redirect(url, 302);
  }

  async function handleCallback(request: Request): Promise<Response> {
    const code = new URL(request.url).searchParams.get("code");
    if (!code) return new Response("Missing code", { status: 400 });

    const response = await fetch(`${env.AUTH_ISSUER_URL}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        redirect_uri: `${env.APP_PUBLIC_URL}/api/auth/callback`,
        grant_type: "authorization_code",
        client_id: env.AUTH_CLIENT_ID,
        code_verifier: "",
      }),
    });
    if (!response.ok) {
      return new Response(`Authentication failed: ${await response.text()}`, {
        status: response.status,
      });
    }

    const tokens = await parseTokenResponse(response);
    if (!tokens) return new Response("Invalid token response", { status: 502 });

    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", envAccessCookie(tokens.accessToken, tokens.expiresIn));
    headers.append("Set-Cookie", envRefreshCookie(tokens.refreshToken));
    return new Response(null, { status: 302, headers });
  }

  function logout(): Response {
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", clearCookie("auth_access_token"));
    headers.append("Set-Cookie", clearCookie("auth_refresh_token"));
    return new Response(null, { status: 302, headers });
  }

  async function sessionEndpoint(request: Request): Promise<Response> {
    const session = await requireSession(request);
    const headers = new Headers({ "content-type": "application/json" });
    if (session.tokens) {
      headers.append("Set-Cookie", envAccessCookie(session.tokens.access, session.tokens.expiresIn));
      headers.append("Set-Cookie", envRefreshCookie(session.tokens.refresh));
    }
    return new Response(JSON.stringify({ user: { email: session.email } }), { headers });
  }

  return {
    authenticate,
    requireSession,
    withSessionCookies,
    loginRedirect,
    handleCallback,
    logout,
    sessionEndpoint,
  };
}
