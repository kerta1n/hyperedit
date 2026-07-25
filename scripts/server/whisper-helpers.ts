import { spawn } from 'child_process';
import { join } from 'path';

// Local Whisper engine. This module is the single seam for the transcription
// engine ladder — any future engine swap (e.g. whisper.cpp) replaces these
// functions, not their call sites.

export interface TranscriptionResult {
  text: string;
  words: Array<{ text: string; start: number; end: number }>;
  [key: string]: any;
}

let _pythonCmd: string | null = null; // cached after first successful check

function tryPythonWhisper(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn(cmd, ['-c', 'import whisper; print("ok")']);
    let output = '';
    check.stdout.on('data', (data) => { output += data.toString(); });
    check.on('close', (code) => {
      resolve(code === 0 && output.includes('ok'));
    });
    check.on('error', () => resolve(false));
  });
}

export async function checkLocalWhisper(): Promise<boolean> {
  // If we already know which python works, reuse it
  if (_pythonCmd) return true;

  // Try python3 first (Linux/macOS), then python (Windows/venv)
  for (const cmd of ['python3', 'python']) {
    if (await tryPythonWhisper(cmd)) {
      _pythonCmd = cmd;
      console.log(`[whisper] Using '${cmd}' for local Whisper`);
      return true;
    }
  }
  return false;
}

// Run local Whisper transcription
export async function runLocalWhisper(audioPath: string, jobId: string): Promise<TranscriptionResult> {
  const scriptPath = join(process.cwd(), 'scripts', 'whisper-transcribe.py');
  const pythonCmd = _pythonCmd || 'python3';
  const whisperModel = process.env.WHISPER_MODEL || 'base';
  const whisperModelDir = process.env.WHISPER_MODEL_DIR || '';
  const conditionOnPrev = (process.env.WHISPER_CONDITION_ON_PREV_TEXT || 'true').toLowerCase();

  const args = [scriptPath, audioPath, whisperModel];
  if (whisperModelDir) {
    args.push('--model-dir', whisperModelDir);
  }
  if (conditionOnPrev === 'false') {
    args.push('--no-condition-on-previous-text');
  }

  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] Running local Whisper (${pythonCmd}, model=${whisperModel}${whisperModelDir ? ', dir=' + whisperModelDir : ''})...`);
    const whisperProcess = spawn(pythonCmd, args);

    let stdout = '';
    let stderr = '';

    whisperProcess.stdout.on('data', (data) => { stdout += data.toString(); });
    whisperProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress messages
      const lines = data.toString().split('\n').filter((l: string) => l.trim());
      lines.forEach((line: string) => console.log(`[${jobId}] Whisper: ${line}`));
    });

    whisperProcess.on('close', (code) => {
      if (code !== 0) {
        // Try to parse JSON error from stdout first
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(`Whisper error: ${result.error}`));
            return;
          }
        } catch (e) {
          // stdout wasn't valid JSON, fall through to stderr
        }
        reject(new Error(`Whisper failed (exit code ${code}): ${stderr.slice(-500)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Failed to parse Whisper output: ${stdout.slice(0, 200)}`));
      }
    });

    whisperProcess.on('error', (err) => reject(err));
  });
}
