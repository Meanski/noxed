export interface QueryResult { columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number; duration: number }
export interface TableColumn { name: string; type: string; nullable: boolean }
export type ResultSort = { col: string; dir: 'asc' | 'desc' } | null
export type ActivePanel = 'results' | 'history' | 'saved' | 'explain' | 'diagram'
