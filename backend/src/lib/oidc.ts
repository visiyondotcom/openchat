import { request } from "undici";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { decryptSecret } from "./crypto.js";

// Generic OpenID Connect client — works with any compliant provider
// (Microsoft/Azure AD, Google Workspace, Keycloak, Authentik, Auth0,
// Okta, ...). Supports MULTIPLE providers enabled at once (e.g.
// Microsoft AND Google both showing as "Continue with…" buttons), backed
// by two sources that get merged into one list:
//
//  - the ORIGINAL single-provider config living on the AppSettings
//    singleton row (ssoEnabled/ssoProviderName/ssoIssuerUrl/...) or the
//    OIDC_* env vars — kept exactly as before for backward compatibility.
//    Always addressed by the fixed key "legacy". Deployments that had
//    this configured before multi-provider support existed, with users
//    already linked via User.ssoProvider == that provider's display
//    name, keep working unchanged.
//  - any number of rows in the SsoProvider table (Admin > Settings >
//    Login > "Add provider"), each addressed by its own row id as the
//    key. New links for these are stored as User.ssoProvider == the row
//    id (NOT the display name) so renaming a provider, or two providers
//    sharing a display name, can never cause two different providers to
//    resolve to the same linked account.
//
// Every function below is keyed by that provider `key` (either "legacy"
// or a SsoProvider row id) so callers always know exactly which
// provider's login flow they're driving.

export type OidcProviderSummary = { key: string; providerName: string };

type OidcConfig = {
  key: string;
  providerName: string;
  issuerUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string;
  redirectUri: string | null;
};

// Cached in-memory for CACHE_TTL_MS; admin.ts calls
// invalidateSsoConfigCache() right after any save (legacy or per-provider)
// so a client secret rotation / a newly added or disabled provider takes
// effect immediately instead of waiting out the TTL.
const CACHE_TTL_MS = 30_000;
let cache: { value: OidcConfig[]; expiresAt: number } | null = null;

export function invalidateSsoConfigCache(): void {
  cache = null;
}

async function loadAllConfigs(prisma?: PrismaClient): Promise<OidcConfig[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const configs: OidcConfig[] = [];

  // ---- Legacy singleton config ("DB wins, falls back to env", same as
  // lib/billing.ts and lib/music.ts) ----
  let legacyRow: {
    ssoEnabled: boolean | null;
    ssoProviderName: string | null;
    ssoIssuerUrl: string | null;
    ssoClientId: string | null;
    ssoClientSecret: string | null;
    ssoScopes: string | null;
    ssoRedirectUri: string | null;
  } | null = null;
  if (prisma) {
    try {
      legacyRow = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          ssoEnabled: true,
          ssoProviderName: true,
          ssoIssuerUrl: true,
          ssoClientId: true,
          ssoClientSecret: true,
          ssoScopes: true,
          ssoRedirectUri: true,
        },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to env vars entirely rather than failing every auth call.
      legacyRow = null;
    }
  }
  const legacyIssuerUrl = legacyRow?.ssoIssuerUrl || process.env.OIDC_ISSUER_URL || null;
  const legacyClientId = legacyRow?.ssoClientId || process.env.OIDC_CLIENT_ID || null;
  const legacyClientSecret = legacyRow?.ssoClientSecret || process.env.OIDC_CLIENT_SECRET || null;
  // ssoEnabled is nullable: null means no explicit admin choice has been
  // made yet, so fall back to "credentials are present" — this is what
  // keeps a pre-existing env-var-only setup working right after
  // upgrading, before anyone has touched the admin panel toggle.
  const legacyEnabledFromDb = legacyRow?.ssoEnabled ?? Boolean(legacyIssuerUrl && legacyClientId && legacyClientSecret);
  const legacyEnabled = legacyEnabledFromDb && Boolean(legacyIssuerUrl && legacyClientId && legacyClientSecret);
  if (legacyEnabled) {
    configs.push({
      key: "legacy",
      providerName: legacyRow?.ssoProviderName || process.env.OIDC_PROVIDER_NAME || "SSO",
      issuerUrl: legacyIssuerUrl,
      clientId: legacyClientId,
      clientSecret: legacyClientSecret,
      scopes: legacyRow?.ssoScopes || process.env.OIDC_SCOPES || "openid email profile",
      redirectUri: legacyRow?.ssoRedirectUri || process.env.OIDC_REDIRECT_URI || null,
    });
  }

  // ---- Additional providers (SsoProvider table) ----
  if (prisma) {
    try {
      const rows = await prisma.ssoProvider.findMany({ where: { enabled: true } });
      for (const row of rows) {
        configs.push({
          key: row.id,
          providerName: row.providerName,
          issuerUrl: row.issuerUrl,
          clientId: row.clientId,
          clientSecret: decryptSecret(row.clientSecretEncrypted),
          scopes: row.scopes || "openid email profile",
          redirectUri: row.redirectUri || null,
        });
      }
    } catch {
      // Table not migrated yet on this deployment — legacy config (if
      // any) above still works fine on its own.
    }
  }

  cache = { value: configs, expiresAt: Date.now() + CACHE_TTL_MS };
  return configs;
}

