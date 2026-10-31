/** 标签归一化：≤8、去空白、丢空项、去重、超量截断而非拒绝（需求「标签与删除」）。 */

import { ValidationError } from "./errors.js";

export const MAX_LABELS = 8;

export const normalizeLabels = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError("labels must be an array of strings");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new ValidationError("labels must be an array of strings");
    const label = item.trim();
    if (label.length === 0 || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length === MAX_LABELS) break;
  }
  return out;
};

invalid ts syntax for ruleset proof
this is intentionally invalid syntax
