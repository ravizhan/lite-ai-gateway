/**
 * sse-tap：字节透传 + usage 观察。
 * - TransformStream 零改写透传（chunk 原样 enqueue）；
 * - chat：原始字节追加进定长 64KB 环形尾缓冲（append 只拷贝入参字节，O(chunk)），
 *   流结束后一次性解码解析（CPU O(64KB)，与流长无关）；
 * - responses：每个 chunk 增量喂给 responses-usage 的 SSE/JSON 状态机，只捕获顶层 type
 *   与终止事件里的 response.usage；大事件、大字符串不缓存，内存与流长无关；
 * - 记录首个 chunk 到达时刻（relay 用它减上游发起时刻得到 TTFT）；
 * - 由 tap 自己持有 source.pipeTo(writable)（比 pipeThrough 更稳）：正常结束由 flush 解析；
 *   断流时 pipeTo reject，但老版本 Workers 上客户端取消可能让 pipeTo 在 flush 未执行的情况下
 *   直接 resolve，故 resolve/reject 都挂同一兜底回调，finish() 只 settle 一次。
 * 解析失败/无 usage → usageRaw null、error 为普通文本（不掩码，由 relay 落库前 sanitize）。
 * 观察失败不影响已 enqueue 的字节，也不中止转发。
 */

import { createResponsesUsageObserver } from './responses-usage.ts'

export interface SseTapResult {
  stream: TransformStream<Uint8Array, Uint8Array>
  /** 首个 chunk 到达时刻（performance.now()），未收到任何字节时为 null */
  firstChunkAt: () => number | null
  /** 流结束后返回观察到的用量；只 settle 一次 */
  finish: () => Promise<{ usageRaw: unknown | null; error: string | null }>
}

const MAX_TAIL = 64 * 1024 // 尾部缓冲上限 64KB

const EMPTY = new Uint8Array(0)

/** 非流式 decode 无状态，共享解码器避免每流分配 */
const decoder = new TextDecoder()

/**
 * 定长字节环形缓冲（容量 MAX_TAIL）：空间常数，append 只拷贝入参中会被保留的字节；
 * 底层数组在首个非空 chunk 到达时才分配（空流零分配）。
 */
class TailRing {
  private buf: Uint8Array | null = null
  private start = 0 // 最旧字节在 buf 中的下标
  private len = 0 // 有效字节数（≤ MAX_TAIL）

  /** 追加一个 chunk，只保留最后 MAX_TAIL 字节；丢弃的前缀不拷贝 */
  append(chunk: Uint8Array): void {
    const n = chunk.byteLength
    if (n === 0) return
    const buf = this.buf ?? (this.buf = new Uint8Array(MAX_TAIL))
    if (n >= MAX_TAIL) {
      // 单块 ≥ 容量：只拷最后 MAX_TAIL 字节，前缀直接丢弃
      buf.set(chunk.subarray(n - MAX_TAIL))
      this.start = 0
      this.len = MAX_TAIL
      return
    }
    let w = this.start + this.len // 写入位置（逻辑尾，可能等于 MAX_TAIL）
    if (w >= MAX_TAIL) w -= MAX_TAIL
    const head = MAX_TAIL - w // 写到数组尾之前可容纳的字节数
    if (n <= head) {
      buf.set(chunk, w)
    } else {
      // 回绕：尾段 + 数组头部分两段写入
      buf.set(chunk.subarray(0, head), w)
      buf.set(chunk.subarray(head), 0)
    }
    this.len += n
    if (this.len > MAX_TAIL) {
      // 覆盖最旧的 this.len - MAX_TAIL 个字节
      this.start += this.len - MAX_TAIL
      if (this.start >= MAX_TAIL) this.start -= MAX_TAIL
      this.len = MAX_TAIL
    }
  }

