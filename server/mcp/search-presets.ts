/**
 * 三家搜索上游的可编辑预置（版本 1）：Tavily、Exa Advanced、Firecrawl。
 *
 * 预置只是**起点**：用户应用后代码被复制进 `mcp_search_upstreams` 绑定行，
 * 运行时只执行绑定行里的代码，不会按 preset_id 走隐藏分支，也不自动写库/覆盖。
 *
 * 约定：
 * - request_code：({ request }) => upstreamArguments
 * - response_code：({ request, response }) => ({ results })
 * 脚本只能返回数据，不能决定 server/tool/headers；response 是完整的成功
 * MCP CallToolResult（content 已由宿主在校验后补为空数组）。
 */
import type { McpSearchPreset, WebSearchRequest } from '../../shared/mcp-search.ts'

/** 统一请求样例：max_results=1 便于验证宿主按上限裁剪；两条结果分别来自 a/b */
const SAMPLE_REQUEST: WebSearchRequest = {
  query: 'MCP structuredContent',
  max_results: 1,
  objective: 'Find official documentation for MCP structured outputs.',
}

const TAVILY_REQUEST_CODE = `({ request }) => ({
  query: request.query,
  max_results: Math.max(5, request.max_results),
  topic: 'general',
  include_raw_content: false,
  include_images: false,
})`

const TAVILY_RESPONSE_CODE = `({ response }) => {
  const mapItem = (item) => {
    const result = { url: item.url, content: typeof item.content === 'string' ? item.content : '' }
    if (typeof item.title === 'string' && item.title.trim() !== '' && item.title.trim() !== 'N/A') result.title = item.title
    if (typeof item.published_date === 'string' && item.published_date.trim() !== '' && item.published_date.trim() !== 'N/A') {
      result.published_at = item.published_date
    }
    return result
  }
  const fromList = (list) => ({ results: list.map(mapItem) })

  // 官方纯文本格式：只认独立的 "Detailed Results:" 行；Content 保留多行，
  // 到独立 Raw Content/Favicon/Images 元信息为止。格式本身丢失 score/date，
  // 正文若恰好包含完整标签头会存在歧义，可在 UI 中改脚本或改用返回 JSON 的实现。
  const parseLabelled = (text) => {
    const lines = text.split('\\n')
    const marker = lines.findIndex((line) => line.trim() === 'Detailed Results:')
    if (marker === -1) throw new Error('unsupported search response format')
    let end = lines.length
    for (let i = marker + 1; i < lines.length; i++) {
      if (lines[i].trim() === 'Images:') { end = i; break }
    }
    const section = lines.slice(marker + 1, end)
    if (section.join('\\n').trim() === '') return { results: [] }

    const headers = []
    for (let i = 0; i < section.length; i++) {
      if (i !== 0 && section[i - 1].trim() !== '') continue
      let j = i
      let title = null
      if (/^Title:\\s*/.test(section[j])) { title = section[j].replace(/^Title:\\s*/, '').trim(); j++ }
      if (j < section.length && /^ID:\\s*/.test(section[j])) j++
      if (j >= section.length) continue
      const matched = /^URL:\\s*(https?:\\/\\/\\S+)\\s*$/.exec(section[j])
      if (matched) headers.push({ line: i, urlLine: j, title, url: matched[1] })
    }
    if (headers.length === 0) throw new Error('unsupported search response format')

    const results = []
    for (let h = 0; h < headers.length; h++) {
      const header = headers[h]
      const blockEnd = h + 1 < headers.length ? headers[h + 1].line : section.length
      let content = ''
      for (let i = header.urlLine + 1; i < blockEnd; i++) {
        const matched = /^Content:\\s?(.*)$/.exec(section[i])
        if (!matched) continue
        const collected = matched[1] === '' ? [] : [matched[1]]
        for (let k = i + 1; k < blockEnd; k++) {
          if (/^(Raw Content|Favicon|Images):/.test(section[k])) break
          collected.push(section[k])
        }
        while (collected.length > 0 && collected[0].trim() === '') collected.shift()
        while (collected.length > 0 && collected[collected.length - 1].trim() === '') collected.pop()
        content = collected.join('\\n')
        break
      }
      const result = { url: header.url, content }
      if (header.title) result.title = header.title
      results.push(result)
    }
    return { results }
  }

  const structured = response.structuredContent
  if (structured && Array.isArray(structured.results)) return fromList(structured.results)

  const text = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\\n')
    .replace(/\\r\\n?/g, '\\n')

  const trimmed = text.trim()
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    let parsed = null
    try { parsed = JSON.parse(trimmed) } catch (error) { parsed = null }
    if (parsed && Array.isArray(parsed.results)) return fromList(parsed.results)
    if (parsed !== null) throw new Error('unsupported search response format')
  }
  return parseLabelled(text)
}`

const EXA_REQUEST_CODE = `({ request }) => ({
  query: request.query,
  numResults: request.max_results,
})`

