import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
} from "./archive-install.js";

const tempDirs = createTrackedTempDirs();

async function writeZipArchive(params: {
  archivePath: string;
  entries: Record<string, string>;
}): Promise<void> {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(params.entries)) {
    zip.file(entryPath, content);
  }
  await fs.writeFile(
    params.archivePath,
    Buffer.from(await zip.generateAsync({ type: "nodebuffer" })),
  );
}

async function isCaseSensitiveFileSystem(root: string): Promise<boolean> {
  const marker = path.join(root, "case-check");
  await fs.writeFile(marker, "case", "utf8");
  const upperExists = await fs
    .stat(path.join(root, "CASE-CHECK"))
    .then(() => true)
    .catch(() => false);
  return !upperExists;
}

async function expectFlatRootMarkerRejected(params: {
  marker: string;
  root: string;
}): Promise<void> {
  const archivePath = path.join(params.root, `flat-${params.marker}.zip`);
  await writeZipArchive({
    archivePath,
    entries: {
      [params.marker]: skillFileContent("Flat Legacy Marker"),
    },
  });

  const result = await withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-skill-clawhub-test-",
    timeoutMs: 120_000,
    rootMarkers: ["SKILL.md"],
    onExtracted: async () => ({ ok: true as const }),
  });

  expect(result).toEqual({
    ok: false,
    error: "Error: unexpected archive layout (dirs: )",
  });
}

function skillFileContent(name: string): string {
  return ["---", `name: ${name}`, "description: Test skill", "---", "", "# Test", ""].join("\n");
}

function setupSkillFileContent(name: string, script: string): string {
  const metadata = JSON.stringify({ openclaw: { setup: { script } } });
  return [
    "---",
    `name: ${name}`,
    "description: Test skill",
    `metadata: '${metadata}'`,
    "---",
    "",
    "# Test",
    "",
  ].join("\n");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("skill archive install", () => {
  it.each(["skill.md", "skills.md", "SKILL.MD"])(
    "installs a single-root ClawHub archive with legacy marker %s",
    async (marker) => {
      const root = await tempDirs.make("openclaw-skill-archive-install-");
      const archivePath = path.join(root, "legacy.zip");
      const workspaceDir = path.join(root, "workspace");
      await writeZipArchive({
        archivePath,
        entries: {
          [`mydir/${marker}`]: skillFileContent("Legacy Marker"),
        },
      });

      const result = await withExtractedArchiveRoot({
        archivePath,
        tempDirPrefix: "openclaw-skill-clawhub-test-",
        timeoutMs: 120_000,
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
        onExtracted: async (extractedRoot) =>
          await installExtractedSkillRoot({
            workspaceDir,
            slug: `legacy-${marker.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            extractedRoot,
            mode: "install",
            scan: false,
            rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
          }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      await expect(fs.readFile(path.join(result.targetDir, marker), "utf8")).resolves.toContain(
        "Legacy Marker",
      );
    },
  );

  it("keeps flat-root non-SKILL.md legacy markers rejected by strict packed-root resolution", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    await expectFlatRootMarkerRejected({ marker: "skills.md", root });
  });

  it("keeps flat-root lowercase skill.md rejected by strict packed-root resolution on case-sensitive filesystems", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const caseSensitive = await isCaseSensitiveFileSystem(root);
    if (!caseSensitive) {
      expect(caseSensitive).toBe(false);
      return;
    }
    await expectFlatRootMarkerRejected({ marker: "skill.md", root });
  });

  it("keeps archive setup hooks disabled by default", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const extractedRoot = path.join(root, "source-skill");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(path.join(extractedRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      setupSkillFileContent("Setup Skill", "scripts/setup.sh"),
      "utf8",
    );
    await fs.writeFile(
      path.join(extractedRoot, "scripts", "setup.sh"),
      '#!/bin/sh\nprintf "%s" "$OPENCLAW_HOOK_KIND" > setup-output.txt\n',
      "utf8",
    );
    await fs.chmod(path.join(extractedRoot, "scripts", "setup.sh"), 0o755);

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "setup-skill",
      extractedRoot,
      mode: "install",
      scan: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    await expect(fs.stat(path.join(result.targetDir, "setup-output.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs archive setup hooks only when explicitly allowed", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const extractedRoot = path.join(root, "source-skill");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(path.join(extractedRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      setupSkillFileContent("Setup Skill", "scripts/setup.sh"),
      "utf8",
    );
    await fs.writeFile(
      path.join(extractedRoot, "scripts", "setup.sh"),
      '#!/bin/sh\nprintf "%s" "$OPENCLAW_HOOK_KIND" > setup-output.txt\n',
      "utf8",
    );
    await fs.chmod(path.join(extractedRoot, "scripts", "setup.sh"), 0o755);

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "setup-skill",
      extractedRoot,
      mode: "install",
      scan: false,
      allowSetupHooks: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    await expect(
      fs.readFile(path.join(result.targetDir, "setup-output.txt"), "utf8"),
    ).resolves.toBe("install");
  });
});
