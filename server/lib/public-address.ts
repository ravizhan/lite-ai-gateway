/**
 * 公网地址判定（纯函数，无 node: 依赖，Node 与 Workers 共用）。
 *
 * 只认 IANA 特殊用途地址表之外的单播地址为公网：环回、私网、链路本地、CGNAT、
 * 文档/基准测试段、组播、保留段，以及 IPv6 中 2000::/3 之外的全部地址都算非公网。
 * IPv4 映射（::ffff:0:0/96）、NAT64（64:ff9b::/96）和 6to4（2002::/16）按内嵌的 IPv4 判定。
 */

/** 点分十进制 IPv4 → 4 个字节；不是严格的点分四段 → null */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

/** IPv6 文本（不带方括号，可带 %zone 与点分 IPv4 尾部）→ 8 个 16 位组；非法 → null */
export function parseIPv6(text: string): number[] | null {
  let s = text.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  let tail: number[] = []
  const lastColon = s.lastIndexOf(':')
  if (lastColon < 0) return null
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(s.slice(lastColon + 1))
    if (!v4) return null
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    s = s.slice(0, lastColon + 1)
    if (!s.endsWith('::')) s = s.slice(0, -1)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const toGroups = (part: string): number[] | null => {
    if (part === '') return []
    const groups: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      groups.push(parseInt(g, 16))
    }
    return groups
  }
  const head = toGroups(halves[0])
  const rest = halves.length === 2 ? toGroups(halves[1]) : []
  if (head === null || rest === null) return null
  const total = head.length + rest.length + tail.length
  if (halves.length === 1) return total === 8 ? [...head, ...tail] : null
  if (total > 7) return null
  return [...head, ...new Array<number>(8 - total).fill(0), ...rest, ...tail]
}

function isPublicIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false // 本网络 / 私网 / 环回 / 组播与保留
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return false // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF 协议分配 / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false // 6to4 中继任播
  if (a === 198 && (b === 18 || b === 19)) return false // 基准测试
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  return true
}

function embeddedIPv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
}

function isPublicIPv6(g: number[]): boolean {
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (zeroPrefix(5) && g[5] === 0xffff) return isPublicIPv4(embeddedIPv4(g[6], g[7])) // IPv4 映射
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicIPv4(embeddedIPv4(g[6], g[7])) // NAT64
  }
  if ((g[0] & 0xe000) !== 0x2000) return false // 全局单播只在 2000::/3（排除 ::1、fc00::/7、fe80::/10、ff00::/8 等）
  if (g[0] === 0x2001 && g[1] < 0x200) return false // 2001::/23 IETF 协议分配（含 Teredo）
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false // 文档
  if (g[0] === 0x3fff && g[1] < 0x1000) return false // 文档 3fff::/20
  if (g[0] === 0x2002) return isPublicIPv4(embeddedIPv4(g[1], g[2])) // 6to4
  return true
}

/** IP 地址文本是否为公网地址；不是合法 IP → false（按非公网拒绝） */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address)
  if (v4) return isPublicIPv4(v4)
  const v6 = parseIPv6(address)
  return v6 !== null && isPublicIPv6(v6)
}

/** URL 主机名的静态判定结果：'ip' = IP 字面量（已完成判定），'name' = 域名（需在解析后再判定） */
export type HostCheck = { kind: 'ip'; public: boolean } | { kind: 'name'; public: boolean }

/**
 * 判定 WHATWG URL 的 hostname（URL 解析已把 0x7f.1、2130706433 等写法规范为点分四段，
 * IPv6 带方括号）。域名只能静态排除 localhost 与 *.localhost，其余要等 DNS 解析后判定。
 */
export function checkUrlHost(hostname: string): HostCheck {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return { kind: 'ip', public: isPublicAddress(hostname.slice(1, -1)) }
  }
  if (parseIPv4(hostname)) return { kind: 'ip', public: isPublicAddress(hostname) }
  const name = hostname.toLowerCase().replace(/\.+$/, '')
  return { kind: 'name', public: name !== '' && name !== 'localhost' && !name.endsWith('.localhost') }
}
