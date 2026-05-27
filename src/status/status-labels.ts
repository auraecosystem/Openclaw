import type { FastMode } from "../shared/string-coerce.js";

export const formatFastModeLabel = (mode: FastMode): string =>
  `Fast: ${mode === "auto" ? "auto" : mode ? "on" : "off"}`;
