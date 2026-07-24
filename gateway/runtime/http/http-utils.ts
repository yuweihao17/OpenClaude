import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_REQUEST_BODY_BYTES } from "../core/config.js";

/** 迁移自 OpenCodex http-utils。 */

export type HeaderValue = string | string[] | undefined;
export type Headers = Record<string, HeaderValue>;

/** 大小写不敏感地读取 header 值；Set-Cookie 返回数组，其余返回拼接字符串。 */
export function headerValue(headers: Headers | undefined, name: string): string | string[] {
  if (!headers) return "";
  const lower = String(name || "").toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      if (Array.isArray(value)) {
        if (lower === "set-cookie") return value;
        return value.join(", ");
      }
      return value ?? "";
    }
  }
  return "";
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string | string[]>,
): void {
  const headerMap: Record<string, string | string[]> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(headers || {}),
  };
  res.writeHead(status, headerMap);
  res.end(JSON.stringify(body));
}

export class RequestBodyTooLargeError extends Error {
  readonly code = "REQUEST_BODY_TOO_LARGE";
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function isRequestBodyTooLargeError(error: unknown): boolean {
  return error instanceof RequestBodyTooLargeError;
}

export async function readBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_REQUEST_BODY_BYTES;
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (error) => {
      if (aborted) return;
      reject(error);
    });
  });
}

/** 解析 URL，失败返回 null（绝不抛出）。 */
export function safeParseUrl(input: string): URL | null {
  try {
    return new URL(input, "http://localhost");
  } catch {
    return null;
  }
}
