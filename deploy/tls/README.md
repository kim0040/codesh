Drop Caddy snippets here (`*.caddy`); `deploy/caddy/Caddyfile` imports them inside the site block.

HTTPS with your own certificate (set `SITE_ADDRESS=codesh.corp` in `.env`):

    # tls.caddy
    tls /etc/caddy/tls/codesh.crt /etc/caddy/tls/codesh.key

HTTPS with Caddy's own CA (browsers must trust its root, `caddy-data` volume `pki/authorities/local/root.crt`):

    # tls.caddy
    tls internal
