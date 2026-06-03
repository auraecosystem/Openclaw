import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";

export type SessionTranscriptUpdateTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  targetKind: "active-session-file" | "runtime-session";
};

export type SessionTranscriptUpdate = {
  /** @deprecated File-backed compatibility hint. Prefer `target` for identity. */
  sessionFile?: string;
  target?: SessionTranscriptUpdateTarget;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
          target: update.target,
          sessionKey: update.sessionKey,
          agentId: update.agentId,
          sessionId: update.sessionId,
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
        };
  const trimmed = normalizeOptionalString(normalized.sessionFile);
  const target = normalizeUpdateTarget(normalized);
  if (!trimmed && !target) {
    return;
  }
  const messageSeq = asPositiveSafeInteger(normalized.messageSeq);
  const sessionKey = normalizeOptionalString(normalized.sessionKey) ?? target?.sessionKey;
  const agentId = normalizeOptionalString(normalized.agentId) ?? target?.agentId;
  const sessionId = normalizeOptionalString(normalized.sessionId) ?? target?.sessionId;
  const nextUpdate: SessionTranscriptUpdate = {
    ...(trimmed ? { sessionFile: trimmed } : {}),
    ...(target ? { target } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
  };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}

function normalizeUpdateTarget(update: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  target?: SessionTranscriptUpdate["target"];
}): SessionTranscriptUpdateTarget | undefined {
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey);
  const agentId =
    normalizeOptionalString(update.target?.agentId) ??
    normalizeOptionalString(update.agentId) ??
    (sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined);
  const sessionId =
    normalizeOptionalString(update.target?.sessionId) ?? normalizeOptionalString(update.sessionId);
  const targetKind =
    normalizeTargetKind(update.target?.targetKind) ??
    (agentId && sessionId && sessionKey
      ? normalizeOptionalString(update.sessionFile)
        ? "active-session-file"
        : "runtime-session"
      : undefined);
  if (!agentId || !sessionId || !sessionKey || !targetKind) {
    return undefined;
  }
  return {
    agentId,
    sessionId,
    sessionKey,
    targetKind,
  };
}

function normalizeTargetKind(
  value: SessionTranscriptUpdateTarget["targetKind"] | undefined,
): SessionTranscriptUpdateTarget["targetKind"] | undefined {
  return value === "active-session-file" || value === "runtime-session" ? value : undefined;
}
