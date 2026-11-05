import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === '1';

const PRIVATE_V4 = [
  [/^10\./, '10.0.0.0/8'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'],
  [/^192\.168\./, '192.168.0.0/16'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16.0.0/12'],
  [/^0\./, '0.0.0.0/8'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'carrier-grade NAT'],
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    return PRIVATE_V4.some(([re]) => re.test(ip));
  }
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 link-local
    // IPv4-mapped: ::ffff:127.0.0.1
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

async function assertPublicUrl(url) {
  if (ALLOW_PRIVATE) return;
  const host = url.hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new HttpError(400, 'Refusing to fetch a local/private address.');
  }

  // Literal IP address
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new HttpError(400, 'Refusing to fetch a local/private address.');
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new HttpError(400, `Could not resolve host: ${host}`);
  }

  if (!addresses.length) throw new HttpError(400, `Could not resolve host: ${host}`);
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new HttpError(400, 'Refusing to fetch a host that resolves to a private address.');
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new HttpError(400, 'Enter a website URL.');
  }
  let raw = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'That does not look like a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Only http:// and https:// URLs are supported.');
  }
  url.hash = '';
  return url;
}

function charsetFromContentType(contentType = '') {
  const match = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return match ? match[1].toLowerCase() : 'utf-8';
}

async function readBody(res, maxBytes = MAX_BYTES) {  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new HttpError(413, 'The page is too large to analyze (over 5 MB).');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const charset = charsetFromContentType(res.headers.get('content-type') || '');
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Fetch a page with redirect handling, a size limit, timeouts and basic SSRF protection.
 */
export async function fetchHtml(input) {
  const started = Date.now();
  let current = normalizeUrl(input);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent':
            'ContentScoreBot/1.0 (+local tool; like a browser) AppleWebKit/537.36 Chrome/122 Safari/537.36',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw new HttpError(504, 'The website took too long to respond (20s timeout).');
      }
      throw new HttpError(502, `Could not reach the website: ${err.message}`);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      clearTimeout(timer);
      const location = res.headers.get('location');
      if (!location) {
        throw new HttpError(502, `The website returned a ${res.status} redirect without a location.`);
      }
      current = new URL(location, current);
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new HttpError(400, 'Redirected to an unsupported protocol.');
      }
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      clearTimeout(timer);
      throw new HttpError(
        415,
        `That URL is not an HTML page (content-type: ${contentType || 'unknown'}).`,
      );
    }

    if (!res.ok) {
      clearTimeout(timer);
      throw new HttpError(502, `The website returned HTTP ${res.status} ${res.statusText || ''}`.trim());
    }

    let html;
    try {
      html = await readBody(res);
    } finally {
      clearTimeout(timer);
    }

    return {
      html,
      finalUrl: current.toString(),
      status: res.status,
      contentType,
      elapsedMs: Date.now() - started,
    };
  }

  throw new HttpError(508, 'Too many redirects (more than 5).');
}
