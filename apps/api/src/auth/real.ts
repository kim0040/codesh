import { Client } from "ldapts";
import * as oidc from "openid-client";
import {
  escapeLdapFilter,
  type LdapAdapter,
  type OidcAdapter,
  type VerifiedIdentity,
} from "./adapters.js";

async function discover(config: Parameters<OidcAdapter["authorizationUrl"]>[0]) {
  return oidc.discovery(
    new URL(config.issuer),
    config.clientId,
    config.clientSecret,
    undefined,
    config.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
}

export const oidcAdapter: OidcAdapter = {
  async authorizationUrl(config, { redirectUri, state, nonce, codeVerifier }) {
    const server = await discover(config);
    return oidc.buildAuthorizationUrl(server, {
      redirect_uri: redirectUri,
      scope: config.scopes,
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    });
  },
  async exchange(config, { currentUrl, state, nonce, codeVerifier }) {
    const server = await discover(config);
    const tokens = await oidc.authorizationCodeGrant(server, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("no ID token");
    const name = claims.name ?? claims.preferred_username;
    return {
      provider: "oidc",
      subject: claims.sub,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    };
  },
};

export const ldapAdapter: LdapAdapter = {
  async authenticate(config, username, password) {
    // An empty password makes many servers treat the bind as anonymous and succeed.
    if (!username || !password) return null;
    const tls = { rejectUnauthorized: config.tlsRejectUnauthorized };
    const search = new Client({ url: config.url, tlsOptions: tls });
    try {
      if (config.startTls) await search.startTLS(tls);
      if (config.bindDn) await search.bind(config.bindDn, config.bindPassword ?? "");
      const filter = config.userFilter.replace("{{username}}", escapeLdapFilter(username));
      const { searchEntries } = await search.search(config.baseDn, {
        scope: "sub",
        filter,
        attributes: ["dn", config.nameAttribute, "mail", "uid"],
        sizeLimit: 2,
      });
      const entry = searchEntries[0];
      if (!entry || searchEntries.length !== 1) return null;
      const user = new Client({ url: config.url, tlsOptions: tls });
      try {
        if (config.startTls) await user.startTLS(tls);
        await user.bind(entry.dn, password);
      } catch {
        return null;
      } finally {
        await user.unbind().catch(() => undefined);
      }
      const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
      const name = first(entry[config.nameAttribute]);
      const mail = first(entry.mail);
      return {
        provider: "ldap",
        subject: entry.dn,
        ...(typeof name === "string" ? { name } : {}),
        ...(typeof mail === "string" ? { email: mail } : {}),
      } satisfies VerifiedIdentity;
    } finally {
      await search.unbind().catch(() => undefined);
    }
  },
};
