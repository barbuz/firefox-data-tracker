// Domain parsing helpers. Pure functions, no browser APIs, so they can be
// unit-tested under Node.

// Common multi-label public suffixes. This is a pragmatic subset of the Public
// Suffix List, not the full list: enough to get eTLD+1 right for the vast
// majority of real traffic without shipping ~200 KB of data.
const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk",
  "gov.uk", "nhs.uk",
  // Australia
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au", "asn.au",
  // New Zealand
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "geek.nz", "school.nz",
  // Japan
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp",
  "lg.jp",
  // Brazil
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br",
  // China
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  // India
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "ac.in",
  "gov.in", "nic.in", "res.in", "edu.in",
  // South Africa
  "co.za", "net.za", "org.za", "gov.za", "ac.za", "web.za",
  // Ireland
  "co.ie", "gov.ie", "ac.ie",
  // Others
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw", "com.my",
  "com.ph", "com.vn", "com.pk", "com.sa", "com.eg", "com.ng", "com.co",
  "co.kr", "co.id", "co.th", "co.il", "co.ke", "co.cr", "co.ug", "co.tz",
  "org.il", "ac.il", "gov.il", "net.il",
  "gov.in", "gov.au", "gov.uk",
  "edu.sg", "edu.hk", "edu.tw", "edu.my",
]);

/**
 * Extract the hostname from a URL string, lower-cased. Returns "" if the URL
 * cannot be parsed or has no host (e.g. "about:blank", "data:...").
 */
export function hostOf(url) {
  if (!url) return "";
  try {
    const host = new URL(url).hostname;
    return host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Reduce a hostname to its registrable domain (eTLD+1) using the embedded
 * suffix list. Falls back to the last two labels, or the host itself when it
 * has fewer than two labels (e.g. "localhost").
 *
 * Note: returns the host unchanged for IP addresses.
 */
export function registrableDomain(host) {
  if (!host) return "";
  const clean = host.toLowerCase().replace(/\.$/, "");
  if (isIpAddress(clean)) return clean;
  const labels = clean.split(".").filter(Boolean);
  if (labels.length <= 2) return clean;

  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** Rough IPv4/IPv6 detection; enough to skip suffix logic for literal IPs. */
export function isIpAddress(host) {
  if (!host) return false;
  if (host.includes(":")) return true; // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Decide which "site" a request belongs to.
 *
 * A request's own URL is only the site when it *is* the document (top-level
 * navigation). For sub-resources, the document that caused the request is the
 * site. `documentUrl` is undefined for top-level documents (see MDN), so we
 * fall back to the request URL in that case.
 */
export function siteHostForRequest({ url, documentUrl, type }) {
  const docHost = hostOf(documentUrl);
  if (docHost) return docHost;
  if (type === "main_frame" || !documentUrl) return hostOf(url);
  return hostOf(url);
}

/** The serving host: whoever actually delivered the bytes. */
export function servingHostForRequest({ url }) {
  return hostOf(url);
}

/** Convenience: the registrable domain used as the storage key for a site. */
export function siteKeyForRequest(details) {
  return registrableDomain(siteHostForRequest(details));
}
