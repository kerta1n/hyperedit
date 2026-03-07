#!/usr/bin/env python3
"""
Local Whisper transcription script with word-level timestamps.
Usage: python3 whisper-transcribe.py <audio_file> [model_size] [--model-dir <path>]
Output: JSON with transcript and word timestamps
"""

import sys
import json
import io
import contextlib
import argparse

# Suppress Whisper's stdout output (like "Detected language: English")
@contextlib.contextmanager
def suppress_stdout():
    """Temporarily redirect stdout to suppress Whisper's print statements."""
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        yield
    finally:
        sys.stdout = old_stdout

import whisper

def transcribe(audio_path, model_size="base", model_dir=None, condition_on_previous_text=True):
    """Transcribe audio file with word-level timestamps."""

    # Load model (will download on first use)
    # Models: tiny, base, small, medium, large, turbo
    # base is a good balance of speed and accuracy
    # Note: MPS (Apple GPU) doesn't work with Whisper's sparse tensors, so we use CPU
    load_kwargs = {}
    if model_dir:
        load_kwargs['download_root'] = model_dir

    print(f"Loading Whisper model '{model_size}'" + (f" from {model_dir}" if model_dir else "") + "...", file=sys.stderr)
    model = whisper.load_model(model_size, **load_kwargs)

    print(f"Transcribing {audio_path}...", file=sys.stderr)

    # Suppress Whisper's "Detected language" output
    with suppress_stdout():
        result = model.transcribe(
            audio_path,
            word_timestamps=True,
            condition_on_previous_text=condition_on_previous_text,
            verbose=False
        )

    # Extract word-level timestamps
    words = []
    for segment in result.get("segments", []):
        for word_info in segment.get("words", []):
            words.append({
                "text": word_info["word"].strip(),
                "start": round(word_info["start"], 3),
                "end": round(word_info["end"], 3)
            })

    output = {
        "text": result.get("text", "").strip(),
        "words": words,
        "language": result.get("language", "en")
    }

    # Output JSON to stdout
    print(json.dumps(output))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Transcribe audio with Whisper")
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("model_size", nargs="?", default="base", help="Whisper model size (tiny, base, small, medium, large, turbo)")
    parser.add_argument("--model-dir", default=None, help="Directory containing pre-downloaded Whisper model files")
    parser.add_argument("--no-condition-on-previous-text", action="store_true", help="Disable conditioning on previous text (reduces hallucination loops)")

    args = parser.parse_args()

    try:
        transcribe(args.audio_file, args.model_size, args.model_dir, not args.no_condition_on_previous_text)
    except Exception as e:
        error_msg = str(e)
        print(f"Error: {error_msg}", file=sys.stderr)
        print(json.dumps({"error": error_msg}))
        sys.exit(1)
