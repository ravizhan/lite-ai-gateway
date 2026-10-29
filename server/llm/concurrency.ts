import type { Db } from '../db/types.ts'

/**
 * 供应商在途并发租约（provider 总上限 + exact model/provider route 上限）。
 * 仅依赖 Db/Web API（Node sqlite 与 Workers D1 共用，无 Node-only import）。
 *
 * 获取：单条 INSERT ... SELECT ... WHERE 原子准入——只统计 `expires_at > now` 的活跃
 * rows，两个非零限制必须同时满足；禁止先 SELECT 再 INSERT（D1 单写语句具备所需原子性）。
 * 续租：递归 setTimeout 每 3 分钟一次 UPDATE（不用可重叠的 setInterval），瞬时错误每
 * 15 秒重试；响应回来时若本地 expiry 已到（保护空窗），该迟到续租立即判 lost，绝不复活
 * 已出现空窗的 lease。
 * 状态机：active | lost | released，只允许 active→lost / active→released。
 */

const LEASE_MS = 600_000 // 初始/续租时长：10 分钟
const RENEW_INTERVAL_MS = 180_000 // 每 3 分钟续租一次
const RENEW_RETRY_MS = 15_000 // 续租瞬时错误重试间隔

// 排队等待（仅 embedding）：满员时最多重试 5s，间隔 250ms × 均匀抖动 [0.5, 1.5]
const QUEUE_MAX_WAIT_MS = 5_000
const QUEUE_INTERVAL_MS = 250

/**
 * 准入语句：单条 INSERT ... SELECT ... WHERE，只统计 `expires_at > now` 的活跃 rows；
 * provider/route 两个非零限制必须同时满足。? 依次绑定 lease ID、provider ID、exact model、
 * now + 600_000，然后绑定 provider/route limit 与相同 provider/model/now。禁止把两个 count
 * 或 insert 拆成 D1 batch/多条语句。所有 now 参数用调用开始时捕获的同一整数毫秒值。
 */
const ACQUIRE_SQL = `INSERT INTO llm_concurrency_leases (lease_id, provider_id, model, expires_at)
SELECT ?, ?, ?, ?
WHERE (? = 0 OR (
  SELECT COUNT(*) FROM llm_concurrency_leases
  WHERE provider_id = ? AND expires_at > ?
) < ?)
AND (? = 0 OR (
  SELECT COUNT(*) FROM llm_concurrency_leases
  WHERE provider_id = ? AND model = ? AND expires_at > ?
) < ?)`

const RENEW_SQL = `UPDATE llm_concurrency_leases
SET expires_at = ? WHERE lease_id = ? AND expires_at > ?`

const DELETE_SQL = `DELETE FROM llm_concurrency_leases WHERE lease_id = ?`

/** 并发准入目标：limit 为 0 表示无限 */
export interface ConcurrencyTarget {
  providerId: number
  model: string
  providerLimit: number
  routeLimit: number
}

/** 并发许可：受限请求的真 lease；两 limit 均 0 时返回共享 no-op permit */
export interface ConcurrencyPermit {
  /** lease 丢失（过期/被强制删除/空窗后迟到续租）时 abort；no-op permit 恒不 abort */
  readonly signal: AbortSignal
  /** lost/released 时 resolve；no-op permit 已 resolve */
  readonly finished: Promise<void>
  /** 幂等释放：首次调用停续租、resolve finished、best-effort DELETE；后续返回同一 promise */
  release(): Promise<void>
}

const noOpSignal = new AbortController().signal

const noOpPermit: ConcurrencyPermit = {
  signal: noOpSignal,
  finished: Promise.resolve(),
  release: async () => {},
}

type PermitState = 'active' | 'lost' | 'released'

interface RealPermitState {
  state: PermitState
  resolveFinished: (() => void) | null
  releasePromise: Promise<void> | null
}

/**
 * 获取并发许可。provider/route limit 都为 0 → 共享 no-op permit（0 次 lease 读写）；
 * 任一非零 → 单条原子 INSERT 准入，`Db.run().changes === 1` 成功，否则返回 null。
 * 所有 `now` 参数使用调用开始时捕获的同一个整数毫秒值。
 */
