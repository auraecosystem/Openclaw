import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";

describe("createOpenClawCodingTools runtimeToolAllowlist override", () => {
  it("includes exec when runtimeToolAllowlist contains wildcard even with messaging profile", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
  });

  it("excludes exec with messaging profile and no runtime wildcard", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
  });

  it("allows exec background when runtimeToolAllowlist contains wildcard with messaging profile", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
    });
    const execTool = tools.find((t) => t.name === "exec");
    expect(execTool).toBeDefined();
    const allowBackground = (execTool as unknown as { allowBackground?: boolean }).allowBackground;
    expect(allowBackground).not.toBe(false);
  });

  it("does not allow exec background with messaging profile and no runtime wildcard", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
    });
    const execTool = tools.find((t) => t.name === "exec");
    expect(execTool).toBeUndefined();
  });
});
