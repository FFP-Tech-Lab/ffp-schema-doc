export type GuidanceFilterOperator =
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'LIKE'
  | 'IN'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface SchemaColumnMeta {
  name: string;
  type?: string;
  /** Legal values when schemaDoc includes `-- enum: a | b` on the column. */
  enumValues?: string[];
}

/** One FK edge (supports composite keys via parallel arrays). */
export interface SchemaRelationMeta {
  name?: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

export interface SchemaTableMeta {
  name: string;
  columns: SchemaColumnMeta[];
  /** Relations where this table is the FK side (fromTable === name). */
  outgoingRelations?: SchemaRelationMeta[];
}

export interface GuidanceFilter {
  field: string;
  operator: GuidanceFilterOperator;
  value?: string;
}

export interface GuidanceJoin {
  leftTable: string;
  leftColumns: string[];
  rightTable: string;
  rightColumns: string[];
  type: 'INNER';
}

export interface GuidancePayload {
  /** [primary, ...related] — primary is always tables[0]. */
  tables: string[];
  /** Qualified as table.column on new submits. */
  fields: string[];
  filters: GuidanceFilter[];
  /** Empty for single-table queries. */
  joins: GuidanceJoin[];
}

/** Persisted on ASSISTANT messages when the graph enters guidance mode */
export interface GuidanceMessageIntent {
  kind: 'guidance';
  originalQuestion: string;
  tables: SchemaTableMeta[];
  /** Set after the user completes the wizard and resubmits */
  completed?: boolean;
  selection?: GuidancePayload;
}

export function isGuidanceMessageIntent(
  value: unknown,
): value is GuidanceMessageIntent {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as GuidanceMessageIntent).kind === 'guidance'
  );
}