export async function tryAcquireConcurrency(
  db: Db,
  target: ConcurrencyTarget,
): Promise<ConcurrencyPermit | null> {
  if (target.providerLimit === 0 && target.routeLimit === 0) return noOpPermit

  const now = Date.now()
  const leaseId = crypto.randomUUID()
  const expiresAt = now + LEASE_MS
  const result = await db.run(
    ACQUIRE_SQL,
    leaseId,
    target.providerId,
    target.model,
    expiresAt,
    target.providerLimit,
    target.providerId,
    now,
    target.providerLimit,
    target.routeLimit,
    target.providerId,
    target.model,
    now,
    target.routeLimit,
  )
  if (result.changes !== 1) return null

  const abortController = new AbortController()
  const st: RealPermitState = {
    state: 'active',
    resolveFinished: null,
    releasePromise: null,
  }
  const finished = new Promise<void>((resolve) => {
    st.resolveFinished = resolve
  })

  let localExpiresAt = expiresAt
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerActive = false

  const finish = (): void => {
    if (st.resolveFinished) {
      const r = st.resolveFinished
      st.resolveFinished = null
      r()
    }
  }

  const markLost = (): void => {
    if (st.state !== 'active') return
    st.state = 'lost'
    timerActive = false
    abortController.abort()
    finish()
    db.run(DELETE_SQL, leaseId).catch(() => {})
  }

  const scheduleRenew = (delay: number): void => {
    if (!timerActive || st.state !== 'active') return
    timer = setTimeout(runRenew, delay)
  }

  const runRenew = async (): Promise<void> => {
    if (!timerActive || st.state !== 'active') return
    const renewalNow = Date.now()
    if (renewalNow >= localExpiresAt) {
      markLost()
      return
    }
    const newExpiresAt = renewalNow + LEASE_MS
    let ok: boolean
    let threw = false
    try {
      const result = await db.run(RENEW_SQL, newExpiresAt, leaseId, renewalNow)
      ok = result.changes === 1
    } catch {
      threw = true
      ok = false
    }
    if (!timerActive || st.state !== 'active') {
      // 期间已 release：无论 UPDATE 成败都不要再动状态
      return
    }
    const responseNow = Date.now()
    if (ok && responseNow < localExpiresAt) {
      localExpiresAt = newExpiresAt
      scheduleRenew(RENEW_INTERVAL_MS)
      return
    }
    // changes 0 = lease row 已被删除/过期（保护无法保证）；或瞬时错误重试前本地 expiry 已到
    // （保护空窗）——即使迟到 UPDATE 真的写入了新 expiry 也不能复活。
    // 标记 lost：abort、resolve finished、best-effort DELETE。
    if (!threw || responseNow >= localExpiresAt) {
      markLost()
      return
    }
    // 瞬时错误（UPDATE 抛错，row 可能仍在）且本地 expiry 未到：15 秒后重试
    scheduleRenew(RENEW_RETRY_MS)
  }

  timerActive = true
  scheduleRenew(RENEW_INTERVAL_MS)

  return {
    signal: abortController.signal,
    finished,
    release: () => {
      if (!st.releasePromise) {
        st.releasePromise = (async () => {
          if (st.state === 'lost') {
            // lost 后 release 只 best-effort DELETE，不改变 lost 结果
            await db.run(DELETE_SQL, leaseId).catch(() => {})
            return
          }
          st.state = 'released'
          timerActive = false
          if (timer !== null) clearTimeout(timer)
          // 正常释放不 abort：已完成/已返回的响应不受影响，仅停止续租
          finish()
          await db.run(DELETE_SQL, leaseId).catch(() => {})
        })()
      }
      return st.releasePromise
    },
  }
}

/**
 * 排队获取并发许可（仅 embedding）：满员时在 QUEUE_MAX_WAIT_MS 内带抖动重试准入，
 * signal 中止或超时未拿到返回 null。chat/responses 不排队，仍用 tryAcquireConcurrency。
 * 截止时间检测基于 Date.now()，每轮 D1/SQLite 查询刷新 I/O 时钟（Workers 时钟只在
 * I/O 时前进），sleep 后复查一次，避免睡眠末尾越过截止点多发一次尝试。
 */
export async function acquireQueuedConcurrency(
  db: Db,
  target: ConcurrencyTarget,
  signal?: AbortSignal,
): Promise<ConcurrencyPermit | null> {
  const deadline = Date.now() + QUEUE_MAX_WAIT_MS
  for (;;) {
    if (signal?.aborted) return null
    const permit = await tryAcquireConcurrency(db, target)
    if (permit) return permit
    if (Date.now() >= deadline || signal?.aborted) return null
    // tsconfig lib 为 ES2022，无 Promise.withResolvers；setTimeout 回调 API 需 executor 形式
    await new Promise<void>((resolve) => setTimeout(resolve, QUEUE_INTERVAL_MS * (0.5 + Math.random())))
  }
}
