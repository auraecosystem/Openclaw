import { randomBytes, timingSafeEqual } from "node:crypto";
import { loadExecApprovals } from "../infra/exec-approvals.js";

let fallbackApprovalRuntimeToken: string | null = null;

function readSharedApprovalRuntimeToken(): string | null {
  const token = loadExecApprovals().socket?.token?.trim();
  return token ? token : null;
}

function tokenMatches(token: string, expected: string | null | undefined): boolean {
  if (!expected) {
    return false;
  }
  const tokenBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return tokenBytes.length === expectedBytes.length && timingSafeEqual(tokenBytes, expectedBytes);
}

export function getOperatorApprovalRuntimeToken(): string {
  const sharedToken = readSharedApprovalRuntimeToken();
  if (sharedToken) {
    return sharedToken;
  }
  fallbackApprovalRuntimeToken ??= randomBytes(32).toString("base64url");
  return fallbackApprovalRuntimeToken;
}

export function isOperatorApprovalRuntimeToken(value: string | null | undefined): boolean {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const sharedToken = readSharedApprovalRuntimeToken();
  if (tokenMatches(token, sharedToken)) {
    return true;
  }
  const fallbackToken =
    fallbackApprovalRuntimeToken ?? (sharedToken ? null : getOperatorApprovalRuntimeToken());
  return tokenMatches(token, fallbackToken);
}
