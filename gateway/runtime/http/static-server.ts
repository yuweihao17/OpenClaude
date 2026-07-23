import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isWithinRoot, mimeType } from "../core/config.js";
import { type Headers, headerValue, sendJson, safeParseUrl } from "./http-utils.js";

/**
 * 静态 web-shell 文件服务。迁移自 OpenCodex static-server。
 *
 * 安全：
 * - 路径必须落在 rootDir 内（isWithinRoot 用 realpath 防止 ../ 和符号链接绕过）。
 * - 只服务白名单扩展名。
 * - 不存在时返回 404 JSON，避免泄露目录结构。
 */

const ALLOWED_EXTENSIONS = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".png", ".ico", ".jpg", ".jpeg",
]);

export interface StaticServerOptions {
  rootDir: string;
}

export interface StaticServer {
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean;
  serveNotFound(res: ServerResponse): void;
}

export function createStaticServer(options: StaticServerOptions): StaticServer {
  const rootDir = path.resolve(options.rootDir);

  function serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    // 根路径返回 index.html。
    let relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    // 去掉 query/hash（safeParseUrl 已处理，但 pathname 可能含残留）。
    relativePath = relativePath.split("?")[0].split("#")[0];
    // 规范化：禁止 .. 逃逸。
    relativePath = path.normalize(relativePath).replace(/^([/\\])+/, "");
    if (relativePath.includes("..")) {
      sendJson(res, 400, { ok: false, error: "bad_path" });
      return true;
    }
    const ext = path.extname(relativePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return false;
    }
    const candidate = path.join(rootDir, relativePath);
    if (!isWithinRoot(candidate, rootDir)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return true;
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      return false;
    }
    const data = fs.readFileSync(candidate);
    res.writeHead(200, {
      "content-type": mimeType(candidate),
      "cache-control": "no-cache",
    });
    res.end(data);
    return true;
  }

  function serveNotFound(res: ServerResponse): void {
    sendJson(res, 404, { ok: false, error: "not_found" });
  }

  return { serve, serveNotFound };
}
