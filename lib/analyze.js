import * as cheerio from 'cheerio';

const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also may might must much many make made just like get got one two three new now use used using via will can may per within without across among around based often however therefore thus etc retrieved archived accessed available citation cite references doi isbn issn pmid http https www original volume issue pages`
    .split(/\s+/)
    .filter(Boolean),
);

const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const round = (n, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

function tokenize(text) {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || [];
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;
  if (w.endsWith('e') && !w.endsWith('le') && !w.endsWith('ee')) count -= 1;
  return Math.max(1, count);
}

function readingLabel(fre) {
  if (fre === null) return 'Unknown';
  if (fre >= 90) return 'Very easy';
  if (fre >= 80) return 'Easy';
  if (fre >= 70) return 'Fairly easy';
  if (fre >= 60) return 'Plain English';
  if (fre >= 50) return 'Fairly difficult';
  if (fre >= 30) return 'Difficult';
  return 'Very difficult';
}

function containsTerm(haystack, term) {
  if (!haystack || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(haystack);
}

export function analyzePage(html, finalUrl) {
  const $ = cheerio.load(html);

  // --- Page-level / head data (gather before stripping scripts) ---
  const title = clean($('head title').first().text());
  const description = clean($('meta[name="description"]').attr('content') || '');
  const canonical = clean($('link[rel="canonical"]').attr('href') || '');
  const lang = clean($('html').attr('lang') || '');
  const viewport = clean($('meta[name="viewport"]').attr('content') || '');
  const robots = clean($('meta[name="robots"]').attr('content') || '');
  const ogTags = $('meta[property^="og:"]').length;
  const jsonLd = $('script[type="application/ld+json"]').length;
  const microdata = $('[itemtype]').length;
  const hasStructuredData = jsonLd > 0 || microdata > 0;
  const hasFavicon = $('link[rel~="icon"]').length > 0;
  const https = new URL(finalUrl).protocol === 'https:';

  // --- Content scope: drop chrome and non-content elements ---
  const $c = cheerio.load(html);
  $c('script, style, noscript, svg, template, iframe, nav, footer, aside, form, button').remove();

  const article = $c('article').first();
  const main = $c('main').first();
  const contentRoot = article.length ? article : main.length ? main : $c('body');

  const text = clean(contentRoot.text());
  const tokens = tokenize(text);
  const wordCount = tokens.length;

  const rawSentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => tokenize(s))
    .filter((t) => t.length >= 2);
  const sentenceCount = rawSentences.length;

  const paragraphs = contentRoot.find('p').length;
  const readingTimeMin = wordCount ? Math.max(1, Math.ceil(wordCount / 200)) : 0;

  const syllables = tokens.reduce((sum, t) => sum + countSyllables(t), 0);
  const wordsPerSentence = sentenceCount ? wordCount / sentenceCount : 0;
  const syllablesPerWord = wordCount ? syllables / wordCount : 0;
  const fleschReadingEase =
    wordCount && sentenceCount
      ? round(206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord)
      : null;
  const fleschKincaidGrade =
    wordCount && sentenceCount
      ? round(0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59)
      : null;

  // --- Headings ---
  const headingEls = $c('h1, h2, h3, h4, h5, h6').toArray();
  const headings = headingEls.slice(0, 60).map((el) => ({
    level: Number(el.tagName.slice(1)),
    text: clean($c(el).text()).slice(0, 140),
  }));
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  for (const h of headings) headingCounts[`h${h.level}`] += 1;

  let skippedLevels = 0;
  let previousLevel = null;
  for (const h of headings) {
    if (previousLevel && h.level > previousLevel + 1) skippedLevels += 1;
    previousLevel = h.level;
  }
  const meaningfulHeadings = headings.filter((h) => tokenize(h.text).length >= 2).length;

  // --- Links ---
  let base;
  try {
    base = new URL(finalUrl);
  } catch {
    base = null;
  }
  const internalLinks = new Set();
  const externalLinks = new Set();
  let nofollowLinks = 0;
  $c('a[href]').each((_, el) => {
    const href = ($c(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    if (($c(el).attr('rel') || '').toLowerCase().includes('nofollow')) nofollowLinks += 1;
    let resolved;
    try {
      resolved = new URL(href, base || finalUrl);
    } catch {
      return;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;
    resolved.hash = '';
    if (base && resolved.hostname === base.hostname) internalLinks.add(resolved.toString());
    else externalLinks.add(resolved.toString());
  });

  // --- Images ---
  const imageEls = $c('img').toArray();
  const imagesTotal = imageEls.length;
  const imagesWithAlt = imageEls.filter((el) => clean($c(el).attr('alt') || '')).length;
  const altCoverage = imagesTotal ? round((imagesWithAlt / imagesTotal) * 100) : null;

  // --- Keywords ---
  const freq = new Map();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.length < 4) continue;
    if (STOPWORDS.has(lower)) continue;
    if (/^\d+$/.test(lower)) continue;
    freq.set(lower, (freq.get(lower) || 0) + 1);
  }
  const keywords = [...freq.entries()]
    .map(([word, count]) => ({
      word,
      count,
      density: wordCount ? round((count / wordCount) * 100, 2) : 0,
    }))
    .filter((k) => k.count >= 2)
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 8);

  const topKeyword = keywords[0]?.word || '';
  const firstWords = tokens.slice(0, 150).join(' ');
  const h1Text = clean($c('h1').first().text());

  // --- Category scores ---
  let depthScore;
  if (wordCount >= 1500) depthScore = 100;
  else if (wordCount >= 1000) depthScore = 90;
  else if (wordCount >= 700) depthScore = 80;
  else if (wordCount >= 500) depthScore = 70;
  else if (wordCount >= 300) depthScore = 55;
  else if (wordCount >= 150) depthScore = 35;
  else depthScore = clamp((wordCount / 150) * 25);

  const readabilityScore =
    fleschReadingEase === null ? 40 : clamp(100 - Math.abs(fleschReadingEase - 65) * 1.5);

  const h1Score = headingCounts.h1 === 1 ? 100 : headingCounts.h1 === 0 ? 0 : 60;
  const expectedHeadings = Math.max(2, wordCount / 300);
  const headingDensityScore = clamp((headings.length / expectedHeadings) * 100);
  const hierarchyScore = clamp(100 - skippedLevels * 25);
  const headingQualityScore = headings.length
    ? clamp((meaningfulHeadings / headings.length) * 100)
    : 0;
  const structureScore =
    h1Score * 0.3 +
    headingDensityScore * 0.3 +
    hierarchyScore * 0.2 +
    headingQualityScore * 0.2;

  let keywordScore = 0;
  if (topKeyword) {
    if (containsTerm(title, topKeyword)) keywordScore += 25;
    if (containsTerm(description, topKeyword)) keywordScore += 20;
    if (containsTerm(h1Text, topKeyword)) keywordScore += 20;
    if (containsTerm(firstWords, topKeyword)) keywordScore += 15;
    const kd = keywords[0].density;
    if (kd >= 0.5 && kd <= 3) keywordScore += 20;
    else if (kd >= 0.3 && kd <= 4.5) keywordScore += 10;
  }

  let metaScore = 0;
  if (title) metaScore += 15;
  if (title.length >= 30 && title.length <= 65) metaScore += 15;
  else if (title) metaScore += 5;
  if (description) metaScore += 15;
  if (description.length >= 70 && description.length <= 160) metaScore += 15;
  else if (description) metaScore += 5;
  if (canonical) metaScore += 10;
  if (lang) metaScore += 10;
  if (viewport) metaScore += 10;
  if (https) metaScore += 10;

  const altScore = imagesTotal === 0 ? 30 : (imagesWithAlt / imagesTotal) * 50;
  const imagePresenceScore = imagesTotal > 0 ? 10 : 0;
  const internalLinkScore = clamp((internalLinks.size / 3) * 25, 0, 25);
  const externalLinkScore = externalLinks.size >= 1 ? 15 : 0;
  const mediaScore = altScore + imagePresenceScore + internalLinkScore + externalLinkScore;

  let technicalScore = 0;
  if (https) technicalScore += 25;
  if (hasStructuredData) technicalScore += 25;
  if (ogTags >= 3) technicalScore += 20;
  else if (ogTags >= 1) technicalScore += 10;
  if (hasFavicon) technicalScore += 15;
  if (viewport) technicalScore += 15;

  const categories = [
    {
      key: 'depth',
      label: 'Content depth',
      score: round(depthScore),
      weight: 0.2,
      summary: `${wordCount.toLocaleString()} words, ~${readingTimeMin} min read`,
    },
    {
      key: 'readability',
      label: 'Readability',
      score: round(readabilityScore),
      weight: 0.2,
      summary:
        fleschReadingEase === null
          ? 'Not enough text to measure'
          : `Flesch ${fleschReadingEase} — ${readingLabel(fleschReadingEase)}`,
    },
    {
      key: 'structure',
      label: 'Structure',
      score: round(structureScore),
      weight: 0.15,
      summary: `${headings.length} headings, ${headingCounts.h1} H1`,
    },
    {
      key: 'keywords',
      label: 'Topic focus',
      score: round(keywordScore),
      weight: 0.15,
      summary: topKeyword ? `Main term: "${topKeyword}"` : 'Not enough text to detect a topic',
    },
    {
      key: 'meta',
      label: 'SEO basics',
      score: round(metaScore),
      weight: 0.15,
      summary: title
        ? `${title.length}-char title, ${description ? 'meta description set' : 'no meta description'}`
        : 'Missing page title',
    },
    {
      key: 'media',
      label: 'Media & links',
      score: round(mediaScore),
      weight: 0.1,
      summary:
        imagesTotal === 0
          ? `No images, ${internalLinks.size} internal links`
          : `${imagesTotal} images, ${altCoverage}% with alt text`,
    },
    {
      key: 'technical',
      label: 'Technical',
      score: round(technicalScore),
      weight: 0.05,
      summary: `${https ? 'HTTPS' : 'No HTTPS'}, ${hasStructuredData ? 'structured data' : 'no structured data'}`,
    },
  ];

  const score = round(
    categories.reduce((sum, c) => sum + c.score * c.weight, 0),
    1,
  );
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

  // --- Recommendations ---
  const recommendations = [];
  const add = (severity, title, detail) => recommendations.push({ severity, title, detail });

  if (wordCount < 300) {
    add('error', 'Thin content', `Only ${wordCount} words were found. Most pages rank better with at least 600–1,000 words of useful content.`);
  } else if (wordCount < 600) {
    add('warn', 'Content could go deeper', `${wordCount} words is on the short side. Aim for 600+ words if the topic warrants it.`);
  }
  if (fleschReadingEase !== null && fleschReadingEase < 40) {
    add('error', 'Very hard to read', `Flesch score is ${fleschReadingEase}. Shorten sentences and use simpler words.`);
  } else if (fleschReadingEase !== null && fleschReadingEase < 50) {
    add('warn', 'Hard to read', `Flesch score is ${fleschReadingEase}. Aim for 60–70 for web content.`);
  }
  if (headingCounts.h1 === 0) {
    add('error', 'Missing H1', 'Add exactly one H1 that states the main topic of the page.');
  } else if (headingCounts.h1 > 1) {
    add('warn', 'Multiple H1 headings', `${headingCounts.h1} H1 tags found. Use one H1 and H2/H3 for subsections.`);
  }
  if (skippedLevels > 0) {
    add('warn', 'Heading levels skip', 'Headings jump levels (e.g. H2 straight to H4). Keep the hierarchy sequential.');
  }
  if (!title) {
    add('error', 'Missing page title', 'Add a unique <title> tag of about 30–65 characters.');
  } else if (title.length < 30 || title.length > 65) {
    add('warn', 'Title length is off', `Title is ${title.length} characters. Aim for 30–65 so it is not truncated in search results.`);
  }
  if (!description) {
    add('warn', 'Missing meta description', 'Add a 70–160 character description that summarizes the page.');
  } else if (description.length < 70 || description.length > 160) {
    add('warn', 'Meta description length is off', `It is ${description.length} characters. Aim for 70–160.`);
  }
  if (topKeyword && !containsTerm(title, topKeyword)) {
    add('warn', 'Main topic missing from title', `The most frequent term is "${topKeyword}", but it is not in the page title.`);
  }
  if (topKeyword && !containsTerm(h1Text, topKeyword)) {
    add('warn', 'Main topic missing from H1', `Consider including "${topKeyword}" in the H1.`);
  }
  if (!canonical) add('info', 'No canonical URL', 'Add <link rel="canonical"> to avoid duplicate-content issues.');
  if (!lang) add('warn', 'Missing lang attribute', 'Set <html lang="en"> (or the correct language) for accessibility and SEO.');
  if (!viewport) add('error', 'Not mobile-ready', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  if (!https) add('error', 'No HTTPS', 'Serve the page over HTTPS — it is a confirmed ranking and trust signal.');
  if (/noindex/i.test(robots)) {
    add('error', 'Page is set to noindex', 'The meta robots tag prevents search engines from indexing this page.');
  }
  if (imagesTotal > 0 && altCoverage < 70) {
    add('warn', 'Images missing alt text', `${imagesTotal - imagesWithAlt} of ${imagesTotal} images have no alt text.`);
  }
  if (imagesTotal === 0) {
    add('info', 'No images', 'Relevant images or diagrams can improve engagement and time on page.');
  }
  if (internalLinks.size < 3) {
    add('warn', 'Few internal links', `${internalLinks.size} internal link${internalLinks.size === 1 ? '' : 's'} found. Link to related pages to spread authority.`);
  }
  if (!hasStructuredData) {
    add('info', 'No structured data', 'Add JSON-LD schema (Article, Product, FAQ, etc.) to help search engines understand the page.');
  }
  if (ogTags < 3) {
    add('info', 'Incomplete social tags', 'Add Open Graph tags (og:title, og:description, og:image) for better link previews.');
  }
  if (recommendations.length === 0) {
    add('good', 'No major issues found', 'This page covers depth, readability, structure, SEO basics and media well.');
  }

  const order = { error: 0, warn: 1, info: 2, good: 3 };
  recommendations.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    url: finalUrl,
    analyzedAt: new Date().toISOString(),
    score,
    grade,
    categories,
    metrics: {
      wordCount,
      sentenceCount,
      paragraphCount: paragraphs,
      readingTimeMin,
      avgSentenceWords: round(wordsPerSentence),
      fleschReadingEase,
      fleschKincaidGrade,
      readingLabel: readingLabel(fleschReadingEase),
      headingCount: headings.length,
      internalLinks: internalLinks.size,
      externalLinks: externalLinks.size,
      nofollowLinks,
      images: imagesTotal,
      imagesWithAlt,
      altCoverage,
    },
    seo: {
      title,
      titleLength: title.length,
      description,
      descriptionLength: description.length,
      canonical,
      lang,
      viewport,
      robots,
      https,
      ogTags,
      structuredData: hasStructuredData,
      favicon: hasFavicon,
    },
    headings: {
      counts: headingCounts,
      skippedLevels,
      items: headings,
    },
    keywords,
    recommendations,
    preview: text.slice(0, 600),
  };
}
