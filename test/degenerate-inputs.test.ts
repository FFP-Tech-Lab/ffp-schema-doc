import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMysqlSchemaDoc, buildPostgresSchemaDoc } from '../src/introspect';
import { buildDdl } from '../src/schema-enum';
import { parseSchemaDoc } from '../src/schema-parse';

describe('degenerate inputs', () => {
  it('returns an empty string from buildDdl and an empty result from the builders', () => {
    assert.equal(buildDdl([]), '');
    assert.deepEqual(buildPostgresSchemaDoc([], [], [], []), {
      schemaDoc: '',
      tableCount: 0,
    });
    assert.deepEqual(buildMysqlSchemaDoc([], []), {
      schemaDoc: '',
      tableCount: 0,
    });
  });

  it('emits a self-referential foreign key', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 'emp',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
        },
        {
          table_name: 'emp',
          column_name: 'mgr_id',
          data_type: 'int',
          is_nullable: 'YES',
        },
      ],
      undefined,
      [
        {
          constraint_name: 'fk_mgr',
          from_table: 'emp',
          from_column: 'mgr_id',
          to_table: 'emp',
          to_column: 'id',
          ordinal_position: 1,
        },
      ],
    );
    assert.equal(
      ddl,
      'CREATE TABLE emp (\n  id int NOT NULL,\n  mgr_id int,\n  CONSTRAINT fk_mgr FOREIGN KEY (mgr_id) REFERENCES emp (id)\n);',
    );
  });

  it('emits a table that exists only as a foreign-key source', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 'dept',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
        },
      ],
      undefined,
      [
        {
          constraint_name: 'fk_dept',
          from_table: 'emp',
          from_column: 'dept_id',
          to_table: 'dept',
          to_column: 'id',
          ordinal_position: 1,
        },
      ],
    );
    assert.equal(
      ddl,
      'CREATE TABLE dept (\n  id int NOT NULL\n);\n\nCREATE TABLE emp (\n  CONSTRAINT fk_dept FOREIGN KEY (dept_id) REFERENCES dept (id)\n);',
    );
  });

  it('keeps the same constraint name on two tables', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 'a',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
        },
        {
          table_name: 'b',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
        },
      ],
      undefined,
      [
        {
          constraint_name: 'fk_same',
          from_table: 'a',
          from_column: 'id',
          to_table: 'p',
          to_column: 'id',
          ordinal_position: 1,
        },
        {
          constraint_name: 'fk_same',
          from_table: 'b',
          from_column: 'id',
          to_table: 'p',
          to_column: 'id',
          ordinal_position: 1,
        },
      ],
    );
    assert.equal(
      ddl,
      'CREATE TABLE a (\n  id int NOT NULL,\n  CONSTRAINT fk_same FOREIGN KEY (id) REFERENCES p (id)\n);\n\nCREATE TABLE b (\n  id int NOT NULL,\n  CONSTRAINT fk_same FOREIGN KEY (id) REFERENCES p (id)\n);',
    );
  });

  it('drops a foreign-key group whose rows name different target tables', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 'c',
          column_name: 'a',
          data_type: 'int',
          is_nullable: 'NO',
        },
        {
          table_name: 'c',
          column_name: 'b',
          data_type: 'int',
          is_nullable: 'NO',
        },
      ],
      undefined,
      [
        {
          constraint_name: 'fk',
          from_table: 'c',
          from_column: 'a',
          to_table: 'parent',
          to_column: 'id',
          ordinal_position: 1,
        },
        {
          constraint_name: 'fk',
          from_table: 'c',
          from_column: 'b',
          to_table: 'other',
          to_column: 'id',
          ordinal_position: 2,
        },
      ],
    );
    assert.equal(ddl, 'CREATE TABLE c (\n  a int NOT NULL,\n  b int NOT NULL\n);');
  });

  it('omits a composite primary key from buildDdl and skips it on parse', () => {
    const ddl = buildDdl([
      {
        table_name: 't',
        column_name: 'a',
        data_type: 'int',
        is_nullable: 'NO',
      },
      {
        table_name: 't',
        column_name: 'b',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.equal(ddl, 'CREATE TABLE t (\n  a int NOT NULL,\n  b int NOT NULL\n);');
    assert.doesNotMatch(ddl, /PRIMARY KEY/);
    assert.deepEqual(
      parseSchemaDoc('CREATE TABLE t (\n  a int NOT NULL,\n  b int NOT NULL,\n  PRIMARY KEY (a, b)\n);'),
      [
        {
          name: 't',
          columns: [
            { name: 'a', type: 'int' },
            { name: 'b', type: 'int' },
          ],
        },
      ],
    );
  });
});
