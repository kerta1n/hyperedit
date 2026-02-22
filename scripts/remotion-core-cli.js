#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, resolve } from 'path';
import {
  generateAdVariants,
  parseSpecInput,
  RemotionSpecValidationError,
} from './remotion-core/spec.js';
import { renderSpecWithRemotion, renderVariantBatch } from './remotion-core/render.js';
import { scoreVariantBatch, writeCampaignReport } from './remotion-core/ad-intelligence.js';

function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }

  return args;
}

async function readSpec(path) {
  const content = await readFile(path, 'utf-8');
  return parseSpecInput(JSON.parse(content), {
    source: `cli:${path}`,
  });
}

function csv(input, fallback = []) {
  if (!input) return fallback;
  if (Array.isArray(input)) return input;
  return String(input).split(',').map((item) => item.trim()).filter(Boolean);
}

function getVariantOptions(args) {
  return {
    count: Number(args.count || 3),
    hooks: csv(args.hooks),
    hookPool: csv(args['hook-pool']),
    bodies: csv(args.bodies),
    bodyPool: csv(args['body-pool']),
    ctas: csv(args.ctas),
    ctaPool: csv(args['cta-pool']),
    toneProfile: args['tone-profile'] ? String(args['tone-profile']) : undefined,
    captionStyleProfile: args['caption-style-profile'] ? String(args['caption-style-profile']) : undefined,
  };
}

function logMigration(migration, warnings = []) {
  if (migration?.migrated) {
    console.log(`ℹ️  Migrated spec ${migration.fromVersion} -> ${migration.toVersion}`);
  }

  if (warnings.length) {
    console.log(`ℹ️  Transition warnings:`);
    warnings.forEach((warning) => console.log(`   - ${warning}`));
  }
}

async function writeVariantSpecs(variants, specPath, specsDir) {
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i];
    const filePath = resolve(specsDir, `${basename(specPath, '.json')}-variant-${String(i + 1).padStart(2, '0')}.json`);
    await writeFile(filePath, `${JSON.stringify(variant, null, 2)}\n`, 'utf-8');
  }
}

async function commandRender(args) {
  if (!args.spec || !args.out) {
    throw new Error('Usage: remotion:render --spec <file.json> --out <output.mp4> [--preview]');
  }

  const specPath = resolve(args.spec);
  const out = resolve(args.out);
  const { spec, migration, warnings } = await readSpec(specPath);
  logMigration(migration, warnings);

  const result = await renderSpecWithRemotion({
    spec,
    outputPath: out,
    preview: Boolean(args.preview),
    logLevel: 'warn',
  });

  console.log(`✅ Render complete: ${result.outputPath}`);
  console.log(`   ${result.width}x${result.height} @ ${result.fps}fps`);
}

async function commandVariants(args, shouldRender = false, forceScoreReport = false) {
  if (!args.spec || !args['out-dir']) {
    throw new Error(
      `Usage: ${shouldRender ? 'remotion:batch' : 'remotion:variants'} --spec <file.json> --out-dir <dir> [--count 4] [--hook-pool "a,b"] [--body-pool "x,y"] [--cta-pool "c,d"] [--tone-profile direct-response] [--caption-style-profile punchy]`,
    );
  }

  const specPath = resolve(args.spec);
  const outDir = resolve(args['out-dir']);
  await mkdir(outDir, { recursive: true });

  const { spec: baseSpec, migration, warnings } = await readSpec(specPath);
  logMigration(migration, warnings);

  const variants = generateAdVariants(baseSpec, getVariantOptions(args));

  const specsDir = resolve(outDir, 'specs');
  await mkdir(specsDir, { recursive: true });
  await writeVariantSpecs(variants, specPath, specsDir);

  if (!shouldRender) {
    console.log(`✅ Wrote ${variants.length} variant specs to ${specsDir}`);

    if (forceScoreReport || Boolean(args.scores)) {
      const report = scoreVariantBatch(variants, {
        batchLabel: args['campaign-label'] || 'variants-only',
      });
      const reportPaths = await writeCampaignReport(outDir, report, {
        prefix: args['scores-prefix'] || 'campaign-intelligence',
      });
      console.log(`✅ Scoring report: ${reportPaths.jsonPath}`);
      console.log(`✅ Scoring summary: ${reportPaths.mdPath}`);
    }

    return;
  }

  const rendersDir = resolve(outDir, 'renders');
  await mkdir(rendersDir, { recursive: true });

  const results = await renderVariantBatch({
    variants,
    outDir: rendersDir,
    prefix: args.prefix || 'ad-variant',
    preview: Boolean(args.preview),
    logLevel: 'warn',
  });

  console.log(`✅ Rendered ${results.length} variants:`);
  for (const result of results) {
    console.log(`   - ${result.outputPath}`);
  }

  if (!args['no-scores']) {
    const report = scoreVariantBatch(variants, {
      batchLabel: args['campaign-label'] || 'render-batch',
    });

    const reportPaths = await writeCampaignReport(outDir, report, {
      prefix: args['scores-prefix'] || 'campaign-intelligence',
    });

    console.log(`✅ Scoring report: ${reportPaths.jsonPath}`);
    console.log(`✅ Scoring summary: ${reportPaths.mdPath}`);
  }
}

async function commandCampaign(args) {
  if (!args.spec || !args['out-dir']) {
    throw new Error('Usage: remotion:campaign --spec <file.json> --out-dir <dir> [--count 6] [--hook-pool a,b] [--cta-pool c,d] [--tone-profile direct-response] [--caption-style-profile punchy] [--preview]');
  }

  if (!args['campaign-label']) {
    args['campaign-label'] = `campaign-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }

  console.log('🚀 Campaign mode: generating variants + renders + intelligence report');
  await commandVariants(args, true, true);
}

function printHelp() {
  console.log('HyperEdit Remotion Core CLI (V2)');
  console.log('');
  console.log('Commands:');
  console.log('  render    --spec <spec.json> --out <output.mp4> [--preview]');
  console.log('  variants  --spec <spec.json> --out-dir <dir> [--count 3] [--hook-pool a,b] [--body-pool c,d] [--cta-pool e,f] [--tone-profile direct-response] [--caption-style-profile punchy]');
  console.log('  batch     --spec <spec.json> --out-dir <dir> [--count 3] [--preview] [--scores-prefix campaign-intelligence]');
  console.log('  campaign  --spec <spec.json> --out-dir <dir> [--count 6] [--hook-pool a,b] [--cta-pool c,d] [--tone-profile direct-response] [--caption-style-profile punchy] [--preview]');
  console.log('');
  console.log('Compatibility flags still supported: --hooks, --bodies, --ctas');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === 'help' || args.help) {
    printHelp();
    process.exit(0);
  }

  if (command === 'render') {
    await commandRender(args);
    return;
  }

  if (command === 'variants') {
    await commandVariants(args, false);
    return;
  }

  if (command === 'batch') {
    await commandVariants(args, true);
    return;
  }

  if (command === 'campaign') {
    await commandCampaign(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  if (error instanceof RemotionSpecValidationError) {
    console.error(`❌ ${error.message}`);
    if (Array.isArray(error.issues) && error.issues.length) {
      console.error('   Validation details:');
      for (const issue of error.issues) {
        const at = issue.path ? ` (${issue.path})` : '';
        console.error(`   - ${issue.message}${at}`);
      }
    }
    process.exit(2);
  }

  console.error(`❌ ${error.message}`);
  process.exit(1);
});
