/**
 * 日志正文（llm_logs.req_body/resp_body、mcp_logs.request_body/response_body）的存储编码。
 * 写入：base64 data URI 换成占位符后 gzip，落库为 BLOB；读取：BLOB 解压回文本。
 * 未压缩的历史 TEXT 行原样返回。CompressionStream 在 Node 与 Workers 都可用（Workers 不支持 zstd）。
 */

const DATA_URI_RE = /data:([\w.+-]+\/[\w.+-]+)((?:;[\w.+-]+=[\w.+-]+)*);base64,([A-Za-z0-9+/]+=*)/g

function omitDataUris(text: string): string {
  return text.replace(DATA_URI_RE, (_match, mime: string, params: string, payload: string) =>
    `data:${mime}${params};base64,[omitted ${payload.length} chars]`,
  )
}

/** 正文 → gzip BLOB；null/undefined → NULL */
export async function packLogBody(text: string | null | undefined): Promise<Uint8Array | null> {
  if (text == null) return null
  const stream = new Blob([omitDataUris(text)]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 库中值 → 文本：node:sqlite 的 BLOB 为 Uint8Array，D1 为 number[]；历史 TEXT 行直接返回 */
export async function unpackLogBody(value: unknown): Promise<string | null> {
  if (value == null) return null
  if (typeof value === 'string') return value
  // node:sqlite 的 BLOB 不是 SharedArrayBuffer，收窄类型以满足 BlobPart，避免拷贝
  const bytes = (value instanceof Uint8Array ? value : Uint8Array.from(value as number[])) as Uint8Array<ArrayBuffer>
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}
