import { z } from "zod";

/** Provider settings (`settings.auth.oidc` / `settings.auth.ldap`). Off while the setting is null. */

export const oidcConfigSchema = z.object({
  issuer: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.string().default("openid profile email"),
  /** Overrides `<PUBLIC_URL>/api/auth/oidc/callback`. */
  redirectUri: z.url().optional(),
  /** Identity providers on a private network often run on plain HTTP. */
  allowInsecure: z.boolean().default(false),
});
export type OidcConfig = z.infer<typeof oidcConfigSchema>;

export const ldapConfigSchema = z.object({
  url: z.string().regex(/^ldaps?:\/\//),
  bindDn: z.string().optional(),
  bindPassword: z.string().optional(),
  baseDn: z.string().min(1),
  /** `{{username}}` is replaced with the escaped login name. */
  userFilter: z.string().default("(uid={{username}})"),
  nameAttribute: z.string().default("cn"),
  startTls: z.boolean().default(false),
  tlsRejectUnauthorized: z.boolean().default(true),
});
export type LdapConfig = z.infer<typeof ldapConfigSchema>;

export interface VerifiedIdentity {
  provider: "oidc" | "ldap";
  subject: string;
  name?: string;
  email?: string;
}

export interface OidcAdapter {
  authorizationUrl(
    config: OidcConfig,
    params: { redirectUri: string; state: string; nonce: string; codeVerifier: string },
  ): Promise<URL>;
  exchange(
    config: OidcConfig,
    params: {
      redirectUri: string;
      currentUrl: URL;
      state: string;
      nonce: string;
      codeVerifier: string;
    },
  ): Promise<VerifiedIdentity>;
}

export interface LdapAdapter {
  authenticate(
    config: LdapConfig,
    username: string,
    password: string,
  ): Promise<VerifiedIdentity | null>;
}

/** RFC 4515 escaping of a value placed inside a search filter. */
export function escapeLdapFilter(value: string): string {
  let escaped = "";
  for (const char of value) {
    escaped += "\\*()\0".includes(char)
      ? `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`
      : char;
  }
  return escaped;
}