const EXA_RESPONSE_CODE = `({ response }) => {
  const structured = response.structuredContent
  let payload = structured && Array.isArray(structured.results) ? structured : null
  if (!payload) {
    const text = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\\n')
      .trim()
    if (!text) throw new Error('unsupported search response format')
    try { payload = JSON.parse(text) } catch (error) { throw new Error('unsupported search response format') }
  }
  if (!payload || !Array.isArray(payload.results)) throw new Error('unsupported search response format')

  return {
    results: payload.results.map((item) => {
      const highlights = Array.isArray(item.highlights)
        ? item.highlights.filter((line) => typeof line === 'string' && line !== '')
        : []
      let content = highlights.length > 0 ? highlights.join('\\n') : ''
      if (!content && typeof item.text === 'string') content = item.text
      if (!content && typeof item.summary === 'string') content = item.summary
      const result = { url: item.url, content }
      if (typeof item.title === 'string' && item.title.trim() !== '') result.title = item.title
      if (typeof item.publishedDate === 'string' && item.publishedDate.trim() !== '' && item.publishedDate.trim() !== 'N/A') {
        result.published_at = item.publishedDate
      }
      return result
    }),
  }
}`

const FIRECRAWL_REQUEST_CODE = `({ request }) => ({
  query: request.query,
  limit: request.max_results,
  sources: ['web'],
  objective: request.objective ?? ('Find reliable web sources answering: ' + request.query),
})`

const FIRECRAWL_RESPONSE_CODE = `({ response }) => {
  let payload = response.structuredContent
  if (payload === undefined || payload === null) {
    const text = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\\n')
      .trim()
    try { payload = JSON.parse(text) } catch (error) { throw new Error('unsupported search response format') }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('unsupported search response format')
  }
  if (payload.success === false) throw new Error('firecrawl search failed')

  const web = payload.data && Array.isArray(payload.data.web) ? payload.data.web : null
  if (!web) throw new Error('unsupported search response format')

  return {
    results: web.map((item) => {
      const result = { url: item.url, content: typeof item.description === 'string' ? item.description : '' }
      if (typeof item.title === 'string' && item.title.trim() !== '') result.title = item.title
      return result
    }),
  }
}`

const TAVILY_SAMPLE_RESPONSE: Record<string, unknown> = {
  content: [
    {
      type: 'text',
      text:
        'Request ID: sample-request\n' +
        'Answer: Structured content lets an MCP tool return typed machine-readable output.\n\n' +
        'Detailed Results:\n\n' +
        'Title: MCP Structured Outputs\n' +
        'ID: a\n' +
        'URL: https://example.com/a\n' +
        'Content: first excerpt\n\n' +
        'Title: Structured Content Reference\n' +
        'ID: b\n' +
        'URL: https://example.com/b\n' +
        'Content: second excerpt\n',
    },
  ],
}

const EXA_SAMPLE_RESPONSE: Record<string, unknown> = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        results: [
          {
            url: 'https://example.com/a',
            title: 'MCP Structured Outputs',
            highlights: ['first excerpt'],
            publishedDate: '2025-01-01T00:00:00.000Z',
          },
          {
            url: 'https://example.com/b',
            title: 'Structured Content Reference',
            highlights: ['second excerpt'],
            publishedDate: '2025-01-02T00:00:00.000Z',
          },
        ],
      }),
    },
  ],
}

const FIRECRAWL_SAMPLE_RESPONSE: Record<string, unknown> = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        success: true,
        data: {
          web: [
            {
              url: 'https://example.com/a',
              title: 'MCP Structured Outputs',
              description: 'first excerpt',
            },
            {
              url: 'https://example.com/b',
              title: 'Structured Content Reference',
              description: 'second excerpt',
            },
          ],
        },
      }),
    },
  ],
  structuredContent: {
    success: true,
    data: {
      web: [
        {
          url: 'https://example.com/a',
          title: 'MCP Structured Outputs',
          description: 'first excerpt',
        },
        {
          url: 'https://example.com/b',
          title: 'Structured Content Reference',
          description: 'second excerpt',
        },
      ],
    },
  },
}

/** 预置列表：id / version 固定，代码可被用户编辑后带版本元数据保存 */
export const MCP_SEARCH_PRESETS: readonly McpSearchPreset[] = [
  {
    id: 'tavily',
    version: 1,
    label: 'Tavily',
    tool_name: 'tavily_search',
    request_code: TAVILY_REQUEST_CODE,
    response_code: TAVILY_RESPONSE_CODE,
    sample_request: { ...SAMPLE_REQUEST },
    sample_response: TAVILY_SAMPLE_RESPONSE,
  },
  {
    id: 'exa-advanced',
    version: 1,
    label: 'Exa Advanced',
    tool_name: 'web_search_advanced_exa',
    request_code: EXA_REQUEST_CODE,
    response_code: EXA_RESPONSE_CODE,
    sample_request: { ...SAMPLE_REQUEST },
    sample_response: EXA_SAMPLE_RESPONSE,
  },
  {
    id: 'firecrawl',
    version: 1,
    label: 'Firecrawl',
    tool_name: 'firecrawl_search',
    request_code: FIRECRAWL_REQUEST_CODE,
    response_code: FIRECRAWL_RESPONSE_CODE,
    sample_request: { ...SAMPLE_REQUEST },
    sample_response: FIRECRAWL_SAMPLE_RESPONSE,
  },
]
