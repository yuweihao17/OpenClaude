import fs from "node:fs";
import path from "node:path";

/**
 * 有界日志写入器。迁移自 OpenCodex log rotation。
 *
 * - 单文件日志，超过 maxBytes 时滚动（保留 .old 一份）。
 * - 写入失败静默跳过，不影响网关运行。
 */

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
      // 检查大小，滚动。
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
      // 写入失败静默跳过。
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
      // 队列已同步 flush，无需额外操作。
    },
  };
}
