import type { ClaudeDesktopConnector } from "./claude-desktop-connector.js";
import { UnavailableClaudeDesktopConnector } from "./unavailable-connector.js";
import { MockClaudeDesktopConnector } from "./mock-connector.js";
import { diagnosticLog } from "../../gateway/runtime/core/diagnostics.js";

/**
 * 根据环境变量选择连接器。
 *
 * 选择规则（绝不伪造）：
 * - OPENCLAUDE_USE_MOCK_CONNECTOR=1 -> MockClaudeDesktopConnector（仅用于本地演示/测试）。
 * - 否则 -> UnavailableClaudeDesktopConnector（默认，明确 unavailable）。
 *
 * 真实 Claude Desktop 连接器尚未实现：在云端无法验证，且不得伪造连接。
 */
export function createConnector(env: NodeJS.ProcessEnv = process.env): ClaudeDesktopConnector {
  if (env.OPENCLAUDE_USE_MOCK_CONNECTOR === "1" || env.OPENCLAUDE_USE_MOCK_CONNECTOR === "true") {
    diagnosticLog("connector", "factory_mock");
    return new MockClaudeDesktopConnector();
  }
  diagnosticLog("connector", "factory_unavailable");
  return new UnavailableClaudeDesktopConnector({ allowOnHostProbe: false });
}
