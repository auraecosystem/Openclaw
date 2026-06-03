import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
} from "../internal-events.js";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../internal-runtime-context.js";
import type { AgentCommandOpts } from "./types.js";

export type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  clearedFields?: string[];
  shouldPersist?: (entry: SessionEntry | undefined) => boolean;
};

export async function persistSessionEntry(
  params: PersistSessionEntryParams,
): Promise<SessionEntry | undefined> {
  let rejectedMissingEntry = false;
  const persisted = await patchSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      if (params.shouldPersist && !params.shouldPersist(context.existingEntry)) {
        rejectedMissingEntry = !context.existingEntry;
        return null;
      }
      const merged = mergeSessionEntry(context.existingEntry, params.entry);
      for (const field of params.clearedFields ?? []) {
        if (!Object.hasOwn(params.entry, field)) {
          Reflect.deleteProperty(merged, field);
        }
      }
      return merged;
    },
    {
      fallbackEntry: params.sessionStore[params.sessionKey] ?? params.entry,
      replaceEntry: true,
    },
  );
  if (rejectedMissingEntry) {
    delete params.sessionStore[params.sessionKey];
    return undefined;
  }
  if (persisted) {
    params.sessionStore[params.sessionKey] = persisted;
  } else {
    delete params.sessionStore[params.sessionKey];
  }
  return persisted ?? undefined;
}

export function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (hasInternalRuntimeContext(body)) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

function resolvePlainInternalEventBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  const renderedEvents = formatAgentInternalEventsForPlainPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  const visibleBody = stripInternalRuntimeContext(body).trim();
  return [renderedEvents, visibleBody].filter(Boolean).join("\n\n") || body;
}

export function resolveAcpPromptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  return events?.length ? resolvePlainInternalEventBody(body, events) : body;
}

export function resolveInternalEventTranscriptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (!hasInternalRuntimeContext(body)) {
    return body;
  }
  return resolvePlainInternalEventBody(body, events);
}
