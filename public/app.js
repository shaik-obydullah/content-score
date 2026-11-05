const form = document.getElementById('score-form');
const urlInput = document.getElementById('url');
const submitBtn = document.getElementById('submit-btn');
const errorBox = document.getElementById('error');
const loading = document.getElementById('loading');
const results = document.getElementById('results');

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 60;

const qs = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function scoreClass(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'mid';
  return 'bad';
}

function scoreColor(score) {
  if (score >= 80) return '#22c55e';
  if (score >= 60) return '#f59e0b';
  return '#ef4444';
}

function verdictFor(score) {
  if (score >= 90) return 'Excellent content';
  if (score >= 80) return 'Strong page';
  if (score >= 70) return 'Decent, with room to improve';
  if (score >= 60) return 'Needs work';
  return 'Weak content';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setLoading(isLoading) {
  loading.hidden = !isLoading;
  submitBtn.disabled = isLoading;
  submitBtn.classList.toggle('is-loading', isLoading);
  submitBtn.querySelector('.btn-label').textContent = isLoading ? 'Analyzing…' : 'Analyze page';
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function animateNumber(node, target) {
  const start = performance.now();
  const duration = 850;
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = Math.round(target * eased);
    if (progress < 1) requestAnimationFrame(tick);
    else node.textContent = Math.round(target);
  }
  requestAnimationFrame(tick);
}

function renderCategories(categories) {
  const container = qs('#categories');
  container.replaceChildren();

  for (const category of categories) {
    const row = el('div', 'cat-row');

    const label = el('div', 'cat-label');
    label.append(el('span', null, category.label));
    label.append(el('small', null, category.summary));

    const bar = el('div', 'bar');
    const fill = el('span', scoreClass(category.score));
    bar.append(fill);

    const value = el('div', 'cat-score', `${Math.round(category.score)}`);
    value.title = `${Math.round(category.weight * 100)}% of the overall score`;

    row.append(label, bar, value);
    container.append(row);

    requestAnimationFrame(() => {
      fill.style.width = `${category.score}%`;
    });
  }
}

function statCard(term, value, unit) {
  const card = el('dl', 'stat');
  card.append(el('dt', null, term));
  const dd = el('dd', null, value);
  if (unit) dd.append(el('small', null, ` ${unit}`));
  card.append(dd);
  return card;
}

function renderStats(data) {
  const box = qs('#stats');
  box.replaceChildren();

  const m = data.metrics;
  box.append(
    statCard('Words', m.wordCount.toLocaleString()),
    statCard('Read time', m.readingTimeMin, 'min'),
    statCard(
      'Readability',
      m.fleschReadingEase === null ? 'n/a' : m.fleschReadingEase,
      m.fleschReadingEase === null ? '' : 'Flesch',
    ),
    statCard('Headings', m.headingCount, `${m.headingCount === 1 ? 'tag' : 'tags'}`),
    statCard(
      'Images',
      m.images,
      m.images ? `${m.altCoverage}% alt` : 'none',
    ),
    statCard('Links', m.internalLinks + m.externalLinks, `${m.internalLinks} internal`),
  );
}

function renderKeywords(keywords) {
  const box = qs('#keywords');
  box.replaceChildren();
  if (!keywords.length) {
    box.append(el('p', 'empty-note', 'Not enough repeated text to detect a main topic.'));
    return;
  }
  for (const k of keywords) {
    const chip = el('span', 'keyword');
    chip.append(el('b', null, k.word));
    chip.append(el('span', null, `${k.count}× · ${k.density}%`));
    box.append(chip);
  }
}

function renderRecommendations(recommendations) {
  const list = qs('#recommendations');
  list.replaceChildren();

  for (const rec of recommendations) {
    const item = el('li', rec.severity);
    const body = el('div');
    body.append(el('strong', null, rec.title));
    body.append(el('p', null, rec.detail));
    item.append(body);
    list.append(item);
  }
}

function renderSeo(seo) {
  const list = qs('#seo-list');
  list.replaceChildren();

  const rows = [
    ['Title', seo.title || '—'],
    ['Title length', `${seo.titleLength} characters`],
    ['Meta description', seo.description || '—'],
    ['Description length', seo.description ? `${seo.descriptionLength} characters` : '—'],
    ['Canonical', seo.canonical || '—'],
    ['Language', seo.lang || '—'],
    ['Viewport', seo.viewport || '—'],
    ['Robots', seo.robots || '—'],
    ['HTTPS', seo.https ? 'Yes' : 'No'],
    ['Open Graph tags', String(seo.ogTags)],
    ['Structured data', seo.structuredData ? 'Yes' : 'No'],
    ['Favicon', seo.favicon ? 'Yes' : 'No'],
  ];

  for (const [key, value] of rows) {
    list.append(el('dt', null, key));
    list.append(el('dd', null, value));
  }
}

function renderHeadings(headings) {
  const list = qs('#heading-list');
  list.replaceChildren();

  if (!headings.items.length) {
    list.append(el('li', null, 'No headings found on the page.'));
    return;
  }

  for (const h of headings.items) {
    const item = el('li', null, h.text || '(empty heading)');
    item.style.setProperty('--level', h.level);
    list.append(item);
  }
}

function renderResults(data) {
  const score = Math.round(data.score);

  // Gauge
  const gauge = qs('#gauge-value');
  gauge.style.stroke = scoreColor(score);
  gauge.style.filter = `drop-shadow(0 0 8px ${scoreColor(score)}66)`;
  gauge.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE);
  requestAnimationFrame(() => {
    gauge.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - score / 100));
  });
  animateNumber(qs('#score-number'), data.score);

  // Verdict
  qs('#score-verdict').textContent = verdictFor(data.score);
  const grade = qs('#grade');
  grade.textContent = data.grade;
  grade.className = `grade ${scoreClass(data.score)}`;

  const url = qs('#final-url');
  url.textContent = data.fetch.finalUrl;
  url.href = data.fetch.finalUrl;

  const errorCount = data.recommendations.filter((r) => r.severity === 'error').length;
  const warnCount = data.recommendations.filter((r) => r.severity === 'warn').length;
  const weakest = [...data.categories].sort((a, b) => a.score - b.score).slice(0, 2);
  const weakestText = weakest.map((c) => `${c.label.toLowerCase()} (${Math.round(c.score)})`).join(' and ');
  qs('#score-blurb').textContent =
    errorCount + warnCount === 0
      ? 'No critical issues or warnings detected. Keep the content fresh and accurate.'
      : `${errorCount} critical issue${errorCount === 1 ? '' : 's'} and ${warnCount} warning${
          warnCount === 1 ? '' : 's'
        } found. Weakest areas: ${weakestText}.`;

  qs('#fetch-time').textContent = `Fetched in ${data.fetch.elapsedMs} ms`;
  qs('#fetch-size').textContent = `${formatBytes(data.fetch.htmlBytes)} HTML`;
  qs('#cache-badge').hidden = !data.cached;

  renderCategories(data.categories);
  renderStats(data);
  renderKeywords(data.keywords);
  renderRecommendations(data.recommendations);
  renderSeo(data.seo);
  renderHeadings(data.headings);
  qs('#preview').textContent = data.preview || 'No readable text found.';

  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function analyze(url) {
  if (!url.trim()) {
    showError('Enter a website URL first.');
    urlInput.focus();
    return;
  }

  showError('');
  results.hidden = true;
  setLoading(true);

  try {
    const response = await fetch(`/api/score?url=${encodeURIComponent(url.trim())}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
    }
    renderResults(payload);
    const next = new URL(window.location.href);
    next.searchParams.set('url', url.trim());
    window.history.replaceState({}, '', next);
  } catch (err) {
    showError(err.message || 'Could not analyze that page.');
  } finally {
    setLoading(false);
    loading.hidden = true;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  analyze(urlInput.value);
});

document.querySelectorAll('.example').forEach((button) => {
  button.addEventListener('click', () => {
    urlInput.value = button.dataset.url;
    analyze(button.dataset.url);
  });
});

// Support shareable URLs: /?url=https://example.com
const initial = new URL(window.location.href).searchParams.get('url');
if (initial) {
  urlInput.value = initial;
  analyze(initial);
}
