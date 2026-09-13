import { promises as dns } from 'node:dns';

export const PRIVATE_IP_RANGES = [
  /^0\.\d+\.\d+\.\d+$/,                       // 0.0.0.0/8 (this-network)
  /^10\.\d+\.\d+\.\d+$/,                      // 10.0.0.0/8 (private)
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d+\.\d+$/, // 100.64.0.0/10 (CGNAT)
  /^127\.\d+\.\d+\.\d+$/,                     // 127.0.0.0/8 (loopback)
  /^169\.254\.\d+\.\d+$/,                     // 169.254.0.0/16 (link-local + cloud metadata)
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,      // 172.16.0.0/12 (private)
  /^192\.0\.0\.\d+$/,                         // 192.0.0.0/24 (IETF protocol assignments)
  /^192\.168\.\d+\.\d+$/,                     // 192.168.0.0/16 (private)
  /^198\.(1[8-9])\.\d+\.\d+$/,               // 198.18.0.0/15 (benchmark)
  /^::1$/,                                     // IPv6 loopback
  /^::$/,                                      // IPv6 unspecified
  /^fe[89ab][0-9a-f]:/i,                      // IPv6 link-local (fe80::/10)
  /^f[cd][0-9a-f]{2}:/i,                      // IPv6 unique-local (fc00::/7, covers fc00::-fdff::)
  /^fe[c-f][0-9a-f]:/i,                       // IPv6 site-local, deprecated (fec0::/10)
];

export const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google.internal.',
  'metadata.azure.com',
  'metadata.azure.com.',
  'metadata.tencentyun.com',
  'metadata.tencentyun.com.',
]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.',
]);

export const INTERNAL_DNS_SUFFIXES = [
  '.local',
  '.local.',
  '.internal',
  '.internal.',
  '.svc',
  '.svc.',
  '.svc.cluster.local',
  '.svc.cluster.local.',
  '.kubernetes.local',
];

export type LookupAll = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

const IPV4_MAPPED_DOTTED = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/;
const IPV4_MAPPED_HEX = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * Canonicalize an IP literal for range checks: strips IPv6 brackets and zone
 * ids, lowercases, and rewrites IPv4-mapped IPv6 (`::ffff:7f00:1` and the
 * expanded `0:0:0:0:0:ffff:7f00:1`) to dotted-decimal IPv4. The hex-pair form
 * is the normalized shape Node's URL parser emits, so range checks must
 * understand it or `http://[::ffff:127.0.0.1]/` bypasses every v4 rule.
 */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  const dotted = IPV4_MAPPED_DOTTED.exec(ip);
  if (dotted) return dotted[1]!;

  const hex = IPV4_MAPPED_HEX.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return ip;
}

export function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  return PRIVATE_IP_RANGES.some((re) => re.test(ip));
}

export function isMetadataHostname(hostname: string): boolean {
  return METADATA_HOSTNAMES.has(hostname.toLowerCase());
}

export function isInternalDnsSuffix(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  for (const suffix of INTERNAL_DNS_SUFFIXES) {
    if (lower === suffix.slice(0, -1) || lower.endsWith(suffix)) return true;
  }
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(lower) || isMetadataHostname(lower) || isInternalDnsSuffix(lower) || isPrivateIp(lower);
}

/**
 * Resolve `hostname` via DNS and require every answer to be public. Rejecting
 * mixed public/private answers closes DNS-rebinding SSRF (an attacker DNS can
 * return a public IP to a pre-flight check and a private IP to the fetch).
 *
 * @returns the first resolved address (safe to pin a fetch to), or throws.
 */
export async function resolvePublicHost(hostname: string, lookup?: LookupAll): Promise<string> {
  const resolver: LookupAll = lookup ?? ((host, options) => dns.lookup(host, options));
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(normalizeIp(hostname), { all: true });
  } catch (e) {
    throw new Error(`DNS resolution failed for ${hostname}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (addresses.length === 0) {
    throw new Error(`No DNS records for ${hostname}`);
  }
  const blocked = addresses.filter((a) => isPrivateIp(a.address));
  if (blocked.length > 0) {
    throw new Error(
      `Host ${hostname} resolves to private/internal address(es) ` +
      `(${blocked.map((a) => a.address).join(', ')}). Blocked for SSRF protection.`,
    );
  }
  return addresses[0]!.address;
}
