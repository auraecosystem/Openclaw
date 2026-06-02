import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  filterBootstrapFilesForSession,
  loadExtraBootstrapFilesWithDiagnostics,
} from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const HOOK_KEY = "bootstrap-extra-files";
const log = createSubsystemLogger("bootstrap-extra-files");

function resolveExtraBootstrapPatterns(hookConfig: Record<string, unknown>): string[] {
  const fromPaths = normalizeTrimmedStringList(hookConfig.paths);
  if (fromPaths.length > 0) {
    return fromPaths;
  }
  const fromPatterns = normalizeTrimmedStringList(hookConfig.patterns);
  if (fromPatterns.length > 0) {
    return fromPatterns;
  }
  return normalizeTrimmedStringList(hookConfig.files);
}

const bootstrapExtraFilesHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const patterns = resolveExtraBootstrapPatterns(hookConfig as Record<string, unknown>);
  if (patterns.length === 0) {
    return;
  }

  try {
    const { files: extras, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      patterns,
    );
    // Truncated globs silently drop user-configured context, so surface them at
    // warn level — every other diagnostic is routine skip noise kept at debug.
    const truncated = diagnostics.filter((item) => item.reason === "glob-match-limit");
    for (const item of truncated) {
      log.warn(`bootstrap context truncated: ${item.detail}`);
    }
    const skipped = diagnostics.filter((item) => item.reason !== "glob-match-limit");
    if (skipped.length > 0) {
      log.debug("skipped extra bootstrap candidates", {
        skipped: skipped.length,
        reasons: skipped.reduce<Record<string, number>>((counts, item) => {
          counts[item.reason] = (counts[item.reason] ?? 0) + 1;
          return counts;
        }, {}),
      });
    }
    if (extras.length === 0) {
      return;
    }
    context.bootstrapFiles = filterBootstrapFilesForSession(
      [...context.bootstrapFiles, ...extras],
      context.sessionKey,
    );
  } catch (err) {
    log.warn(`failed: ${String(err)}`);
  }
};

export default bootstrapExtraFilesHook;
