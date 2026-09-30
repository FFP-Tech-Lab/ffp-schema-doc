import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapMysqlForeignKeyRows,
  mapPgForeignKeyRows,
} from '../src/schema-fk';

describe('mapPgForeignKeyRows', () => {
  it('maps single and composite FK rows', () => {
    const mapped = mapPgForeignKeyRows([
      {
        constraint_name: 'fk_orders_user',
        from_table: 'orders',
        from_column: 'user_id',
        to_table: 'users',
        to_column: 'id',
        ordinal_position: 1,
      },
      {
        constraint_name: 'fk_items_order_line',
        from_table: 'order_items',
        from_column: 'order_id',
        to_table: 'order_lines',
        to_column: 'order_id',
        ordinal_position: 1,
      },
      {
        constraint_name: 'fk_items_order_line',
        from_table: 'order_items',
        from_column: 'line_no',
        to_table: 'order_lines',
        to_column: 'line_no',
        ordinal_position: 2,
      },
    ]);
    assert.deepEqual(mapped, [
      {
        constraint_name: 'fk_orders_user',
        from_table: 'orders',
        from_column: 'user_id',
        to_table: 'users',
        to_column: 'id',
        ordinal_position: 1,
      },
      {
        constraint_name: 'fk_items_order_line',
        from_table: 'order_items',
        from_column: 'order_id',
        to_table: 'order_lines',
        to_column: 'order_id',
        ordinal_position: 1,
      },
      {
        constraint_name: 'fk_items_order_line',
        from_table: 'order_items',
        from_column: 'line_no',
        to_table: 'order_lines',
        to_column: 'line_no',
        ordinal_position: 2,
      },
    ]);
  });

  it('drops incomplete rows', () => {
    assert.deepEqual(
      mapPgForeignKeyRows([
        {
          constraint_name: 'fk_bad',
          from_table: 'orders',
          from_column: 'user_id',
          to_table: '',
          to_column: 'id',
          ordinal_position: 1,
        },
      ]),
      [],
    );
  });
});

describe('mapMysqlForeignKeyRows', () => {
  it('maps referenced KEY_COLUMN_USAGE rows', () => {
    const mapped = mapMysqlForeignKeyRows([
      {
        CONSTRAINT_NAME: 'fk_orders_user',
        TABLE_NAME: 'orders',
        COLUMN_NAME: 'user_id',
        REFERENCED_TABLE_NAME: 'users',
        REFERENCED_COLUMN_NAME: 'id',
        ORDINAL_POSITION: 1,
      },
      {
        CONSTRAINT_NAME: 'no_ref',
        TABLE_NAME: 'orders',
        COLUMN_NAME: 'id',
        REFERENCED_TABLE_NAME: null,
        REFERENCED_COLUMN_NAME: null,
        ORDINAL_POSITION: 1,
      },
    ]);
    assert.deepEqual(mapped, [
      {
        constraint_name: 'fk_orders_user',
        from_table: 'orders',
        from_column: 'user_id',
        to_table: 'users',
        to_column: 'id',
        ordinal_position: 1,
      },
    ]);
  });
});
