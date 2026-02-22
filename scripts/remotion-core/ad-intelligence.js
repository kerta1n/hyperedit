import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at', 'with', 'from', 'is', 'are', 'be', 'this', 'that',
  'your', 'you', 'our', 'we', 'it', 'its', 'by', 'as', 'now', 'today', 'get', 'try',
]);

const CLARITY_KEYWORDS = ['how', 'why', 'because', 'simple', 'easy', 'clear', 'proven', 'exact', 'step', 'real'];
const URGENCY_KEYWORDS = ['now', 'today', 'limited', 'hurry', 'instant', 'instantly', 'before', 'deadline', 'last chance', 'quick'];
const BENEFIT_KEYWORDS = ['save', 'comfort', 'better', 'faster', 'easier', 'growth', 'results', 'pain-free', 'risk-free', 'improve'];

const ROLE_IDEAL_WORDS = {
  hook: { min: 4, max: 12 },
  body: { min: 10, max: 28 },
  cta: { min: 3, max: 12 },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function tokenize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function keywordHits(text, dictionary) {
  const source = String(text).toLowerCase();
  return dictionary.filter((keyword) => source.includes(keyword));
}

function countRepeatedTokens(tokens = []) {
  const counts = new Map();
  for (const token of tokens) {
    if (STOP_WORDS.has(token) || token.length < 3) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  let repeatedWordTypes = 0;
  let repeatedWordInstances = 0;

  for (const [, count] of counts) {
    if (count > 1) {
      repeatedWordTypes += 1;
      repeatedWordInstances += count - 1;
    }
  }

  return {
    repeatedWordTypes,
    repeatedWordInstances,
  };
}

function lengthScore(role, wordCount) {
  const ideal = ROLE_IDEAL_WORDS[role] || ROLE_IDEAL_WORDS.body;
  if (wordCount >= ideal.min && wordCount <= ideal.max) {
    return 30;
  }

  const distance = wordCount < ideal.min ? ideal.min - wordCount : wordCount - ideal.max;
  return clamp(30 - distance * 3.5, 4, 30);
}

function segmentScore(role, text) {
  const normalizedText = String(text || '').trim();
  const tokens = tokenize(normalizedText);
  const words = tokens.length;

  const clarityHits = keywordHits(normalizedText, CLARITY_KEYWORDS);
  const urgencyHits = keywordHits(normalizedText, URGENCY_KEYWORDS);
  const benefitHits = keywordHits(normalizedText, BENEFIT_KEYWORDS);

  const clarityScore = Math.min(clarityHits.length * 6, 20);
  const urgencyScore = Math.min(urgencyHits.length * 6, role === 'body' ? 12 : 18);
  const benefitScore = Math.min(benefitHits.length * 5, role === 'body' ? 16 : 20);

  const repeats = countRepeatedTokens(tokens);
  const repetitionPenalty = Math.min(repeats.repeatedWordTypes * 3 + repeats.repeatedWordInstances * 1.5, 22);

  const score = clamp(
    lengthScore(role, words) + clarityScore + urgencyScore + benefitScore - repetitionPenalty,
    0,
    100,
  );

  return {
    role,
    text: normalizedText,
    words,
    score,
    breakdown: {
      lengthScore: Number(lengthScore(role, words).toFixed(2)),
      clarityScore,
      urgencyScore,
      benefitScore,
      repetitionPenalty: Number(repetitionPenalty.toFixed(2)),
    },
    signals: {
      clarityHits,
      urgencyHits,
      benefitHits,
      repeatedWordTypes: repeats.repeatedWordTypes,
      repeatedWordInstances: repeats.repeatedWordInstances,
    },
  };
}

function extractSegments(spec) {
  const selections = spec?.meta?.selections || {};
  const roleCaptions = {
    hook: null,
    body: null,
    cta: null,
  };

  for (const caption of spec?.captions || []) {
    const role = caption.segmentRole;
    if ((role === 'hook' || role === 'body' || role === 'cta') && !roleCaptions[role]) {
      roleCaptions[role] = caption.text || '';
    }
  }

  return {
    hook: selections.hook || roleCaptions.hook || '',
    body: selections.body || roleCaptions.body || '',
    cta: selections.cta || roleCaptions.cta || '',
  };
}

export function scoreVariant(spec, index = 0) {
  const segments = extractSegments(spec);

  const hookScore = segmentScore('hook', segments.hook);
  const bodyScore = segmentScore('body', segments.body);
  const ctaScore = segmentScore('cta', segments.cta);

  const globalTokens = tokenize([segments.hook, segments.body, segments.cta].join(' '));
  const globalRepeats = countRepeatedTokens(globalTokens);
  const crossSegmentPenalty = Math.min(globalRepeats.repeatedWordTypes * 1.8 + globalRepeats.repeatedWordInstances * 0.8, 15);

  const weighted = (
    hookScore.score * 0.45
    + bodyScore.score * 0.2
    + ctaScore.score * 0.35
    - crossSegmentPenalty
  );

  const overallScore = clamp(weighted, 0, 100);

  return {
    variantIndex: index + 1,
    variantId: spec?.id || `variant-${index + 1}`,
    title: spec?.title || `Variant ${index + 1}`,
    score: Number(overallScore.toFixed(2)),
    penalties: {
      crossSegmentRepetitionPenalty: Number(crossSegmentPenalty.toFixed(2)),
      repeatedWordTypes: globalRepeats.repeatedWordTypes,
      repeatedWordInstances: globalRepeats.repeatedWordInstances,
    },
    segments: {
      hook: hookScore,
      body: bodyScore,
      cta: ctaScore,
    },
  };
}

export function scoreVariantBatch(variants = [], options = {}) {
  const scored = variants.map((spec, index) => scoreVariant(spec, index));
  const ranked = [...scored].sort((a, b) => b.score - a.score).map((item, rank) => ({
    ...item,
    rank: rank + 1,
  }));

  const averageScore = ranked.length
    ? ranked.reduce((sum, variant) => sum + variant.score, 0) / ranked.length
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    batchLabel: options.batchLabel || 'campaign',
    variantCount: ranked.length,
    averageScore: Number(averageScore.toFixed(2)),
    bestVariant: ranked[0] || null,
    variants: ranked,
    rubric: {
      deterministic: true,
      weightedBlend: {
        hook: 0.45,
        body: 0.2,
        cta: 0.35,
      },
      signals: {
        clarityKeywords: CLARITY_KEYWORDS,
        urgencyKeywords: URGENCY_KEYWORDS,
        benefitKeywords: BENEFIT_KEYWORDS,
      },
    },
  };
}

export function buildMarkdownSummary(report) {
  const lines = [];
  lines.push(`# Campaign Intelligence Report`);
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Batch: ${report.batchLabel}`);
  lines.push(`- Variants: ${report.variantCount}`);
  lines.push(`- Average score: **${report.averageScore}**`);

  if (report.bestVariant) {
    lines.push(`- Best variant: **#${report.bestVariant.variantIndex}** (${report.bestVariant.score})`);
  }

  lines.push('');
  lines.push('## Ranked variants');
  lines.push('');

  for (const variant of report.variants) {
    lines.push(`### ${variant.rank}. Variant ${variant.variantIndex} — score ${variant.score}`);
    lines.push(`- ID: \`${variant.variantId}\``);
    lines.push(`- Hook: ${variant.segments.hook.text || '_n/a_'}`);
    lines.push(`- Body: ${variant.segments.body.text || '_n/a_'}`);
    lines.push(`- CTA: ${variant.segments.cta.text || '_n/a_'}`);
    lines.push(`- Repetition penalty: ${variant.penalties.crossSegmentRepetitionPenalty}`);
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- Scores are deterministic heuristic scores (not model-generated).');
  lines.push('- Higher scores generally indicate stronger hook clarity + CTA urgency/benefit balance.');

  return `${lines.join('\n')}\n`;
}

export async function writeCampaignReport(outDir, report, options = {}) {
  const prefix = options.prefix || 'campaign-intelligence';
  await mkdir(outDir, { recursive: true });

  const jsonPath = resolve(outDir, `${prefix}.json`);
  const mdPath = resolve(outDir, `${prefix}.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  await writeFile(mdPath, buildMarkdownSummary(report), 'utf-8');

  return {
    jsonPath,
    mdPath,
  };
}
