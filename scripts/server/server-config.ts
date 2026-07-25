import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables from .dev.vars
function loadEnvVars(): void {
  try {
    const envPath = join(process.cwd(), '.dev.vars');
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
  } catch (e) {
    console.warn('Could not load .dev.vars:', (e as Error).message);
  }
}
loadEnvVars();

// Configure fal.ai client - SDK expects FAL_KEY env var or credentials config
// Map FAL_API_KEY to FAL_KEY for backward compatibility
if (process.env.FAL_API_KEY && !process.env.FAL_KEY) {
  process.env.FAL_KEY = process.env.FAL_API_KEY;
}

export const PORT: number = Number(process.env.HYPEREDIT_PORT) || 3333;

// Storage policy: churn goes to the ramdisk, bulk goes to the HDD, flash stays
// read-mostly. A silent os.tmpdir() fallback would route Chrome render profiles,
// webpack bundles, and upload staging onto the OS drive, so refuse to start instead.
if (!process.env.HYPEREDIT_TEMP_DIR || !process.env.HYPEREDIT_SESSIONS_DIR) {
  console.error('[Server] FATAL: HYPEREDIT_TEMP_DIR and HYPEREDIT_SESSIONS_DIR must be set (in .dev.vars or the environment).');
  console.error('[Server] No fallback to the OS temp directory — it would route render profiles, bundles, and upload staging onto the OS drive.');
  process.exit(1);
}

export const TEMP_DIR: string = join(process.env.HYPEREDIT_TEMP_DIR, 'hyperedit-ffmpeg');
export const SESSIONS_DIR: string = process.env.HYPEREDIT_SESSIONS_DIR;
// Upload staging must share a volume with the sessions directory so the post-parse
// move into a session is a rename, not a second full-file write — and so large
// uploads never land on the ramdisk (one 4-8GB OBS source would evict every tenant).
export const UPLOAD_STAGING_DIR: string = process.env.HYPEREDIT_UPLOAD_STAGING_DIR || join(SESSIONS_DIR, '.upload-staging');
export const MAX_UPLOAD_BYTES: number = 64 * 1024 * 1024 * 1024; // sanity cap; long-form OBS sources run 4-8GB

// Force Node's internal os.tmpdir() to respect our explicit temp drive,
// preventing libraries like Formidable or Remotion from leaking default OS temp files.
process.env.TMPDIR = TEMP_DIR;
process.env.TEMP = TEMP_DIR;
process.env.TMP = TEMP_DIR;

// Ensure temp directories exist
if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}
if (!existsSync(UPLOAD_STAGING_DIR)) {
  mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
}
