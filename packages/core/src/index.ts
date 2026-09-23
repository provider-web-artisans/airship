export type {
  AgentAdapter,
  AgentKind,
  AgentRunContext,
  AgentRunOutcome,
} from "./agent";
export { getAdapter } from "./agent";
export { DiffCapture } from "./diff-capture";
/** Path identity, shared so containment, diff keys and history keys agree. */
export type { ModelProbeOptions } from "./models";
export { listAllModels, listModels } from "./models";
export { isPathInside, pathKey, toPosixPath } from "./paths";
export type { EditPromptInput } from "./prompt";
export { AIRSHIP_SYSTEM_PROMPT, buildEditPrompt, systemPrompt } from "./prompt";
export type { CodexConfigValue, CodexSettings } from "./providers/codex";
export type { DshSettings } from "./providers/dsh";
/** Whether an already-running dsh host answers, so a caller can say so before a
 * turn is spent on it. */
export { checkAttach } from "./providers/dsh-attach";
/** Whether opencode can run a model id, so a caller can refuse one it cannot. */
export { namesProvider } from "./providers/opencode-events";
export type { OpencodeSettings } from "./providers/opencode-server";
/** Stops the shared `opencode serve` child, which otherwise outlives the run. */
export { shutdownServer as shutdownOpencodeServer } from "./providers/opencode-server";
export type { PiSettings } from "./providers/pi";
export type {
  RunEditEvents,
  RunEditInput,
  RunEditResult,
} from "./runner";
export { checkAuth, rewindEdit, runEdit } from "./runner";
export type { TimelineSink } from "./timeline";
export { TimelineRecorder } from "./timeline";
export {
  describeTool,
  shortenPath,
  summarizeToolResult,
  toolArgs,
  toolTitle,
} from "./tool-summary";
