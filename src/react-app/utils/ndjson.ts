export interface RenderProgress {
  pct: number;
  frames: number;
  total: number;
  elapsed: string;
}

export async function readNDJSONStream(
  response: Response,
  onProgress: (data: RenderProgress) => void,
): Promise<Record<string, unknown>> {
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('ndjson') && !ct.includes('stream')) {
    return response.json();
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === 'progress') onProgress(msg);
      else if (msg.type === 'result') return msg;
      else if (msg.type === 'error') throw new Error(msg.message);
    }
  }

  if (buffer.trim()) {
    const msg = JSON.parse(buffer);
    if (msg.type === 'result') return msg;
    if (msg.type === 'error') throw new Error(msg.message);
  }

  throw new Error('Stream ended without result');
}
