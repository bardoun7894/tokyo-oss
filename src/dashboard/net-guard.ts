/**
 * Network gate for the dashboard.
 *
 * The dashboard hands out task, finance, shop and WhatsApp data, and its API can
 * send WhatsApp messages and rewrite .env. Until now it bound 0.0.0.0 on a VPS
 * with no firewall (ufw inactive, iptables INPUT policy ACCEPT), so
 * http://203.0.113.10:3030 answered the whole internet -- including
 * POST /api/auth/login, against an 8-character password, with no attempt limit.
 *
 * Two layers, because either one alone has a hole:
 *
 *  - **Bind.** The listeners come up on loopback and the tailnet address only,
 *    so a packet from the public interface is refused by the kernel and never
 *    reaches Node. This is the layer that does the real work.
 *  - **Gate.** If the tailnet address is missing at boot the bind falls back to
 *    0.0.0.0 rather than leaving the dashboard unreachable, and a future edit
 *    could widen the bind again. The gate makes either case fail closed.
 *
 * Ported from godhome's src/server/auth.ts, which already had this right.
 */

/** IPv4 peers arrive as ::ffff:a.b.c.d whenever the socket is dual-stack. */
function toV4(addr: string): number | undefined {
  const plain = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  const parts = plain.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const b = Number(p);
    if (b > 255) return undefined;
    n = n * 256 + b;
  }
  return n >>> 0;
}

function inCidr(addr: number, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  const base = toV4(net ?? "");
  if (base === undefined) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true; // a /0 shift is a no-op in JS, so it cannot go through the mask
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
}

/** The tailnet, and nothing else. Overridable for a future LAN, comma-separated. */
export function trustedNetworks(): string[] {
  const raw = process.env.DASHBOARD_TRUSTED_NETWORKS;
  if (raw) {
    const list = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return ["100.64.0.0/10"];
}

export function isTrustedAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === "::1" || addr === "::ffff:127.0.0.1") return true;
  const v4 = toV4(addr);
  // A non-loopback IPv6 peer cannot be matched against IPv4 CIDRs. Deny rather
  // than guess: an access decision made on an address we could not parse is not
  // an access decision.
  if (v4 === undefined) return false;
  if (inCidr(v4, "127.0.0.0/8")) return true;
  return trustedNetworks().some(c => inCidr(v4, c));
}
