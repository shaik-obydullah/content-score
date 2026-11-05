# ContentScore

A local web app that scores the content quality of any web page. Paste a URL and get:

- an overall **0–100 score** with a letter grade
- a weighted breakdown across **7 categories**
- concrete **fixes** ordered by impact
- supporting stats: word count, reading time, Flesch readability, headings, links, images
- top terms with frequency and keyword density
- SEO/meta details and a heading outline

No API keys, no third-party services. The server fetches the page directly and analyzes it locally.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>. For auto-reload during development:

```bash
npm run dev
```

Requires Node.js 18+ (tested on Node 20).

## How the score works

| Category | Weight | What it measures |
| --- | --- | --- |
| Content depth | 20% | Word count, with bands from thin content to 1,500+ words |
| Readability | 20% | Flesch Reading Ease, rewarding the 60–70 range |
| Structure | 15% | A single H1, heading density, hierarchy, descriptive headings |
| Topic focus | 15% | Main term in the title, meta description, H1, intro, and healthy density |
| SEO basics | 15% | Title, meta description, canonical, language, viewport, HTTPS |
| Media & links | 10% | Image alt coverage, internal links, external links |
| Technical | 5% | HTTPS, structured data, Open Graph tags, favicon |

Grades: **A** ≥ 90, **B** ≥ 80, **C** ≥ 70, **D** ≥ 60, **F** below 60.

The exact category weights live in `lib/analyze.js` (`categories` array). Scores are combined with a weighted sum, so keep the weights totalling 1.0 to keep the overall result on a 0–100 scale.

## JSON API

The web UI is a thin client over the same API.

```bash
curl "http://localhost:3000/api/score?url=https://example.com"
```

Or POST:

```bash
curl -X POST http://localhost:3000/api/score \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

Example (abridged) response:

```json
{
  "url": "https://example.com/",
  "score": 30.2,
  "grade": "F",
  "categories": [
    { "key": "depth", "label": "Content depth", "score": 4.2, "weight": 0.2, "summary": "25 words, ~1 min read" }
  ],
  "metrics": {
    "wordCount": 25,
    "sentenceCount": 2,
    "fleschReadingEase": 41.9,
    "readingLabel": "Difficult",
    "internalLinks": 0,
    "images": 0,
    "altCoverage": null
  },
  "seo": { "title": "Example Domain", "titleLength": 14, "https": true },
  "headings": { "counts": { "h1": 0 }, "items": [] },
  "keywords": [],
  "recommendations": [
    { "severity": "error", "title": "Thin content", "detail": "Only 25 words were found..." }
  ]
}
```

Health check: `GET /api/health`.

Results are cached in memory for 5 minutes per requested URL (max 100 entries).

## Project structure

```
server.js          Express server, routes, in-memory cache
lib/fetcher.js     HTTP fetching: redirects, timeout, size limit, SSRF guard
lib/analyze.js     HTML extraction, metrics, scoring and recommendations
public/            Static frontend (no build step)
```

## Security notes

- Only `http://` and `https://` URLs are accepted.
- Redirects are followed manually (max 5) and re-validated at every hop.
- Private, loopback, link-local and unique-local addresses are blocked to reduce SSRF risk.
- Responses are capped at 5 MB and requests time out after 20 seconds.
- Page text is rendered with `textContent`, so scraped content cannot inject HTML/JS into the UI.

To analyze a site on your own machine, start the server with:

```bash
ALLOW_PRIVATE_HOSTS=1 npm start
```

Then `http://localhost:3000` and other private addresses become fetchable.

## Limitations

- The score is a **heuristic checklist**, not an official search-engine ranking factor.
- Readability uses English syllable heuristics, so Flesch scores are only meaningful for English text.
- JavaScript-rendered content is not executed — only the server-returned HTML is analyzed.
- Keyword focus uses the most frequent non-stopword term; it is a rough proxy, not semantic analysis.
- Login-protected pages, bot-blocked pages, and non-HTML files cannot be analyzed.

## Deploying

It is a standard Node/Express app:

```bash
PORT=8080 npm start
```

Ensure the host allows outbound HTTP(S) requests. There is no database and no external configuration.
