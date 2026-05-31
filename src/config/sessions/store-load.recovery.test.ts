import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_STORE_TEMP_STALE_MS } from "./artifacts.js";
import { saveSessionStore } from "./store.js";
import { loadSessionStore } from "./store-load.js";

function makeValidStore(...sessionIds: string[]): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  for (const id of sessionIds) {
    store[id] = { sessionId: id, updatedAt: Date.now() };
  }
  return store;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-recovery-"));
}

function setOlderThanMs(filePath: string, millisecondsAgo: number): void {
  const target = Date.now() - millisecondsAgo;
  fs.utimesSync(filePath, new Date(target), new Date(target));
}

function setNowMtime(filePath: string): void {
  const now = new Date();
  fs.utimesSync(filePath, now, now);
}

function makeSessionStoreTmpPath(dir: string, storeBase = "sessions.json"): string {
  return path.join(dir, `${storeBase}.12345.${crypto.randomUUID()}.tmp`);
}

function makeLegacySessionStoreTmpPath(dir: string, storeBase = "sessions.json"): string {
  return path.join(dir, `${storeBase}.${crypto.randomUUID()}.tmp`);
}

function getFileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe("session store load recovery", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when main file is missing even if .bak exists", () => {
    const bakPath = `${storePath}.bak`;
    writeJson(bakPath, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("recovers 3 entries from .bak when main file is zero bytes", () => {
    fs.writeFileSync(storePath, "", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("s1", "s2", "s3"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(3);
    if (process.platform !== "win32") {
      expect(getFileMode(storePath)).toBe(0o600);
    }
  });

  it("recovers from .bak when main file has malformed JSON", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("recovers from stale legacy tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const tmpFile = makeLegacySessionStoreTmpPath(tmpDir);
    writeJson(tmpFile, makeValidStore("tmp1", "tmp2"));
    setOlderThanMs(tmpFile, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("recovers from stale session-store tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const sessionTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(sessionTmp, makeValidStore("session-tmp-1", "session-tmp-2"));
    setOlderThanMs(sessionTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("does not recover from .bak when main file is valid empty object", () => {
    writeJson(storePath, {});
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("does not recover from .bak or tmp when main file contains valid []", () => {
    writeJson(storePath, []);
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const staleTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(staleTmp, makeValidStore("stale-session"));
    setOlderThanMs(staleTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
    expect(store["bak-session"]).toBeUndefined();
    expect(store["stale-session"]).toBeUndefined();
  });

  it("recovers from stale current tmp preferred over fresh legacy tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const sessionTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(sessionTmp, makeValidStore("session-tmp"));
    setOlderThanMs(sessionTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const freshLegacyTmp = makeLegacySessionStoreTmpPath(tmpDir);
    writeJson(freshLegacyTmp, makeValidStore("fresh"));
    setNowMtime(freshLegacyTmp);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["session-tmp"]).toBeDefined();
    expect(store["fresh"]).toBeUndefined();
  });

  it("prefers newest stale tmp when multiple valid candidates exist", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const olderTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(olderTmp, makeValidStore("older-session"));
    setOlderThanMs(olderTmp, SESSION_STORE_TEMP_STALE_MS + 60_000);
    const newerTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(newerTmp, makeValidStore("newer-session"));
    setOlderThanMs(newerTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["newer-session"]).toBeDefined();
    expect(store["older-session"]).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("ignores temp artifacts younger than the cleanup stale window", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const youngTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(youngTmp, makeValidStore("young-only"));
    setOlderThanMs(youngTmp, 60_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("skips empty {} tmp candidate and continues to next valid candidate", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const emptyTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(emptyTmp, {});
    setOlderThanMs(emptyTmp, SESSION_STORE_TEMP_STALE_MS + 30_000);
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("recovered"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["recovered"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("skips unrelated json tmp (no sessionId entries) and continues scanning", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const unrelatedTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(unrelatedTmp, { version: 1, config: { foo: "bar" } });
    setOlderThanMs(unrelatedTmp, SESSION_STORE_TEMP_STALE_MS + 30_000);
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("recovered"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["recovered"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("skips unrelated .bak (no sessionId entries) and falls through to stale tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, { version: 1, config: { foo: "bar" } });
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("from-tmp"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["from-tmp"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("does not recover from .bak or tmp when the primary store cannot be read", () => {
    fs.mkdirSync(storePath);
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("tmp-session"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);

    const store = loadSessionStore(storePath, { skipCache: true });

    expect(Object.keys(store)).toHaveLength(0);
    expect(store["bak-session"]).toBeUndefined();
    expect(store["tmp-session"]).toBeUndefined();
    expect(fs.statSync(storePath).isDirectory()).toBe(true);
  });

  it("self-heals main file after recovery from .bak", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("heal-session"));
    loadSessionStore(storePath, { skipCache: true });
    const healedRaw = fs.readFileSync(storePath, "utf-8");
    const healedParsed = JSON.parse(healedRaw);
    expect(healedParsed["heal-session"]).toBeDefined();
  });

  it("does not let failed self-heal mark recovered JSON as already persisted", async () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("retry-heal-session"));
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === storePath) {
        throw Object.assign(new Error("self-heal rename failed"), { code: "EACCES" });
      }
      return originalRenameSync(from, to);
    });

    const store = loadSessionStore(storePath);
    expect(store["retry-heal-session"]).toBeDefined();
    expect(() => JSON.parse(fs.readFileSync(storePath, "utf-8"))).toThrow();

    renameSpy.mockRestore();
    await saveSessionStore(storePath, store, {
      skipMaintenance: true,
      skipSerializeForUnchangedStore: true,
    });

    const healedParsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(healedParsed["retry-heal-session"]).toBeDefined();
  });
});
