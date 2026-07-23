#!/usr/bin/env node
// 由 `pnpm run sync:version` 调用。
// 读取 package.json 的 version，重写 shared/app-version.ts，避免运行时解析 package.json。
// 仅写版本号常量，不写入任何凭据。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const pkgPath = path.join(projectRoot, "package.json");
const outPath = path.join(projectRoot, "shared", "app-version.ts");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const version = String(pkg.version || "").trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync:version] invalid version in package.json: ${JSON.stringify(pkg.version)}`);
  process.exit(1);
}

const content = `// 此文件由 pnpm run sync:version 生成；请修改 package.json version 后重新同步。
// launcher 和认证页都从这里读取版本，避免运行时解析 package.json。

export const OPENCLAUDE_VERSION = ${JSON.stringify(version)};
export const OPENCLAUDE_VERSION_LABEL = \`v\${OPENCLAUDE_VERSION}\`;
`;

fs.writeFileSync(outPath, content, "utf-8");
console.log(`[sync:version] wrote ${path.relative(projectRoot, outPath)} -> v${version}`);