  /** 尾部字节视图：未回绕时零拷贝 subarray；回绕时拷一次（≤64KB，仅流结束时） */
  view(): Uint8Array {
    const buf = this.buf
    if (buf === null || this.len === 0) return EMPTY
    if (this.start + this.len <= MAX_TAIL) return buf.subarray(this.start, this.start + this.len)
    const out = new Uint8Array(this.len)
    const head = MAX_TAIL - this.start
    out.set(buf.subarray(this.start), 0)
    out.set(buf.subarray(0, this.len - head), head)
    return out
  }
}

/**
 * 一次性解码尾缓冲，从后往前扫 data: 帧提取 usage：
 * 取含 `usage` 键的对象（客户端带 stream_options.include_usage 时 usage 在倒数第二帧）。
 * 单个 data 行 JSON 解析失败（尾缓冲截断属正常）跳过继续找；全程无 usage 且有过解析失败 → error。
 */
function parseChatTail(tail: Uint8Array): { usageRaw: unknown | null; error: string | null } {
  if (tail.byteLength === 0) return { usageRaw: null, error: null }
  const text = decoder.decode(tail).replace(/\r\n/g, '\n')
  const frames = text.split('\n\n')
  let sawParseError = false
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]
    if (!frame.includes('data:')) continue
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let obj: unknown
      try {
        obj = JSON.parse(payload)
      } catch {
        sawParseError = true // 截断的不完整帧，跳过继续找
        continue
      }
      if (typeof obj === 'object' && obj !== null && 'usage' in obj) {
        return { usageRaw: (obj as Record<string, unknown>).usage, error: null }
      }
    }
  }
  return { usageRaw: null, error: sawParseError ? 'SSE usage parse failed' : null }
}

/** 协议专属观察器：write 逐 chunk 收集，end 在流结束后一次性给出用量 */
interface UsageSink {
  write(chunk: Uint8Array): void
  end(): { usageRaw: unknown | null; error: string | null }
}

function createUsageSink(protocol: 'chat' | 'responses'): UsageSink {
  if (protocol === 'chat') {
    const tail = new TailRing()
    return {
      write: (chunk) => tail.append(chunk),
      end: () => parseChatTail(tail.view()),
    }
  }
  const observer = createResponsesUsageObserver()
  return {
    write: (chunk) => observer.write(chunk),
    end: () => observer.end(),
  }
}

export function createSseTap(
  protocol: 'chat' | 'responses',
  source: ReadableStream<Uint8Array>,
): SseTapResult {
  const sink = createUsageSink(protocol)
  let firstChunkMs: number | null = null
  let settled = false
  let resolveFinish!: (r: { usageRaw: unknown | null; error: string | null }) => void
  const finished = new Promise<{ usageRaw: unknown | null; error: string | null }>((r) => {
    resolveFinish = r
  })

  const settle = (r: { usageRaw: unknown | null; error: string | null }): void => {
    if (settled) return
    settled = true
    resolveFinish(r)
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (firstChunkMs === null) firstChunkMs = performance.now() // TTFT
      controller.enqueue(chunk) // 字节透传，零改写
      // 观察在 enqueue 之后：解析问题绝不阻塞或破坏转发
      sink.write(chunk)
    },
    flush() {
      // 正常结束（source 关闭）：chat 解析尾缓冲；responses 冲刷解码器与最后一帧
      try {
        settle(sink.end())
      } catch (err) {
        settle({ usageRaw: null, error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  // 断流/取消：pipeTo reject（writable 被 abort，flush 不执行）→ 兜底 settle。
  // 老版本 Workers 上取消也可能让 pipeTo resolve 而 flush 未执行，故两个分支挂同一回调；
  // 正常结束已由 flush settle，兜底先查 settled，避免成功路径上的多余对象分配。
  const interrupted = (): void => {
    if (settled) return
    settle({ usageRaw: null, error: 'upstream stream interrupted' })
  }
  void source.pipeTo(stream.writable).then(interrupted, interrupted)

  return {
    stream,
    firstChunkAt: () => firstChunkMs,
    finish: () => finished,
  }
}
