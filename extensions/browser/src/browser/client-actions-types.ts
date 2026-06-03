import type { AnnotationItem } from "./screenshot-annotate.js";

export type BrowserActionOk = { ok: true };

export type BrowserActionTabResult = {
  ok: true;
  targetId: string;
  url?: string;
};

export type BrowserActionPathResult = {
  ok: true;
  path: string;
  targetId: string;
  url?: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
  /**
   * Per-ref bounding boxes when labels=true. Coordinates are in the
   * captured image's space (viewport / fullpage / element-relative).
   * Omitted when empty.
   */
  annotations?: AnnotationItem[];
};
