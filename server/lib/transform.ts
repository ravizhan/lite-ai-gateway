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

async function runSandbox(source: string): Promise<string> {
  try {
    const mod = await getModule()
    const runtime = mod.newRuntime()
    let cycles = 0
    runtime.setInterruptHandler(() => ++cycles > CYCLE_CAP)
    runtime.setMemoryLimit(MEMORY_LIMIT)
    runtime.setMaxStackSize(STACK_LIMIT)

    try {
      const ctx = runtime.newContext()
      try {
        const resultHandle = ctx.unwrapResult(ctx.evalCode(source))
        try {
          const outJson = ctx.getString(resultHandle)
          if (outJson.length > MAX_OUTPUT_BYTES || utf8Encoder.encode(outJson).byteLength > MAX_OUTPUT_BYTES) {
            throw new Error('transform output too large')
          }
          return outJson
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

export async function evalTransform(code: string, body: unknown): Promise<unknown> {
  let inputJson: string
  try {
    inputJson = JSON.stringify(body ?? null)
    if (inputJson.length > MAX_INPUT_BYTES || utf8Encoder.encode(inputJson).byteLength > MAX_INPUT_BYTES) {
      throw new Error('transform input too large')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('guest transform error: ' + message, { cause: error })
  }
  const source =
    '(function(){const r=((\n' + code + '\n))(JSON.parse(' + JSON.stringify(inputJson) + '));' +
    'if(r!==null&&(typeof r==="object"||typeof r==="function")&&typeof r.then==="function")' +
    'throw new Error("async transforms are not supported");' +
    'const s=JSON.stringify(r);return s===undefined?"null":s})()'
  const output = await runSandbox(source)
  try {
    return JSON.parse(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('guest transform error: ' + message, { cause: error })
  }
}

/** Checks the expression's syntax and function shape without calling the transform. */
export async function checkTransformSyntax(code: string): Promise<string | null> {
  try {
    await runSandbox(
      '(function(){const fn=(\n' + code + '\n);' +
      'if(typeof fn!=="function")throw new Error("transform must be a function");return "ok"})()',
    )
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
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
