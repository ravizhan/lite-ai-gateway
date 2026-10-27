/**
 * Responses API 流式 usage 提取。
 *
 * 上游字节流按 SSE 规则增量切帧，帧内 data 直接喂给增量 JSON 扫描器：
 * - 只跟踪结构（容器栈 + 词法状态），按固定路径捕获顶层 `type` 与 `response.usage`
 *   里的数值字段；其余值（output / encrypted_content / delta 等大字符串）逐字符跳过，
 *   不缓存整行、整个事件或任何正文；
 * - 只保留容器栈、短键名/类型和当前用量数字，不随输出正文长度增长；
 * - 只接受 response.completed / response.incomplete / response.failed，后出现的终止事件覆盖前者；
 * - 不符合 JSON 或截断的事件不产生 usage；全程没有终止事件且出现过解析失败 →
 *   'SSE usage parse failed'；
 * - 正常 EOF 允许最后一帧没有结尾空行（完整 JSON 仍被接受）；[DONE] 不算解析失败。
 *
 * 这里只服务 Responses 协议，不追求通用 JSON 解析框架。
 */

const MAX_KEY = 32 // 捕获的 key 上限（超出即视为不匹配任何目标字段）
const MAX_TYPE = 64 // 捕获的 type 上限（超出即视为无 type）
const MAX_FIELD = 8 // SSE 字段名上限（只需容纳 data/event/id/retry）
const MAX_HEAD = 8 // 事件 data 前缀上限，用于识别 [DONE]

const PARSE_FAILED = 'SSE usage parse failed'

/** JSON 扫描状态 */
const S_ROOT = 0 // 期待根值
const S_KEY = 1 // 对象逗号后：必须有 key
const S_COLON = 2 // 期待 ':'
const S_VALUE = 3 // 期待值
const S_COMMA = 4 // 对象内：期待 ',' 或 '}'
const S_ARRAY = 5 // 数组内：期待值或 ']'
const S_ARRAY_COMMA = 6 // 数组内：期待 ',' 或 ']'
const S_STRING = 7
const S_NUMBER = 8
const S_LITERAL = 9
const S_DONE = 10
const S_ERROR = 11
const S_FIRST_KEY = 12 // 对象开头：允许空对象

/** 容器种类：只标记目标路径上的对象，其余对象/数组一视同仁 */
const K_OTHER = 0
const K_ARRAY = 1
const K_ROOT = 2
const K_RESPONSE = 3
const K_USAGE = 4
const K_DETAILS = 5

/** 字符串角色 */
const R_SKIP = 0
const R_KEY = 1
const R_TYPE = 2
const R_KEY_SKIP = 3 // 不在目标路径上的对象 key：直接丢弃，避免无谓分配

/** 数字捕获目标 */
const N_NONE = 0
const N_INPUT = 1
const N_OUTPUT = 2
const N_TOTAL = 3
const N_CACHED = 4

/** 数字词法状态：1='-' 后 2=前导 0 3=整数位 4='.' 后 5=小数位 6=e 后 7=指数符号 8=指数位 */
const NUM_INT = 1
const NUM_ZERO = 2
const NUM_DIGITS = 3
const NUM_DOT = 4
const NUM_FRAC = 5
const NUM_E = 6
const NUM_ESIGN = 7
const NUM_EDIGITS = 8

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  return -1
}

/**
 * 增量 JSON 扫描器：验证 JSON 语法的同时，只在固定路径上收集
 * 顶层 `type`（字符串）与 `response.usage` 的数值字段。
 * 每个事件复用同一实例（reset 只清长度/引用，不重新分配）。
 */
class UsageJsonScanner {
  private state = S_ROOT
  /** 容器栈：kinds[i] 是第 i 层容器种类，keys[i] 是该层对象当前的 key */
  private kinds: number[] = []
  private keys: string[] = []

  private typeValue: string | null = null
  private usage: Record<string, unknown> | null = null
  private details: Record<string, unknown> | null = null

  private strRole = R_SKIP
  private strBuf = ''
  private strOverflow = false
  private esc = 0 // 0 普通；1 反斜杠后；2..5 \u 的十六进制位
  private hex = 0

  private numState = 0
  private numBuf = ''
  private numTarget = N_NONE

  private lit = ''
  private litAt = 0

