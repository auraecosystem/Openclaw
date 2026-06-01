import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  deleteRuntimeTranscript,
  readRuntimeTranscriptState,
  runtimeTranscriptExists,
} from "./transcript-runtime-state.js";

describe("runtime transcript state", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and deletes transcript state through runtime scope", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, {
      id: "msg-1",
      message: { role: "user", content: "hello" },
      parentId: null,
      type: "message",
    });

    await expect(runtimeTranscriptExists(scope)).resolves.toBe(true);
    const { state, target } = await readRuntimeTranscriptState(scope);
    expect(fs.realpathSync(target.sessionFile)).toBe(
      fs.realpathSync(path.join(tempDir, "session-1.jsonl")),
    );
    expect(state.getBranch()).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ content: "hello" }),
        type: "message",
      }),
    ]);

    await expect(deleteRuntimeTranscript(scope)).resolves.toBe(true);
    await expect(runtimeTranscriptExists(scope)).resolves.toBe(false);
  });
});
