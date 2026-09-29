import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Client as PgClient } from 'pg';
import * as mysql from 'mysql2/promise';
import type { DataSource } from '@ai-bi/db';
import {
  buildCheckEnumMap,
  buildDdl,
  buildNativeEnumMap,
  columnEnumKey,
  mergeEnumMaps,
  parseMysqlEnumType,
  type EnumValueMap,
  type SchemaColumnRow,
  type SchemaForeignKeyRow,
} from '@ai-bi/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { CreateDataSourceDto, UpdateDataSourceDto } from './datasource.dto';
import {
  mapMysqlForeignKeyRows,
  mapPgForeignKeyRows,
  type MysqlForeignKeyQueryRow,
  type PgForeignKeyQueryRow,
} from './schema-fk';

@Injectable()
export class DataSourceService {
  private readonly logger = new Logger(DataSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  private toDto(ds: DataSource) {
    return {
      id: ds.id,
      name: ds.name,
      type: ds.type,
      host: ds.host,
      port: ds.port,
      database: ds.database,
      username: ds.username,
      isReadOnly: ds.isReadOnly,
      connectionStatus: ds.connectionStatus,
      lastSyncAt: ds.lastSyncAt?.toISOString() ?? null,
      createdAt: ds.createdAt.toISOString(),
    };
  }

  async list(userId: string) {
    const items = await this.prisma.dataSource.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((ds) => this.toDto(ds));
  }

  async create(userId: string, dto: CreateDataSourceDto) {
    const connected = await this.testConnection({
      type: dto.type,
      host: dto.host,
      port: dto.port,
      database: dto.database,
      username: dto.username,
      password: dto.password,
    });

    const ds = await this.prisma.dataSource.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        host: dto.host,
        port: dto.port,
        database: dto.database,
        username: dto.username,
        password: this.crypto.encrypt(dto.password),
        isReadOnly: dto.isReadOnly ?? true,
        connectionStatus: connected ? 'CONNECTED' : 'ERROR',
      },
    });

    return {
      ...this.toDto(ds),
      message: connected ? '连接测试成功' : '已保存，但连接测试失败',
    };
  }

  async update(userId: string, id: string, dto: UpdateDataSourceDto) {
    await this.assertOwner(id, userId);
    const ds = await this.prisma.dataSource.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.host !== undefined && { host: dto.host }),
        ...(dto.port !== undefined && { port: dto.port }),
        ...(dto.database !== undefined && { database: dto.database }),
        ...(dto.username !== undefined && { username: dto.username }),
        ...(dto.password !== undefined && {
          password: this.crypto.encrypt(dto.password),
        }),
        ...(dto.isReadOnly !== undefined && { isReadOnly: dto.isReadOnly }),
      },
    });
    return this.toDto(ds);
  }

  async findOne(userId: string, id: string) {
    const ds = await this.assertOwner(id, userId);
    return {
      ...this.toDto(ds),
      schemaDoc: ds.schemaDoc,
    };
  }

  async remove(userId: string, id: string) {
    await this.assertOwner(id, userId);
    await this.prisma.dataSource.delete({ where: { id } });
    return { deleted: true };
  }

  async syncSchema(userId: string, id: string) {
    const ds = await this.assertOwner(id, userId);
    const password = this.crypto.decrypt(ds.password);

    let schemaDoc: string;
    let tableCount: number;

    if (ds.type === 'POSTGRESQL') {
      ({ schemaDoc, tableCount } = await this.extractPostgresSchema(ds, password));
    } else {
      ({ schemaDoc, tableCount } = await this.extractMysqlSchema(ds, password));
    }

    const updated = await this.prisma.dataSource.update({
      where: { id },
      data: {
        schemaDoc,
        lastSyncAt: new Date(),
        connectionStatus: 'CONNECTED',
      },
    });

    return {
      syncedAt: updated.lastSyncAt!.toISOString(),
      tableCount,
      schemaDoc: schemaDoc.slice(0, 2000),
    };
  }

  private async assertOwner(id: string, userId: string) {
    const ds = await this.prisma.dataSource.findUnique({ where: { id } });
    if (!ds) throw new NotFoundException('数据源不存在');
    if (ds.userId !== userId) throw new ForbiddenException('无权访问该数据源');
    return ds;
  }

  private async testConnection(config: {
    type: string;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
  }): Promise<boolean> {
    try {
      if (config.type === 'POSTGRESQL') {
        const client = new PgClient({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          database: config.database,
          connectionTimeoutMillis: 5000,
        });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
      } else {
        const conn = await mysql.createConnection({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          database: config.database,
          connectTimeout: 5000,
        });
        await conn.query('SELECT 1');
        await conn.end();
      }
      return true;
    } catch (err) {
      this.logger.warn(`Connection test failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async extractPostgresSchema(ds: DataSource, password: string) {
    const client = new PgClient({
      host: ds.host,
      port: ds.port,
      user: ds.username,
      password,
      database: ds.database,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();

    try {
      const { rows } = await client.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        udt_name: string;
      }>(`
        SELECT table_name, column_name, data_type, is_nullable, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `);

      const typedRows: SchemaColumnRow[] = rows.map((r) => ({
        table_name: r.table_name,
        column_name: r.column_name,
        data_type: r.data_type,
        is_nullable: r.is_nullable,
      }));

      const nativeEnums = await this.fetchPostgresNativeEnums(client, rows);
      const checkEnums = await this.fetchPostgresCheckEnums(client);
      const enumMap = mergeEnumMaps(nativeEnums, checkEnums);
      const foreignKeys = await this.fetchPostgresForeignKeys(client);

      return {
        schemaDoc: buildDdl(typedRows, enumMap, foreignKeys),
        tableCount: new Set(typedRows.map((r) => r.table_name)).size,
      };
    } finally {
      await client.end();
    }
  }

  private async fetchPostgresForeignKeys(
    client: PgClient,
  ): Promise<SchemaForeignKeyRow[]> {
    const { rows } = await client.query<PgForeignKeyQueryRow>(`
      SELECT
        con.conname AS constraint_name,
        rel_from.relname AS from_table,
        att_from.attname AS from_column,
        rel_to.relname AS to_table,
        att_to.attname AS to_column,
        ord.ordinal_position::int AS ordinal_position
      FROM pg_constraint con
      JOIN pg_class rel_from ON rel_from.oid = con.conrelid
      JOIN pg_namespace nsp
        ON nsp.oid = rel_from.relnamespace AND nsp.nspname = 'public'
      JOIN pg_class rel_to ON rel_to.oid = con.confrelid
      JOIN LATERAL unnest(con.conkey, con.confkey)
        WITH ORDINALITY AS ord(from_attnum, to_attnum, ordinal_position)
        ON true
      JOIN pg_attribute att_from
        ON att_from.attrelid = con.conrelid
        AND att_from.attnum = ord.from_attnum
      JOIN pg_attribute att_to
        ON att_to.attrelid = con.confrelid
        AND att_to.attnum = ord.to_attnum
      WHERE con.contype = 'f'
      ORDER BY con.conname, ord.ordinal_position
    `);
    return mapPgForeignKeyRows(rows);
  }

  private async fetchPostgresNativeEnums(
    client: PgClient,
    columns: Array<{
      table_name: string;
      column_name: string;
      udt_name: string;
    }>,
  ): Promise<EnumValueMap> {
    const { rows: enumRows } = await client.query<{
      typname: string;
      enumlabel: string;
    }>(`
      SELECT t.typname, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      ORDER BY t.typname, e.enumsortorder
    `);
    return buildNativeEnumMap(columns, enumRows);
  }

  private async fetchPostgresCheckEnums(
    client: PgClient,
  ): Promise<EnumValueMap> {
    const { rows } = await client.query<{
      table_name: string;
      check_def: string;
    }>(`
      SELECT
        c.conrelid::regclass::text AS table_name,
        pg_get_constraintdef(c.oid) AS check_def
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'c'
        AND n.nspname = 'public'
    `);
    return buildCheckEnumMap(rows);
  }

  private async extractMysqlSchema(ds: DataSource, password: string) {
    const conn = await mysql.createConnection({
      host: ds.host,
      port: ds.port,
      user: ds.username,
      password,
      database: ds.database,
      connectTimeout: 5000,
    });

    try {
      const [rows] = await conn.query(
        `SELECT TABLE_NAME as table_name, COLUMN_NAME as column_name,
                DATA_TYPE as data_type, IS_NULLABLE as is_nullable,
                COLUMN_TYPE as column_type
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [ds.database],
      );

      const typedRows = rows as Array<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_type: string;
      }>;

      const enumMap: EnumValueMap = new Map();
      for (const row of typedRows) {
        if (row.data_type.toLowerCase() !== 'enum') continue;
        const values = parseMysqlEnumType(row.column_type);
        if (values.length === 0) continue;
        enumMap.set(columnEnumKey(row.table_name, row.column_name), values);
      }

      const columnRows: SchemaColumnRow[] = typedRows.map((r) => ({
        table_name: r.table_name,
        column_name: r.column_name,
        data_type: r.data_type,
        is_nullable: r.is_nullable,
      }));

      const foreignKeys = await this.fetchMysqlForeignKeys(conn, ds.database);

      return {
        schemaDoc: buildDdl(columnRows, enumMap, foreignKeys),
        tableCount: new Set(columnRows.map((r) => r.table_name)).size,
      };
    } finally {
      await conn.end();
    }
  }

  private async fetchMysqlForeignKeys(
    conn: mysql.Connection,
    database: string,
  ): Promise<SchemaForeignKeyRow[]> {
    const [rows] = await conn.query(
      `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME,
              REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [database],
    );
    return mapMysqlForeignKeyRows(rows as MysqlForeignKeyQueryRow[]);
  }
}