  reset(): void {
    this.state = S_ROOT
    this.kinds.length = 0
    this.keys.length = 0
    this.typeValue = null
    this.usage = null
    this.details = null
    this.numTarget = N_NONE
    this.numBuf = ''
  }

  /** 根值已完整解析且未出现语法错误 */
  isComplete(): boolean {
    return this.state === S_DONE
  }

  getType(): string | null {
    return this.typeValue
  }

  getUsage(): Record<string, unknown> | null {
    return this.usage
  }

  feedChar(c: number): void {
    switch (this.state) {
      case S_STRING:
        this.stringChar(c)
        return
      case S_NUMBER:
        this.numberChar(c)
        return
      case S_LITERAL:
        this.literalChar(c)
        return
      case S_ERROR:
        return
      case S_DONE:
        // 根值之后只允许空白；其它字符说明帧不合法
        if (!isWs(c)) this.state = S_ERROR
        return
      default:
        break
    }
    // 其余状态都是「token 之间」，JSON 允许任意空白
    if (isWs(c)) return
    switch (this.state) {
      case S_ROOT:
      case S_VALUE:
        this.beginValue(c)
        return
      case S_FIRST_KEY:
      case S_KEY:
        if (c === 34) this.beginString(this.stringRole())
        else if (c === 125 && this.state === S_FIRST_KEY) this.closeContainer()
        else this.state = S_ERROR
        return
      case S_COLON:
        if (c === 58) this.state = S_VALUE
        else this.state = S_ERROR
        return
      case S_COMMA:
        if (c === 44) this.state = S_KEY
        else if (c === 125) this.closeContainer()
        else this.state = S_ERROR
        return
      case S_ARRAY:
        if (c === 93) this.closeContainer()
        else this.beginValue(c)
        return
      case S_ARRAY_COMMA:
        if (c === 44) this.state = S_VALUE
        else if (c === 93) this.closeContainer()
        else this.state = S_ERROR
        return
      default:
        this.state = S_ERROR
    }
  }

  private beginValue(c: number): void {
    this.clearPreviousValue()
    if (c === 123) {
      // '{'：只有根对象与目标路径上的对象需要打标记
      this.openContainer(this.state === S_ROOT ? K_ROOT : this.objectKind())
      return
    }
    if (c === 91) {
      this.openContainer(K_ARRAY)
      return
    }
    if (c === 34) {
      this.beginString(this.stringRole())
      return
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      this.beginNumber(c)
      return
    }
    if (c === 116) this.beginLiteral('true')
    else if (c === 102) this.beginLiteral('false')
    else if (c === 110) this.beginLiteral('null')
    else this.state = S_ERROR
  }

  /** 每个同名字段都覆盖前值，包括 null、字符串和其它非预期类型。 */
  private clearPreviousValue(): void {
    if (this.state !== S_VALUE) return
    const depth = this.kinds.length
    const parent = this.kinds[depth - 1]
    const key = this.keys[depth - 1]
    if (parent === K_ROOT && key === 'type') this.typeValue = null
    if (
      (parent === K_ROOT && key === 'response') ||
      (parent === K_RESPONSE && key === 'usage')
    ) {
      this.usage = null
      this.details = null
    } else if (parent === K_USAGE && this.usage !== null) {
      delete this.usage[key]
      if (key === 'input_tokens_details') this.details = null
    } else if (parent === K_DETAILS && key === 'cached_tokens' && this.details !== null) {
      delete this.details.cached_tokens
    }
  }

  /** 当前值所在对象路径决定新对象的种类（仅 S_VALUE 有意义） */
  private objectKind(): number {
    if (this.state !== S_VALUE) return K_OTHER
    const depth = this.kinds.length
    const parent = this.kinds[depth - 1]
    const key = this.keys[depth - 1]
    if (parent === K_ROOT && key === 'response') return K_RESPONSE
    if (parent === K_RESPONSE && key === 'usage') return K_USAGE
    if (parent === K_USAGE && key === 'input_tokens_details') return K_DETAILS
    return K_OTHER
  }

