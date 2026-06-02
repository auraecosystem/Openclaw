import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "../../agent-tools.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./attempt-tool-construction-plan.js";

describe("cron isolated session tool construction with messaging profile", () => {
  it("wildcard allowlist overrides messaging profile for tool construction plan", () => {
    const plan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsAllow: ["*"],
    });

    expect(plan.constructTools).toBe(true);
    expect(plan.includeCoreTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeBaseCodingTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeShellTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeOpenClawTools).toBe(true);
    expect(plan.runtimeToolAllowlist).toEqual(["*"]);
  });

  it("messaging profile without wildcard excludes shell tools from plan", () => {
    const plan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsAllow: ["message", "sessions_send"],
    });

    expect(plan.constructTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeBaseCodingTools).toBe(false);
    expect(plan.codingToolConstructionPlan.includeShellTools).toBe(false);
    expect(plan.codingToolConstructionPlan.includeOpenClawTools).toBe(true);
  });

  it("createOpenClawCodingTools includes exec with wildcard + messaging profile", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "cron",
      jobId: "proof-test-job",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("process");
    expect(toolNames).toContain("bash");
  });

  it("createOpenClawCodingTools excludes exec with messaging profile only", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      trigger: "cron",
      jobId: "proof-test-job",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("process");
    expect(toolNames).not.toContain("bash");
  });

  it("allowBackground is consistent with exec visibility under wildcard + messaging", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "cron",
      jobId: "proof-test-job",
    });

    const execTool = tools.find((t) => t.name === "exec");
    expect(execTool).toBeDefined();
    const allowBackground = (execTool as unknown as { allowBackground?: boolean }).allowBackground;
    expect(allowBackground).not.toBe(false);
  });
});