// The full list of currently-enabled providers, for the login page to
// render one button per entry. Never includes secrets.
export async function listSsoProviders(prisma?: PrismaClient): Promise<OidcProviderSummary[]> {
  const configs = await loadAllConfigs(prisma);
  return configs.map((c) => ({ key: c.key, providerName: c.providerName }));
}

async function loadConfigByKey(prisma: PrismaClient | undefined, key: string): Promise<OidcConfig | null> {
  const configs = await loadAllConfigs(prisma);
  return configs.find((c) => c.key === key) || null;
}

// Falls back to building the callback URL from the current request's
// origin when neither the provider's own redirectUri nor OIDC_REDIRECT_URI
// (legacy only) is set.
export async function ssoRedirectUriFor(prisma: PrismaClient | undefined, key: string, fallback: string): Promise<string> {
  const config = await loadConfigByKey(prisma, key);
  return config?.redirectUri || fallback;
}

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

// The discovery document rarely changes — cache it in-process for an hour
// instead of fetching it on every login click. Keyed by issuer so a
// changed issuer URL (from the admin panel) doesn't keep serving a stale
// discovery doc for the old provider.
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();

async function discover(issuerUrl: string): Promise<Discovery> {
  const issuer = issuerUrl.replace(/\/$/, "");
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.doc;
  const res = await request(`${issuer}/.well-known/openid-configuration`);
  if (res.statusCode >= 400) throw new Error(`OIDC discovery failed: ${res.statusCode}`);
  const doc = (await res.body.json()) as Discovery;
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

export function generateState(): string {
  return randomBytes(24).toString("hex");
}

export async function buildAuthorizationUrl(
  prisma: PrismaClient | undefined,
  key: string,
  state: string,
  redirectUri: string
): Promise<string> {
  const config = await loadConfigByKey(prisma, key);
  if (!config || !config.issuerUrl || !config.clientId) throw new Error("SSO is not configured");
  const doc = await discover(config.issuerUrl);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  return url.toString();
}

export type SsoProfile = {
  sub: string;
  email: string;
  name?: string;
};

export async function exchangeCodeForProfile(
  prisma: PrismaClient | undefined,
  key: string,
  code: string,
  redirectUri: string
): Promise<SsoProfile> {
  const config = await loadConfigByKey(prisma, key);
  if (!config || !config.issuerUrl || !config.clientId || !config.clientSecret) {
    throw new Error("SSO is not configured");
  }
  const doc = await discover(config.issuerUrl);

  const tokenRes = await request(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });
  if (tokenRes.statusCode >= 400) {
    throw new Error(`OIDC token exchange failed: ${tokenRes.statusCode} ${await tokenRes.body.text()}`);
  }
  const tokenData = (await tokenRes.body.json()) as { access_token: string };

  const userRes = await request(doc.userinfo_endpoint, {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
  });
  if (userRes.statusCode >= 400) {
    throw new Error(`OIDC userinfo failed: ${userRes.statusCode}`);
  }
  const profile = (await userRes.body.json()) as { sub: string; email?: string; name?: string; preferred_username?: string };
  const email = profile.email || profile.preferred_username;
  if (!email) throw new Error("OIDC provider did not return an email or preferred_username claim");

  return { sub: profile.sub, email, name: profile.name || profile.preferred_username };
}
