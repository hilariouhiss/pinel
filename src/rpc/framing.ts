/**
 * 严格 JSONL framing（协议硬要求）：
 * - 只用 `\n`（LF）切分记录；容忍尾部 `\r`（接受 \r\n）。
 * - 禁止使用 Node `readline`：它会把 U+2028 / U+2029 当作换行，
 *   而它们是 JSON 字符串内的合法字符，会破坏记录边界。
 */

export class JsonlDecoder {
  private buffer = "";

  /**
   * 追加一段数据，返回其中所有完整记录（原始字符串）。
   * 不完整的尾部保留在内部缓冲区，等待下次 push。
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const records: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      // 容忍 \r\n：去掉尾部 \r
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        records.push(line);
      }
    }
    return records;
  }
}

/** 编码一条记录为协议帧（LF 结尾，无 \r）。 */
export function encodeRecord(record: unknown): string {
  return JSON.stringify(record) + "\n";
}
