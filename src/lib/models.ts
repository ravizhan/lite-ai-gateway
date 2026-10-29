/** 对外模型 id：配置了 alias 时用 alias，否则用原始 model。路由/计费/日志统一使用此 id */
import type { ModelRow } from '../../shared/api'

export function displayModel(row: Pick<ModelRow, 'model' | 'alias'>): string {
  return row.alias || row.model
}
