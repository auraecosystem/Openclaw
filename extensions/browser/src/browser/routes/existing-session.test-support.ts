import { vi } from "vitest";
import {
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRequest } from "./types.js";

function errorStatus(err: unknown): number {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : 500;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const existingSessionRouteState = {
  cdpUrl: "http://127.0.0.1:18800",
  profileCtx: {
    profile: {
      driver: "existing-session" as const,
      name: "chrome-live",
    },
    listTabs: vi.fn(async () => [
      {
        targetId: "7",
        url: "https://example.com",
      },
    ]),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "7",
      url: "https://example.com",
    })),
  },
  tab: {
    targetId: "7",
    url: "https://example.com",
  },
};

export function createExistingSessionAgentSharedModule() {
  return {
    getPwAiModule: vi.fn(async () => null),
    handleRouteError: vi.fn(),
    readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
    requirePwAi: vi.fn(async () => {
      throw new Error("Playwright should not be used for existing-session tests");
    }),
    resolveProfileContext: vi.fn(() => existingSessionRouteState.profileCtx),
    resolveTargetIdFromBody: vi.fn((body: Record<string, unknown>) =>
      typeof body.targetId === "string" ? body.targetId : undefined,
    ),
    resolveTargetIdFromQuery: vi.fn((query: Record<string, unknown>) =>
      typeof query.targetId === "string" ? query.targetId : undefined,
    ),
    withPlaywrightRouteContext: vi.fn(),
    withRouteTabContext: vi.fn(
      async ({
        ctx,
        res,
        enforceCurrentUrlAllowed,
        run,
      }: {
        ctx: BrowserRouteContext;
        res: { status: (code: number) => { json: (body: unknown) => void } };
        enforceCurrentUrlAllowed?: boolean;
        run: (args: unknown) => Promise<void>;
      }) => {
        try {
          if (enforceCurrentUrlAllowed) {
            const ssrfPolicyOpts = withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy);
            if (ssrfPolicyOpts.ssrfPolicy) {
              await assertBrowserNavigationResultAllowed({
                url: existingSessionRouteState.tab.url,
                ...ssrfPolicyOpts,
              });
            }
          }
          await run({
            profileCtx: existingSessionRouteState.profileCtx,
            cdpUrl: existingSessionRouteState.cdpUrl,
            tab: existingSessionRouteState.tab,
            resolveTabUrl: vi.fn(async (fallbackUrl?: string) => fallbackUrl ?? routeStateUrl()),
          });
        } catch (err) {
          res.status(errorStatus(err)).json({ error: errorMessage(err) });
        }
      },
    ),
  };
}

function routeStateUrl() {
  return existingSessionRouteState.tab.url;
}
