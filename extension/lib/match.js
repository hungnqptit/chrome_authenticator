// Decides which accounts belong to the site the user is on.
//
// Matching is deliberately strict so a look-alike domain (google-login.com,
// google.com.evil.io) never receives the code for a real account.

// Second-level labels that sit under a 2-letter ccTLD (com.vn, co.uk, ...).
const MULTI_SLD = new Set([
  'ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'or', 'ne', 'go', 'gob', 'mil',
  'int', 'nom', 'ltd', 'plc', 'info', 'biz', 'name', 'pro', 'health', 'id',
]);

// Issuers whose name differs from the domain they sign in on.
const ALIASES = {
  aws: ['amazon.com', 'amazonaws.com'],
  amazonwebservices: ['amazon.com', 'amazonaws.com'],
  microsoft: ['live.com', 'microsoft.com', 'microsoftonline.com'],
  microsoftaccount: ['live.com', 'microsoft.com'],
  meta: ['facebook.com', 'meta.com', 'instagram.com'],
  twitter: ['x.com', 'twitter.com'],
  x: ['x.com', 'twitter.com'],
  googleworkspace: ['google.com'],
  gmail: ['google.com'],
  cloudflare: ['cloudflare.com'],
  digitalocean: ['digitalocean.com'],
  gitlabcom: ['gitlab.com'],
  apple: ['apple.com', 'icloud.com'],
};

export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const tld = parts.at(-1);
  const sld = parts.at(-2);
  if (tld.length === 2 && MULTI_SLD.has(sld)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '');
  return /^[a-z0-9.-]+$/.test(d) && !d.startsWith('.') ? d : '';
}

// Subdomains where a company's own sign-in page usually lives. An issuer-name
// match ("MB Bank" ↔ mbbank.com.vn) is only trusted on these, so one company
// account doesn't show up on every internal app (jira., gitlab., confluence.).
const AUTH_SUBDOMAINS = new Set([
  'www', 'm', 'accounts', 'account', 'myaccount', 'login', 'signin', 'sso', 'auth',
  'id', 'secure', 'my', 'app', 'dash', 'dashboard', 'console',
]);

const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// Returns 'linked' (user tied this account to the site), 'issuer' (inferred
// from the issuer name) or null.
export function matchAccount(account, host) {
  const h = String(host || '').toLowerCase();
  if (!h) return null;
  if ((account.domains || []).some((d) => onDomain(h, d))) return 'linked';

  // Issuer written as a host, e.g. self-hosted GitLab uses "gitlab.example.com":
  // match that host and its subdomains only, not the rest of example.com.
  const issuerDomain = normalizeDomain(account.issuer).replace(/^www\./, '');
  if (issuerDomain.includes('.')) return onDomain(h, issuerDomain) ? 'issuer' : null;

  const issuer = normalizeName(account.issuer);
  if (!issuer) return null;
  const reg = registrableDomain(h);
  if (ALIASES[issuer]?.includes(reg)) return 'issuer';
  if (subdomainLabels(h, reg).every((l) => AUTH_SUBDOMAINS.has(l)) && normalizeName(reg.split('.')[0]) === issuer) {
    return 'issuer';
  }
  return null;
}

function subdomainLabels(host, reg) {
  return host === reg ? [] : host.slice(0, -(reg.length + 1)).split('.');
}

// Weaker hint used only to offer a one-click "use for this site": the issuer
// names a label of the host ("Jira" ↔ jira.example.com). Too loose to show
// codes automatically — jira.evil.com would qualify too — so the user confirms.
export function suggestAccount(account, host) {
  const h = String(host || '').toLowerCase();
  if (!h || matchAccount(account, h)) return false;
  const issuer = normalizeName(account.issuer);
  if (issuer.length < 3) return false;
  const reg = registrableDomain(h);
  return [...subdomainLabels(h, reg), reg.split('.')[0]].some((l) => normalizeName(l) === issuer);
}
