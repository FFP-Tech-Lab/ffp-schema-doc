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
