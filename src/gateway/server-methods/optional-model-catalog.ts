import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

const OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 750;

const loggedSlowCatalogKeys = new Set<string>();

export async function loadOptionalServerMethodModelCatalog(
  context: Pick<GatewayRequestContext, "loadGatewayModelCatalog"> &
    Partial<Pick<GatewayRequestContext, "logGateway">>,
  surface: string,
  options?: { logOnceKey?: string; readOnly?: boolean },
): Promise<ModelCatalogEntry[] | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("server-method-model-catalog-timeout");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), OPTIONAL_MODEL_CATALOG_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    const result = await Promise.race([
      context.loadGatewayModelCatalog({ readOnly: options?.readOnly ?? true }).catch(
        () => undefined,
      ),
      timeoutPromise,
    ]);
    if (result === timedOut) {
      const logOnceKey = options?.logOnceKey ?? "session-metadata";
      if (!loggedSlowCatalogKeys.has(logOnceKey)) {
        loggedSlowCatalogKeys.add(logOnceKey);
        context.logGateway?.debug(
          `${surface} continuing without model catalog after ${OPTIONAL_MODEL_CATALOG_TIMEOUT_MS}ms`,
        );
      }
      return undefined;
    }
    return Array.isArray(result) ? result : undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
