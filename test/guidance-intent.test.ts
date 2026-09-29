import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseSchemaDoc } from '../src/schema-parse';
import type { SchemaTableMeta } from '../src/guidance-types';

/**
 * This package ships the table, column, and relation meta types only.
 * A caller may still guard a message with `kind === 'guidance'`:
 *
 *   return !!value && typeof value === 'object'
 *     && (value as GuidanceMessageIntent).kind === 'guidance';
 *
 * This test applies that kind check, then compares `tables` to
 * `parseSchemaDoc` field by field.
 */
type GuidanceIntentFixture = {
  schemaDoc: string;
  intent: {
    kind: string;
    originalQuestion: string;
    completed?: boolean;
    tables: SchemaTableMeta[];
  };
};

function kindIsGuidance(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: string }).kind === 'guidance'
  );
}

describe('GuidanceMessageIntent.tables fixture', () => {
  const fixture = JSON.parse(
    readFileSync('test/fixtures/guidance-intent.json', 'utf8'),
  ) as GuidanceIntentFixture;

  it('accepts the synthetic intent when kind is guidance', () => {
    assert.equal(kindIsGuidance(fixture.intent), true);
    assert.equal(kindIsGuidance({ kind: 'query' }), false);
    assert.equal(kindIsGuidance(null), false);
  });

  it('matches parseSchemaDoc field by field', () => {
    const parsed = parseSchemaDoc(fixture.schemaDoc);
    assert.equal(parsed.length, fixture.intent.tables.length);
    for (let i = 0; i < parsed.length; i += 1) {
      const actual = parsed[i];
      const expected = fixture.intent.tables[i];
      assert.ok(actual);
      assert.ok(expected);
      assert.equal(actual.name, expected.name);
      assert.deepEqual(actual.columns, expected.columns);
      assert.deepEqual(actual.outgoingRelations, expected.outgoingRelations);
      assert.deepEqual(Object.keys(actual), Object.keys(expected));
      for (let c = 0; c < actual.columns.length; c += 1) {
        const column = actual.columns[c];
        const expectedColumn = expected.columns[c];
        assert.ok(column);
        assert.ok(expectedColumn);
        assert.deepEqual(Object.keys(column), Object.keys(expectedColumn));
      }
    }
    assert.deepEqual(parsed, fixture.intent.tables);
  });
});