  private openContainer(kind: number): void {
    this.kinds.push(kind)
    this.keys.push('')
    if (kind === K_USAGE) {
      // 同名 usage 重复出现时按 JSON 语义后者覆盖前者
      this.usage = {}
      this.details = null
    } else if (kind === K_DETAILS) {
      const d: Record<string, unknown> = {}
      this.details = d
      if (this.usage !== null) this.usage.input_tokens_details = d
    }
    this.state = kind === K_ARRAY ? S_ARRAY : S_FIRST_KEY
  }

  private closeContainer(): void {
    this.kinds.pop()
    this.keys.pop()
    this.afterValue()
  }

  /** 一个值结束：父容器进入「逗号或结束」状态；栈空则根值结束 */
  private afterValue(): void {
    if (this.kinds.length === 0) {
      this.state = S_DONE
      return
    }
    this.state = this.kinds[this.kinds.length - 1] === K_ARRAY ? S_ARRAY_COMMA : S_COMMA
  }

  private stringRole(): number {
    if (this.state === S_KEY || this.state === S_FIRST_KEY) {
      const parent = this.kinds[this.kinds.length - 1]
      // 只有可能通向 type / usage 的对象才需要保留 key
      return parent === K_OTHER || parent === K_ARRAY ? R_KEY_SKIP : R_KEY
    }
    if (
      this.state === S_VALUE &&
      this.kinds.length === 1 &&
      this.kinds[0] === K_ROOT &&
      this.keys[0] === 'type'
    ) {
      return R_TYPE
    }
    return R_SKIP
  }

  private beginString(role: number): void {
    this.state = S_STRING
    this.strRole = role
    this.strBuf = ''
    this.strOverflow = false
    this.esc = 0
  }

  private stringChar(c: number): void {
    if (this.esc !== 0) {
      this.escapeChar(c)
      return
    }
    if (c === 34) {
      this.endString()
      return
    }
    if (c === 92) {
      this.esc = 1
      return
    }
    if (c < 32) {
      this.state = S_ERROR // 字符串内未转义的控制字符
      return
    }
    this.appendString(c)
  }

  private escapeChar(c: number): void {
    const esc = this.esc
    if (esc === 1) {
      switch (c) {
        case 34: // "
        case 92: // backslash
        case 47: // /
          this.appendString(c)
          this.esc = 0
          return
        case 98: // b
          this.appendString(8)
          this.esc = 0
          return
        case 102: // f
          this.appendString(12)
          this.esc = 0
          return
        case 110: // n
          this.appendString(10)
          this.esc = 0
          return
        case 114: // r
          this.appendString(13)
          this.esc = 0
          return
        case 116: // t
          this.appendString(9)
          this.esc = 0
          return
        case 117: // u
          this.esc = 2
          this.hex = 0
          return
        default:
          this.state = S_ERROR
          return
      }
    }
    const v = hexVal(c)
    if (v < 0) {
      this.state = S_ERROR
      return
    }
    this.hex = this.hex * 16 + v
    if (esc < 5) {
      this.esc = esc + 1
      return
    }
    this.appendString(this.hex)
    this.esc = 0
  }

  private appendString(c: number): void {
    const role = this.strRole
    if (role !== R_KEY && role !== R_TYPE) return // 非捕获字符串：逐字符丢弃
    const cap = role === R_KEY ? MAX_KEY : MAX_TYPE
    if (this.strBuf.length >= cap) {
      this.strOverflow = true
      return
    }
    this.strBuf += String.fromCharCode(c)
  }

  private endString(): void {
    if (this.strRole === R_KEY) {
      this.keys[this.keys.length - 1] = this.strOverflow ? '' : this.strBuf
      this.state = S_COLON
      return
    }
    if (this.strRole === R_KEY_SKIP) {
      this.keys[this.keys.length - 1] = ''
      this.state = S_COLON
      return
    }
    if (this.strRole === R_TYPE) this.typeValue = this.strOverflow ? null : this.strBuf
    this.afterValue()
  }

  private numberTarget(): number {
    if (this.state !== S_VALUE) return N_NONE
    const depth = this.kinds.length
    const parent = this.kinds[depth - 1]
    const key = this.keys[depth - 1]
    if (parent === K_USAGE) {
      if (key === 'input_tokens') return N_INPUT
      if (key === 'output_tokens') return N_OUTPUT
      if (key === 'total_tokens') return N_TOTAL
    } else if (parent === K_DETAILS && key === 'cached_tokens') {
      return N_CACHED
    }
    return N_NONE
  }

