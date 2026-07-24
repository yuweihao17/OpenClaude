#!/usr/bin/env node
// 由 `pnpm run probe:claude` 调用。
// 在本机（通常是 Windows）扫描 Claude Desktop 安装并输出脱敏的结构化诊断。
//
// 重要限制：
// - 只读取 app.asar 内 package.json 元数据（name/version/main/依赖声明），不读取业务文件。
// - 绝不读取/输出 Claude 的 Cookie、登录令牌、API Key、聊天内容、用户配置或会话数据库。
// - 绝不复制或重新分发 Claude 专有二进制；只做存在性/版本探测。
// - 输出 JSON 到 stdout，便于粘贴到 issue 或日志；人类可读摘要输出到 stderr。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const distScanner = path.join(projectRoot, "dist", "src", "connector", "claude-desktop-scanner.js");
const distCapabilities = path.join(projectRoot, "dist", "src", "connector", "claude-desktop-capabilities.js");

if (!fs.existsSync(distScanner) || !fs.existsSync(distCapabilities)) {
  console.error("[probe:claude] dist not found. Run `pnpm run build` first.");
  process.exit(1);
}

const { scanClaudeDesktop } = await import(distScanner);
const { probeCapabilities } = await import(distCapabilities);

// OPENCLAUDE_CLAUDE_PATH 为首选；OPENCLAUDE_CLAUDE_INSTALL_PATH 作为兼容别名。
const configuredPath = process.env.OPENCLAUDE_CLAUDE_PATH || process.env.OPENCLAUDE_CLAUDE_INSTALL_PATH || "";
const allowOnHostProbe = process.env.OPENCLAUDE_PROBE_ON_HOST === "1" || process.env.OPENCLAUDE_PROBE_ON_HOST === "true";

const scan = scanClaudeDesktop({
  configuredPath: configuredPath || undefined,
  allowLoadAsar: true,
});

const report = probeCapabilities(scan, {
  allowOnHostProbe,
  platform: process.platform,
});

// 脱敏：installPath 在 Windows 上可能含用户名，做一次基础遮蔽。
function redactPath(value) {
  if (typeof value !== "string" || !value) return value;
  return value.replace(/(?:[A-Za-z]:\\Users\\)([^\\]+)/i, (m, user) => `${m.slice(0, m.indexOf(user))}<user>`);
}

const sanitizedScan = {
  found: scan.found,
  installPath: redactPath(scan.installPath),
  source: scan.source,
  packageName: scan.packageName,
  packageVersion: scan.packageVersion,
  electronVersion: scan.electronVersion,
  mainEntry: scan.mainEntry,
  components: scan.components,
  scannedAt: scan.scannedAt,
  notes: scan.notes,
};

const payload = {
  ok: true,
  scannedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  allowOnHostProbe,
  scan: sanitizedScan,
  status: report.status,
  detail: report.detail,
  routes: report.routes,
};

const json = JSON.stringify(payload, null, 2);
console.log(json);

console.error("");
console.error("[probe:claude] summary:");
console.error(`  status:        ${report.status}`);
console.error(`  install found: ${scan.found}`);
console.error(`  package:       ${scan.packageName || "(unknown)"} @ ${scan.packageVersion || "(unknown)"}`);
console.error(`  electron:      ${scan.electronVersion || "(unknown)"}`);
console.error(`  main entry:    ${scan.mainEntry || "(none)"}`);
console.error(`  components:    app.asar=${scan.components.appAsar} cowork-svc=${scan.components.coworkSvc} chrome-native-host=${scan.components.chromeNativeHost} mcp=${scan.components.mcpRuntime} ws-dep=${scan.components.wsDependency}`);
console.error(`  routes:`);
for (const route of report.routes) {
  console.error(`    - ${route.route}: ${route.status} (needsOnHostVerification=${route.needsOnHostVerification})`);
  console.error(`      ${route.evidence}`);
}
if (!allowOnHostProbe) {
  console.error("");
  console.error("  note: allowOnHostProbe=false; overall status is capped at unavailable.");
  console.error("        re-run with OPENCLAUDE_PROBE_ON_HOST=1 to allow on-host verification of routes.");
}
