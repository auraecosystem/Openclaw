import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";

describe("createOpenClawCodingTools runtimeToolAllowlist override", () => {
  it("includes exec when runtimeToolAllowlist contains wildcard even with messaging profile", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as Parameters<typeof createOpenClawCodingTools>[0]["config"],
      runtimeToolAllowlist: ["*"],
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
  });

  it("excludes exec with messaging profile and no runtime wildcard", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as Parameters<typeof createOpenClawCodingTools>[0]["config"],
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
  });
});