  private beginNumber(c: number): void {
    this.numTarget = this.numberTarget()
    this.state = S_NUMBER
    this.numBuf = ''
    this.numState = c === 45 ? NUM_INT : c === 48 ? NUM_ZERO : NUM_DIGITS
    this.numAppend(c)
  }

  private numAppend(c: number): void {
    if (this.numTarget === N_NONE) return
    this.numBuf += String.fromCharCode(c)
  }

  private numberChar(c: number): void {
    const st = this.numState
    const d = c - 48
    if (d >= 0 && d <= 9) {
      if (st === NUM_INT) this.numState = d === 0 ? NUM_ZERO : NUM_DIGITS
      else if (st === NUM_ZERO) {
        this.state = S_ERROR // 前导 0 后不能再跟数字
        return
      } else if (st === NUM_DOT) this.numState = NUM_FRAC
      else if (st === NUM_E || st === NUM_ESIGN) this.numState = NUM_EDIGITS
      else if (st !== NUM_DIGITS && st !== NUM_FRAC && st !== NUM_EDIGITS) {
        this.state = S_ERROR
        return
      }
      this.numAppend(c)
      return
    }
    if (c === 46) {
      // '.'
      if (st === NUM_ZERO || st === NUM_DIGITS) {
        this.numState = NUM_DOT
        this.numAppend(c)
        return
      }
      this.state = S_ERROR
      return
    }
    if (c === 101 || c === 69) {
      // e / E
      if (st === NUM_ZERO || st === NUM_DIGITS || st === NUM_FRAC) {
        this.numState = NUM_E
        this.numAppend(c)
        return
      }
      this.state = S_ERROR
      return
    }
    if (c === 43 || c === 45) {
      // + / -
      if (st === NUM_E) {
        this.numState = NUM_ESIGN
        this.numAppend(c)
        return
      }
      this.state = S_ERROR
      return
    }
    // 数字结束：终态必须完整，当前字符交给父状态重新处理
    if (st !== NUM_ZERO && st !== NUM_DIGITS && st !== NUM_FRAC && st !== NUM_EDIGITS) {
      this.state = S_ERROR
      return
    }
    this.finishNumber()
    this.feedChar(c)
  }

  private finishNumber(): void {
    const target = this.numTarget
    this.numTarget = N_NONE
    if (target !== N_NONE) {
      const n = Number(this.numBuf)
      if (Number.isFinite(n)) this.storeNumber(target, n)
    }
    this.numBuf = ''
    this.afterValue()
  }

  private storeNumber(target: number, n: number): void {
    if (target === N_CACHED) {
      if (this.details !== null) this.details.cached_tokens = n
      return
    }
    const u = this.usage
    if (u === null) return
    if (target === N_INPUT) u.input_tokens = n
    else if (target === N_OUTPUT) u.output_tokens = n
    else if (target === N_TOTAL) u.total_tokens = n
  }

  private beginLiteral(text: string): void {
    this.state = S_LITERAL
    this.lit = text
    this.litAt = 1
  }

  private literalChar(c: number): void {
    if (c !== this.lit.charCodeAt(this.litAt)) {
      this.state = S_ERROR
      return
    }
    this.litAt++
    if (this.litAt === this.lit.length) this.afterValue()
  }
}

/** SSE 行状态 */
const L_START = 0 // 行首（空行 = 事件分发）
const L_FIELD = 1 // 字段名
const L_VALUE = 2 // 字段值
const L_SKIP = 3 // 注释或未知长字段：整行忽略

/**
 * 增量 SSE 切帧：网络 chunk 只是字节边界，帧只由行终止符/空行决定。
 * 只把 data 字段的字符流式送进 JSON 扫描器，不缓存行/事件内容。
 */
class ResponsesSseTap {
  private scanner = new UsageJsonScanner()

  private lineState = L_START
  private field = ''
  private fieldOverflow = false
  private firstValue = false
  private skipLF = false

  private dataSeen = false
  private dataHead = '' // data 的前若干非空白字符，用于识别 [DONE]
  private dataHeadFull = false // 非空白字符超出 dataHead 容量

  private terminalSeen = false
  private usage: Record<string, unknown> | null = null
  private sawParseError = false

  feed(text: string): void {
    for (let i = 0; i < text.length; i++) this.char(text.charCodeAt(i))
  }

