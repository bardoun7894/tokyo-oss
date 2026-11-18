# ntfy for Control push (spec 012, Z0)

Nothing here is applied by the T0.2 commit. Run these steps only after the owner's yes (Z0).
Image: `binwiederhier/ntfy:v2.28.0` (released 2026-08-27, newest release at least two weeks old on 2026-10-17; newer: v2.29.0 to v2.31.1).

## Apply

1. `mkdir -p /srv/ntfy/{etc,cache,lib} && cp ops/ntfy/server.yml /srv/ntfy/etc/server.yml`
2. Port-80 site only: `sed '/# BEGIN-TLS/,/# END-TLS/d' ops/ntfy/nginx-ntfy.conf > /etc/nginx/sites-available/ntfy.conf && ln -s /etc/nginx/sites-available/ntfy.conf /etc/nginx/sites-enabled/ntfy.conf && nginx -t && systemctl reload nginx`
3. `docker compose -f ops/ntfy/compose.yml up -d`, then `timeout 120 certbot certonly --nginx -d ntfy.203-0-113-10.sslip.io --non-interactive --agree-tos`
4. Full site: `cp ops/ntfy/nginx-ntfy.conf /etc/nginx/sites-available/ntfy.conf && nginx -t && systemctl reload nginx`
5. Check: `curl -s https://ntfy.203-0-113-10.sslip.io/v1/health` returns `{"healthy":true}`; an anonymous publish and an anonymous subscribe both return 403.

## Users and ACL (deny-all, nothing printed to logs)

Run inside the container with fixed argv (no shell interpolation of secrets into history; use `NTFY_PASSWORD` from a file read):

- Publisher: `docker exec -e NTFY_PASSWORD="$(cat <pw-file>)" ntfy ntfy user add tokyo-pub`, then `docker exec ntfy ntfy access tokyo-pub 'up*' write-only`, then `docker exec ntfy ntfy token add tokyo-pub`. Write `{baseUrl, publishToken}` to `/etc/tokyo/ntfy.json` (root, 0600).
- Per device: `ntfy user add dev-<deviceId>`, no access is granted until `scripts/ntfy-device.ts bind <deviceId>` gives read-only on that device's exact topic. `ntfy token add dev-<deviceId>` gives the device token.

## Rollback

1. `docker compose -f ops/ntfy/compose.yml down` (data stays in `/srv/ntfy`; delete it to drop users and cache)
2. `rm /etc/nginx/sites-enabled/ntfy.conf /etc/nginx/sites-available/ntfy.conf`
3. `nginx -t && systemctl reload nginx`
4. Optional: `certbot delete --cert-name ntfy.203-0-113-10.sslip.io`
