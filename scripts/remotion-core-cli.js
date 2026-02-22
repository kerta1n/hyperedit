#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, resolve } from 'path';
import { generateAdVariants, normalizeSpec } from './remotion-core/spec.js';
import { renderSpecWithRemotion, renderVariantBatch } from './remotion-core/render.js';

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
  return normalizeSpec(JSON.parse(content));
}

function csv(input, fallback = []) {
  if (!input) return fallback;
  if (Array.isArray(input)) return input;
  return String(input).split(',').map((item) => item.trim()).filter(Boolean);
}

async function commandRender(args) {
  if (!args.spec || !args.out) {
    throw new Error('Usage: remotion:render --spec <file.json> --out <output.mp4> [--preview]');
  }

  const specPath = resolve(args.spec);
  const out = resolve(args.out);
  const spec = await readSpec(specPath);

  const result = await renderSpecWithRemotion({
    spec,
    outputPath: out,
    preview: Boolean(args.preview),
    logLevel: 'warn',
  });

  console.log(`✅ Render complete: ${result.outputPath}`);
  console.log(`   ${result.width}x${result.height} @ ${result.fps}fps`);
}

async function commandVariants(args, shouldRender = false) {
  if (!args.spec || !args['out-dir']) {
    throw new Error(`Usage: ${shouldRender ? 'remotion:batch' : 'remotion:variants'} --spec <file.json> --out-dir <dir> [--count 4] [--hooks "a,b"] [--bodies "x,y"] [--ctas "c,d"]`);
  }

  const specPath = resolve(args.spec);
  const outDir = resolve(args['out-dir']);
  await mkdir(outDir, { recursive: true });

  const baseSpec = await readSpec(specPath);
  const count = Number(args.count || 3);

  const variants = generateAdVariants(baseSpec, {
    count,
    hooks: csv(args.hooks),
    bodies: csv(args.bodies),
    ctas: csv(args.ctas),
  });

  const specsDir = resolve(outDir, 'specs');
  await mkdir(specsDir, { recursive: true });

  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i];
    const filePath = resolve(specsDir, `${basename(specPath, '.json')}-variant-${String(i + 1).padStart(2, '0')}.json`);
    await writeFile(filePath, `${JSON.stringify(variant, null, 2)}\n`, 'utf-8');
  }

  if (!shouldRender) {
    console.log(`✅ Wrote ${variants.length} variant specs to ${specsDir}`);
    return;
  }

  const rendersDir = resolve(outDir, 'renders');
  await mkdir(rendersDir, { recursive: true });

  const results = await renderVariantBatch({
    variants,
    outDir: rendersDir,
    prefix: 'ad-variant',
    preview: Boolean(args.preview),
    logLevel: 'warn',
  });

  console.log(`✅ Rendered ${results.length} variants:`);
  for (const result of results) {
    console.log(`   - ${result.outputPath}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === 'help' || args.help) {
    console.log('HyperEdit Remotion Core CLI');
    console.log('');
    console.log('Commands:');
    console.log('  render   --spec <spec.json> --out <output.mp4> [--preview]');
    console.log('  variants --spec <spec.json> --out-dir <dir> [--count 3] [--hooks a,b] [--bodies c,d] [--ctas e,f]');
    console.log('  batch    --spec <spec.json> --out-dir <dir> [--count 3] [--preview]');
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

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
