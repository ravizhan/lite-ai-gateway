import { getQuickJSWASMModule, type QuickJSWASMModule } from '@cf-wasm/quickjs'

const CYCLE_CAP = 10_000_000
const MEMORY_LIMIT = 32 * 1024 * 1024
const STACK_LIMIT = 1024 * 1024
const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const utf8Encoder = new TextEncoder()

let modulePromise: Promise<QuickJSWASMModule> | null = null

function getModule(): Promise<QuickJSWASMModule> {
  return (modulePromise ??= getQuickJSWASMModule())
}

export async function evalTransform(code: string, body: unknown): Promise<unknown> {
  try {
    const inputJson = JSON.stringify(body ?? null)
    if (inputJson.length > MAX_INPUT_BYTES || utf8Encoder.encode(inputJson).byteLength > MAX_INPUT_BYTES) {
      throw new Error('transform input too large')
    }

    const mod = await getModule()
    const runtime = mod.newRuntime()
    let cycles = 0
    runtime.setInterruptHandler(() => ++cycles > CYCLE_CAP)
    runtime.setMemoryLimit(MEMORY_LIMIT)
    runtime.setMaxStackSize(STACK_LIMIT)

    try {
      const ctx = runtime.newContext()
      try {
        const guest =
          '(function(){const r=((' + code + '))(JSON.parse(' + JSON.stringify(inputJson) + '));' +
          'const s=JSON.stringify(r);return s===undefined?"null":s})()'
        const resultHandle = ctx.unwrapResult(ctx.evalCode(guest))
        try {
          const outJson = ctx.getString(resultHandle)
          if (outJson.length > MAX_OUTPUT_BYTES || utf8Encoder.encode(outJson).byteLength > MAX_OUTPUT_BYTES) {
            throw new Error('transform output too large')
          }
          return JSON.parse(outJson)
        } finally {
          resultHandle.dispose()
        }
      } finally {
        ctx.dispose()
      }
    } finally {
      runtime.dispose()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('guest transform error: ' + message, { cause: error })
  }
}

export async function checkTransform(code: string): Promise<string | null> {
  try {
    await evalTransform(code, { text: 'probe', index: 0 })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
