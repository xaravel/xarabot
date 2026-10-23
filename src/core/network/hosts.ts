import { err, ok, type Result } from "../result.ts";

/**
 * Host facts for the sandbox proxy allowlist (FR18, AR40, AD-17). Pure. A
 * session never reaches GitHub by any route, so a GitHub host or an IP
 * literal is refused wherever it comes from; every reading here fails closed.
 */

/** GitHub's own domains: the host equals one, or ends in `.` plus one. */
export const GITHUB_DOMAINS: readonly string[] = [
  "github.com",
  "githubusercontent.com",
  "githubassets.com",
  "github.io",
  "githubapp.com",
  "github.dev",
  "githubcopilot.com",
  "ghcr.io",
  "ghe.com",
  "gh.io",
  "git.io",
];

/** The package hosts every session may reach. */
export const PACKAGE_HOSTS: readonly string[] = ["pypi.org", "files.pythonhosted.org"];

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A normalized hostname: lower-case labels joined by dots, at most 253 characters. */
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/** Lower-cases a host and strips one trailing dot. */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** True for one of `GITHUB_DOMAINS` or a subdomain of one, and for any host with a label containing `github`. */
export function isGitHubHost(host: string): boolean {
  const h = normalizeHost(host);
  if (GITHUB_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  return h.split(".").some((label) => label.includes("github"));
}

/**
 * True for a dotted IPv4 address, anything holding a `:` (IPv6), and a host
 * whose last label is all digits. A last label in hex (`0x…`), which some
 * resolvers read as a number, counts too.
 */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHost(host);
  if (h.includes(":")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  const last = h.slice(h.lastIndexOf(".") + 1);
  return /^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
}

/** True for `localhost` and any `*.localhost`. */
export function isLocalhost(host: string): boolean {
  const h = normalizeHost(host);
  return h === "localhost" || h.endsWith(".localhost");
}

/** True when the normalized host is a plain DNS hostname. */
export function isHostname(host: string): boolean {
  return HOSTNAME.test(normalizeHost(host));
}

/** Why a host may never be on an allowlist, or `null` when it may. */
export function refuseHost(host: string): string | null {
  const shown = JSON.stringify(host);
  const ip = `${shown} is an IP literal; only hostnames are allowed`;
  if (!isHostname(host)) return /^[[\]0-9a-f:.%]*:[[\]0-9a-f:.%]*$/i.test(host) ? ip : `${shown} is not a hostname`;
  if (isIpLiteral(host)) return ip;
  if (isGitHubHost(host)) return `${shown} is a GitHub host; a GitHub host is never allowed`;
  if (isLocalhost(host)) return `${shown} is localhost; it is never allowed`;
  return null;
}

/**
 * The proxy's allowlist: the vendor's API hosts, `PACKAGE_HOSTS` and the
 * repo's `proxy_hosts`, normalized and deduplicated. Refuses (`invalid`, with
 * the host named) a GitHub host, an IP literal, `localhost` and anything that
 * isn't a hostname.
 */
export function buildAllowlist(vendorHosts: readonly string[], repoHosts: readonly string[]): Result<readonly string[]> {
  const out: string[] = [];
  for (const host of [...vendorHosts, ...PACKAGE_HOSTS, ...repoHosts]) {
    const why = refuseHost(host);
    if (why !== null) return err("invalid", `proxy allowlist: ${why}`);
    const h = normalizeHost(host);
    if (!out.includes(h)) out.push(h);
  }
  return ok(out);
}
