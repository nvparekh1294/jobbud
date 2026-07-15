// SSRF guard for server-side fetches of user-supplied URLs.
//
// Endpoints that fetch an arbitrary URL on the server (api/add-job.js scrape,
// api/radar-fetch-company.js) must not be tricked into reaching internal
// infrastructure — loopback, private ranges, link-local, or the cloud metadata
// endpoint (169.254.169.254). assertPublicHttpUrl() enforces http(s) + a public
// host, resolving DNS so a public hostname can't point at an internal address.
//
// Residual limitation: a public URL that 302-redirects to an internal address is
// not re-checked here (fetch follows redirects itself). Callers that need that
// hardened should fetch with redirect:'manual' and re-validate each hop.

import net from 'node:net';
import dns from 'node:dns/promises';

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                            // 0.0.0.0/8 "this host"
  if (a === 10) return true;                           // 10.0.0.0/8 private
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 private
  if (a === 192 && b === 0) return true;               // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true;                           // 224/4 multicast + 240/4 reserved
  return false;
}

function isPrivateIPv6(ip) {
  let a = ip.toLowerCase();
  const pct = a.indexOf('%');
  if (pct !== -1) a = a.slice(0, pct);                 // strip zone id
  if (a === '::1' || a === '::') return true;          // loopback / unspecified
  if (/^fe[89ab]/.test(a)) return true;                // fe80::/10 link-local
  if (/^f[cd]/.test(a)) return true;                   // fc00::/7 unique-local
  const m = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // IPv4-mapped
  if (m) return isPrivateIPv4(m[1]);
  return false;
}

// True if an IP literal is loopback/private/link-local/reserved. A non-IP string
// is treated as private (fail closed).
export function isPrivateIp(ip) {
  const s = String(ip || '');
  const kind = net.isIP(s);
  if (kind === 4) return isPrivateIPv4(s);
  if (kind === 6) return isPrivateIPv6(s);
  return true;
}

// True if a hostname should never be fetched server-side (special names or an IP
// literal that resolves to a non-public address).
export function isBlockedHostname(hostname) {
  let h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // [::1] -> ::1
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (h === 'metadata.google.internal') return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return false;
}

// Validate a user-supplied URL before fetching it. Throws on anything that isn't
// a public http(s) URL. Returns the parsed URL on success.
export async function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); }
  catch { throw new Error('Invalid URL'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }
  if (isBlockedHostname(u.hostname)) {
    throw new Error('URL host is not allowed');
  }

  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(hostname)) {
    // Public hostname: resolve and confirm no record points at an internal IP.
    let addrs;
    try { addrs = await dns.lookup(hostname, { all: true }); }
    catch { throw new Error('Could not resolve URL host'); }
    if (!addrs.length) throw new Error('URL host did not resolve');
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new Error('URL host resolves to a non-public address');
    }
  }
  return u;
}
