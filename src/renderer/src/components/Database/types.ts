export interface QueryResult { columns: string[]; rows: any[]; rowCount: number; duration: number }
export interface TableColumn { name: string; type: string; nullable: boolean }
export type ResultSort = { col: string; dir: 'asc' | 'desc' } | null