  /** 正常 EOF：分发最后一帧（容忍无结尾空行），返回结果 */
  end(): { usageRaw: unknown | null; error: string | null } {
    this.dispatch()
    if (this.terminalSeen) return { usageRaw: this.usage, error: null }
    return { usageRaw: null, error: this.sawParseError ? PARSE_FAILED : null }
  }

  private char(c: number): void {
    // CRLF：CR 已结束上一行，紧随的 LF 属于同一行终止符
    if (this.skipLF) {
      this.skipLF = false
      if (c === 10) return
    }
    if (c === 13 || c === 10) {
      if (c === 13) this.skipLF = true
      this.endLine()
      return
    }
    let st = this.lineState
    if (st === L_START) {
      if (c === 58) {
        this.lineState = L_SKIP // 注释行
        return
      }
      this.lineState = L_FIELD
      this.field = ''
      this.fieldOverflow = false
      st = L_FIELD
    }
    if (st === L_FIELD) {
      if (c === 58) {
        this.lineState = L_VALUE
        this.firstValue = true
        return
      }
      if (this.field.length < MAX_FIELD) this.field += String.fromCharCode(c)
      else this.fieldOverflow = true
      return
    }
    if (st === L_VALUE) {
      if (this.firstValue) {
        this.firstValue = false
        if (c === 32) return // 冒号后可选的一个空格
      }
      if (!this.fieldOverflow && this.field === 'data') this.dataChar(c)
    }
  }

  private endLine(): void {
    const st = this.lineState
    this.lineState = L_START
    if (st === L_START) {
      this.dispatch() // 空行：分发事件
      return
    }
    // 注释/未知字段行不参与 data 拼接（field 可能是上一行残留）
    if (st !== L_FIELD && st !== L_VALUE) return
    if (this.fieldOverflow || this.field !== 'data') return
    this.dataChar(10) // 多行 data 按 \n 连接（无冒号的 "data" 行 = 空值）
  }

  private dataChar(c: number): void {
    this.dataSeen = true
    if (c > 32) {
      if (this.dataHead.length < MAX_HEAD) this.dataHead += String.fromCharCode(c)
      else this.dataHeadFull = true
    }
    this.scanner.feedChar(c)
  }

  private dispatch(): void {
    if (this.dataSeen) {
      this.scanner.feedChar(32) // EOF 也可结束一个完整的数字字面量
      if (this.scanner.isComplete()) {
        const type = this.scanner.getType()
        if (
          type === 'response.completed' ||
          type === 'response.incomplete' ||
          type === 'response.failed'
        ) {
          this.terminalSeen = true
          this.usage = this.scanner.getUsage()
        }
      } else if ((this.dataHead.length !== 0 || this.dataHeadFull) && !this.isDoneMarker()) {
        // 空 data 事件按 SSE 规则不分发；[DONE] 是正常终止标记
        this.sawParseError = true
      }
    }
    this.scanner.reset()
    this.dataSeen = false
    this.dataHead = ''
    this.dataHeadFull = false
  }

  /** data 只有 [DONE]（允许任意空白分隔）时是正常终止标记，不算解析失败 */
  private isDoneMarker(): boolean {
    return !this.dataHeadFull && this.dataHead === '[DONE]'
  }
}

export interface ResponsesUsageObserver {
  /** 写入一个原始网络 chunk；解析失败只记录状态，不抛出 */
  write(chunk: Uint8Array): void
  /** 流正常结束：冲刷解码器与最后一帧，返回 usage / error */
  end(): { usageRaw: unknown | null; error: string | null }
}

/**
 * 创建一个 Responses usage 观察器：UTF-8 增量解码（chunk 可切断多字节字符），
 * 逐事件提取终止事件内嵌的 response.usage。
 */
export function createResponsesUsageObserver(): ResponsesUsageObserver {
  const decoder = new TextDecoder()
  const sse = new ResponsesSseTap()
  return {
    write(chunk: Uint8Array): void {
      if (chunk.byteLength === 0) return
      const text = decoder.decode(chunk, { stream: true })
      if (text.length !== 0) sse.feed(text)
    },
    end() {
      const rest = decoder.decode()
      if (rest.length !== 0) sse.feed(rest)
      return sse.end()
    },
  }
}
