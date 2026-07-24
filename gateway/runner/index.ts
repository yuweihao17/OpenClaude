import type { ClaudeDesktopConnector } from "./types.js";
import { UnavailableClaudeDesktopConnector } from "./unavailable-connector.js";
import { MockClaudeDesktopConnector } from "./mock-connector.js";
import { diagnosticLog } from "../runtime/core/diagnostics.js";

export function createConnector(env: NodeJS.ProcessEnv = process.env): ClaudeDesktopConnector {
  if (env.OPENCLAUDE_USE_MOCK_CONNECTOR === "1" || env.OPENCLAUDE_USE_MOCK_CONNECTOR === "true") {
    diagnosticLog("connector", "factory_mock");
    return new MockClaudeDesktopConnector();
  }
  diagnosticLog("connector", "factory_unavailable");
  return new UnavailableClaudeDesktopConnector({ allowOnHostProbe: false });
}
