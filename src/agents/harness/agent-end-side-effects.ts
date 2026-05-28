import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runSkillResearchAutoCapture } from "../../skills/research/autocapture.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type AgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];

function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  void runSkillResearchAutoCapture({
    event: params.event,
    ctx: params.ctx,
    ...(params.ctx.config ? { config: params.ctx.config } : {}),
  }).catch((error: unknown) => {
    log.warn(`skill research auto-capture failed: ${String(error)}`);
  });
}

export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  runCoreAgentEndSideEffects(params);
  runAgentHarnessAgentEndHook(params);
}

export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  runCoreAgentEndSideEffects(params);
  await awaitAgentHarnessAgentEndHook(params);
}
