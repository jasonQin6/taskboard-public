import { createHash } from "node:crypto";

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const stable = (value: unknown): string => JSON.stringify(value);

/** 相同计数不同插入顺序必须是同一指纹；JSON.stringify 保留对象键序。 */
const canonicalStatusCounts = (counts: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

export interface FingerprintInput {
  nativeStatus: string;
  title: string | null;
  workspace: string | null;
  cursor: readonly [string, number, string, string | null, number] | null;
  turnsTotal: number;
  turnsByStatus: Readonly<Record<string, number>>;
  latestOrdinal: number | null;
  latestNativeStatus: string | null;
  evidence: ReadonlyArray<
    readonly [string, string, number | null, string | null, string]
  >;
  summary: readonly [string, string, number | null] | null;
  overlay: readonly [string | null, string | null, readonly string[], ReadonlyArray<readonly [string, string, string]>];
}

export const SYSTEMONE_FINGERPRINT_VERSION = 1;

export const evidenceFingerprintOf = (input: FingerprintInput): string =>
  hash(
    stable({
      v: SYSTEMONE_FINGERPRINT_VERSION,
      nativeStatus: input.nativeStatus,
      title: input.title,
      workspace: input.workspace,
      cursor: input.cursor,
      turns: [
        input.turnsTotal,
        canonicalStatusCounts(input.turnsByStatus),
        input.latestOrdinal,
        input.latestNativeStatus,
      ],
      evidence: input.evidence,
      summary: input.summary,
      overlay: input.overlay,
    }),
  );

export const systemoneCacheKeyOf = (params: {
  fingerprint: string;
  provider: string;
  model: string;
  promptVersion: string;
  questionVersion: string;
}): string =>
  hash(
    [params.fingerprint, params.provider, params.model, params.promptVersion, params.questionVersion].join("\n"),
  );

export const systemoneVersionKeyOf = (params: {
  provider: string;
  model: string;
  promptVersion: string;
  questionVersion: string;
}): string => [params.provider, params.model, params.promptVersion, params.questionVersion].join("|");
