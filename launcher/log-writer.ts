import fs from "node:fs";
import path from "node:path";

export interface BoundedLogWriterOptions {
  maxBytes?: number;
}

export interface BoundedLogWriter {
  append(filePath: string, text: string, options?: { urgent?: boolean }): void;
  close(): void;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

export function resolveLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(64 * 1024, Number(env.OPENCLAUDE_LOG_MAX_BYTES || DEFAULT_MAX_BYTES));
}

export function createBoundedLogWriter(options: BoundedLogWriterOptions = {}): BoundedLogWriter {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let writing = false;
  const queue: string[] = [];

  function flush(filePath: string): void {
    if (writing || queue.length === 0) return;
    writing = true;
    const text = queue.join("");
    queue.length = 0;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > maxBytes) {
          const oldPath = `${filePath}.old`;
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch { /* ignore */ }
          try { fs.renameSync(filePath, oldPath); } catch { /* ignore */ }
        }
      } catch { /* file may not exist yet */ }
      fs.appendFileSync(filePath, text, "utf-8");
    } catch {
      // silent on write failure
    } finally {
      writing = false;
    }
  }

  return {
    append(filePath: string, text: string): void {
      queue.push(text);
      flush(filePath);
    },
    close(): void {
      // queue is synchronously flushed, nothing extra needed
    },
  };
}
