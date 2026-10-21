/**
 * MCP 工具暴露名分配（hub 聚合与前端 token 预览共用的纯函数，无任何依赖）。
 *
 * 规则（只在暴露范围内计算，范围外的工具不参与）：
 * 1. 原名在范围内唯一 → 保持原名（不加前缀）；
 * 2. 原名重名 → 冲突的**全部**工具加 `${serverName}__` 前缀；
 * 3. 加前缀后若又与别的名字相撞（典型：上游原生名本身含 `__`，如 `alpha__common`），
 *    原生名继续加前缀（`alpha__alpha__common`）——合成名 `${serverName}__${rawName}`
 *    始终保留该名字；重复直到范围内名字全局唯一。
 *
 * 结果与输入顺序无关（内部按 serverName、原名排序后分配），保证 hub 与前端预览一致。
 */

export interface ExposedNameEntry {
  /** 上游 server 名（mcp_servers.name，唯一） */
  serverName: string
  /** 上游侧原始工具名（未加前缀） */
  rawName: string
}

/** 暴露名分配：返回与 entries 同序的名字数组（每个名字在范围内唯一） */
export function assignExposedToolNames(entries: readonly ExposedNameEntry[]): string[] {
  const names = entries.map((e) => e.rawName)
  // 分配次序固定为 serverName → 原名 → 输入序；直接比较码元（不用 localeCompare，
  // 避免 Node 与浏览器排序差异）。仅作同类冲突（如两个合成名相撞）时的稳定次序。
  const order = entries
    .map((_, i) => i)
    .sort((a, b) => {
      if (entries[a].serverName !== entries[b].serverName) return entries[a].serverName < entries[b].serverName ? -1 : 1
      if (entries[a].rawName !== entries[b].rawName) return entries[a].rawName < entries[b].rawName ? -1 : 1
      return a - b
    })
  /** 保留优先级（越小越优先保住当前名字）：合成名 0 < 原生名 1 < 已改过的 2 */
  const rank = (i: number): number =>
    names[i] === `${entries[i].serverName}__${entries[i].rawName}` ? 0 : names[i] === entries[i].rawName ? 1 : 2

  for (let round = 0; round <= entries.length; round++) {
    const groups = new Map<string, number[]>()
    for (const i of order) {
      const group = groups.get(names[i])
      if (group) group.push(i)
      else groups.set(names[i], [i])
    }
    let renamed = false
    for (const group of groups.values()) {
      if (group.length < 2) continue
      // 唯一的最低优先级成员 = 该名字的合法持有者（合成名优先），其余成员改名；
      // 没有唯一持有者（同优先级重名，即首轮原名冲突）→ 组内全部改名。
      let minRank = rank(group[0])
      let minCount = 0
      for (const i of group) {
        const r = rank(i)
        if (r < minRank) {
          minRank = r
          minCount = 1
        } else if (r === minRank) minCount++
      }
      for (const i of group) {
        if (minCount === 1 && rank(i) === minRank) continue
        names[i] = `${entries[i].serverName}__${names[i]}`
        renamed = true
      }
    }
    if (!renamed) return names
  }

  // 兜底（正常输入 1–2 轮即收敛，这里实际不可达）：按同一优先级追加序号保证全局唯一
  const used = new Set<string>()
  for (const i of [...order].sort((a, b) => rank(a) - rank(b) || a - b)) {
    let name = names[i]
    for (let n = 0; used.has(name); n++) name = `${names[i]}__${n}`
    used.add(name)
    names[i] = name
  }
  return names
}
