export { CompanionService, defaultClaudeProjectsDir } from "./service.js";
export type { IndexingStatus, SourceStatus } from "./service.js";
export { startDaemon } from "./daemon.js";
export type { DaemonOptions, RunningDaemon } from "./daemon.js";
export {
  COMPANION_VERSION,
  health,
  loadOrCreateToken,
  runtimeFilePath,
  startServer,
} from "./server.js";
export type { RunningServer, RuntimeInfo, StartServerOptions } from "./server.js";
export { dashboardHtml } from "./dashboard.js";
