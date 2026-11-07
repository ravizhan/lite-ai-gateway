/**
 * web_fetch 的 Node 单跳请求（只被 bindings-node.ts 引入，node: 依赖不进入 Workers bundle）。
 *
 * 公网限制落在连接层：自定义 lookup 在 DNS 解析后检查**全部**结果，任一非公网即拒绝，
 * 通过检查的地址就是 socket 实际连接的地址，所以 DNS 重绑定无法绕过。每次请求
 * 新建 agent（agent: false），不复用其他代码建立的、未经检查的连接。
 * 重定向由调用方逐跳处理；本函数不跟随重定向。
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { Readable, pipeline } from 'node:stream'
import zlib from 'node:zlib'
import { isPublicAddress } from '../lib/public-address.ts'
import { WebFetchBlockedError, type WebFetchHop } from './node-bindings.ts'

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '')
    const blocked = addresses.find((a) => !isPublicAddress(a.address))
    if (blocked) return callback(new WebFetchBlockedError(`${hostname} resolves to non-public address ${blocked.address}`), '')
    if (addresses.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '')
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

/** 按 Content-Encoding 解压（与 fetch 行为一致）；容忍截断的压缩流 */
function decode(res: http.IncomingMessage): NodeJS.ReadableStream {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  const zflush = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip(zflush)
      : encoding === 'deflate'
        ? zlib.createInflate(zflush)
        : encoding === 'br'
          ? zlib.createBrotliDecompress({
              flush: zlib.constants.BROTLI_OPERATION_FLUSH,
              finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
            })
          : null
  if (!decoder) return res
  return pipeline(res, decoder, () => {})
}

export function nodeWebFetchHop(url: URL, headers: Headers, signal: AbortSignal): Promise<WebFetchHop> {
  return new Promise((resolve, reject) => {
    const outgoing: Record<string, string> = {}
    headers.forEach((value, name) => {
      outgoing[name] = value
    })
    outgoing['accept-encoding'] ??= 'gzip, deflate, br'
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      url.href,
      { method: 'GET', headers: outgoing, agent: false, lookup: publicLookup, signal },
      (res) => {
        const responseHeaders = new Headers()
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1])
          } catch {
            // 非法头（Headers 拒绝的名字/值）跳过，不让整个请求失败
          }
        }
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
          body: Readable.toWeb(Readable.from(decode(res))) as unknown as ReadableStream<Uint8Array>,
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}
