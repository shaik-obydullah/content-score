import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHtml, HttpError, normalizeUrl } from './lib/fetcher.js';
import { analyzePage } from './lib/analyze.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const cache = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

async function scoreUrl(input) {
  const normalized = normalizeUrl(input);
  const key = normalized.toString();
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const page = await fetchHtml(key);
  const result = analyzePage(page.html, page.finalUrl);
  result.fetch = {
    finalUrl: page.finalUrl,
    status: page.status,
    elapsedMs: page.elapsedMs,
    htmlBytes: Buffer.byteLength(page.html, 'utf8'),
  };
  result.cached = false;
  cacheSet(key, result);
  return result;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/api/score', async (req, res, next) => {
  try {
    if (!req.query.url) throw new HttpError(400, 'Add a ?url= parameter, e.g. /api/score?url=https://example.com');
    res.json(await scoreUrl(req.query.url));
  } catch (err) {
    next(err);
  }
});

app.post('/api/score', async (req, res, next) => {
  try {
    const url = req.body?.url;
    if (!url) throw new HttpError(400, 'Send JSON like { "url": "https://example.com" }.');
    res.json(await scoreUrl(url));
  } catch (err) {
    next(err);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`Content Score running at http://localhost:${PORT}`);
});
