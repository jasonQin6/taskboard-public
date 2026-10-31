/**
 * source unit 的字节级读取：冻结当轮 EOF、只认完整换行记录、prefix/tail hash 与重写检测（需求「增量与恢复」）。
 * .jsonl.zst 以解压后的字节流为逻辑流；游标（consumed bytes）定义在逻辑流上。
 */

import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { open } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

export const PREFIX_WINDOW = 4096;
export const TAIL_WINDOW = 8192;

export const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface OpenUnit {
  /** 逻辑流总长（plain = 打开时刻的文件大小即当轮冻结 EOF；zst = 解压后长度）。 */
  logicalSize: number;
  readSlice(start: number, end: number): Buffer;
  close(): Promise<void>;
}

export const openUnit = async (path: string, zst: boolean): Promise<OpenUnit> => {
  const handle = await open(path, "r");
  try {
    if (!zst) {
      // 冻结当轮可见 EOF：打开时刻的大小，之后追加留给下一轮
      const logicalSize = (await handle.stat()).size;
      return {
        logicalSize,
        readSlice: (start, end) => {
          const buf = Buffer.alloc(Math.max(0, end - start));
          // readSync 可能短读（EINTR/并发截断）：NUL 垫尾会被当成内容解析并污染游标，必须填满或抛
          let offset = 0;
          while (offset < buf.length) {
            const read = readSync(handle.fd, buf, offset, buf.length - offset, start + offset);
            if (read <= 0) throw new Error(`short read at offset ${start + offset}: wanted ${buf.length - offset}, got ${read}`);
            offset += read;
          }
          return buf;
        },
        close: () => handle.close(),
      };
    }
    // 归档会话压缩件体积有限：一次性解压成逻辑流，后续增量都在这段缓冲上切片
    const compressed = await handle.readFile();
    const data = zstdDecompressSync(compressed);
    return {
      logicalSize: data.length,
      readSlice: (start, end) => data.subarray(start, end),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

export interface RawLine {
  line: string;
  byteStart: number;
}

/**
 * 从字节区域切完整换行记录；最后一个 \n 之后的内容（半行）不属于本轮，返回值 completeBytes
 * 是可以安全提交的消费位（相对 region 起点的偏移）。
 */
export const splitCompleteLines = (
  region: Buffer,
  regionStart: number,
): { records: RawLine[]; completeBytes: number } => {
  const lastNewline = region.lastIndexOf(0x0a);
  if (lastNewline === -1) return { records: [], completeBytes: 0 };
  const records: RawLine[] = [];
  let start = 0;
  for (let i = 0; i <= lastNewline; i += 1) {
    if (region[i] === 0x0a) {
      const line = region.subarray(start, i).toString("utf8");
      if (line.trim().length > 0) records.push({ line, byteStart: regionStart + start });
      start = i + 1;
    }
  }
  return { records, completeBytes: lastNewline + 1 };
};
