import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

describe("createChannelProgressDraftCompositor", () => {
  it("keeps the progress label visible when tool lines are hidden", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling", toolProgress: false } },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });

    expect(update).toHaveBeenCalledWith("Shelling", { flush: true });
  });

  it("keeps reasoning details hidden when tool progress lines are hidden", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling", toolProgress: false } },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Reading files");

    expect(update).toHaveBeenCalledWith("Shelling", { flush: true });
    expect(update).not.toHaveBeenCalledWith(expect.stringContaining("Reading"), undefined);
  });

  it("does not resurrect progress after suppression", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    progress.suppress();
    await progress.pushReasoningProgress("Reading files");

    expect(update).not.toHaveBeenCalled();
  });

  it("composes reasoning deltas with tool progress", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Reading");
    await progress.pushReasoningProgress(" files");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n• _Reading files_", undefined);
  });

  it("preserves tagged reasoning content without leaking tags", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("<think>Checking files</think>Final answer prose");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n• _Checking files_", undefined);
  });

  it("waits for complete reasoning tags before showing tagged progress", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    const calls = update.mock.calls.length;
    await progress.pushReasoningProgress("<thin");

    expect(update.mock.calls).toHaveLength(calls);
  });

  it("preserves partial reasoning tag buffers across deltas", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("<thin");
    await progress.pushReasoningProgress("k>Checking files</think>Final answer prose");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n• _Checking files_", undefined);
  });

  it("keeps literal reasoning tags inside code blocks", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("```html\n<think>literal</think>\n```");

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n🛠️ Exec\n• _```html <think>literal</think> ```_",
      undefined,
    );
  });

  it("replaces repeated formatted reasoning snapshots", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Thinking\n\n_Reading_");
    await progress.pushReasoningProgress("Thinking\n\n_Reading files_");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n• _Reading files_", undefined);
  });

  it("freezes progress lines on suppress when persistProgress is enabled", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "Working", persistProgress: true },
        },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("Exec: ls", { startImmediately: true });
    expect(progress.frozenProgressLines).toHaveLength(0);

    progress.suppress();

    // After suppress, the tool line should have been frozen.
    expect(progress.frozenProgressLines).toHaveLength(1);
  });

  it("does not freeze progress lines when persistProgress is disabled", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "Working" },
        },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("Exec: ls", { startImmediately: true });
    progress.suppress();

    expect(progress.frozenProgressLines).toHaveLength(0);
  });

  it("formats frozen progress text with char budget truncation", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: false, persistProgress: true },
        },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("Exec: first-command", { startImmediately: true });
    await progress.pushToolProgress("Exec: second-command", { startImmediately: true });
    progress.suppress();

    const fullText = progress.formatFrozenProgressText();
    expect(fullText).toContain("first-command");
    expect(fullText).toContain("second-command");

    // With a very tight budget, oldest lines should be trimmed.
    const tight = progress.formatFrozenProgressText(30);
    expect(tight.length).toBeLessThanOrEqual(30);
  });

  it("returns empty frozen text when persistProgress is disabled", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "Working" },
        },
      },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("Exec: ls", { startImmediately: true });
    progress.suppress();

    expect(progress.formatFrozenProgressText()).toBe("");
  });
});
