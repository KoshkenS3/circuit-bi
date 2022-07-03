import { Pool, PoolConfig } from "pg";
import pgf from "pg-format";
import { logger } from "./logger";
import * as pgcs from "pg-connection-string";
import { TIMESCALEDB_URL } from "./config";
import { normalizeAddress } from "./ethers";

/**
 * evm_address: It's a bit more difficult to use but half the size
 * 
beefy=# select 
    octet_length('\x2BdfBd329984Cf0DC9027734681A16f542cF3bB4'::bytea) as bytea_addr_size, 
    octet_length('0x2BdfBd329984Cf0DC9027734681A16f542cF3bB4') as str_addr_size;
-[ RECORD 1 ]---+---
bytea_addr_size | 20
str_addr_size   | 42
 */

let pool: Pool | null = null;
export async function getPgPool() {
  if (pool === null) {
    const config = pgcs.parse(TIMESCALEDB_URL) as PoolConfig;
    pool = new Pool(config);
    await migrate();
  }
  return pool;
}

export async function db_query<RowType>(
  sql: string,
  params: any[] = []
): Promise<RowType[]> {
  logger.debug(`Executing query: ${sql}, params: ${params}`);
  const pool = await getPgPool();
  const sql_w_params = pgf(sql, ...params);
  const res = await pool.query(sql_w_params);
  const rows = res?.rows || null;
  logger.debug(`Got ${res?.rowCount} for query: ${sql}, params ${params}`);
  return rows;
}

export async function db_query_one<RowType>(
  sql: string,
  params: any[] = []
): Promise<RowType | null> {
  const rows = await db_query<RowType>(sql, params);
  if (rows.length === 0) {
    return null;
  }
  return rows[0];
}

export function strAddressToPgBytea(evmAddress: string) {
  // 0xABC -> // \xABC
  return "\\x" + normalizeAddress(evmAddress).slice(2);
}

export function strArrToPgStrArr(strings: string[]) {
  return "{" + pgf.withArray("%L", strings) + "}";
}

async function migrate() {
  // postgresql don't have "create type/domain if not exists"
  async function typeExists(typeName: string) {
    const res = await db_query_one(`SELECT * FROM pg_type WHERE typname = %L`, [
      typeName,
    ]);
    return res !== null;
  }

  // avoid error ERROR:  cannot change configuration on already compressed chunks
  // on alter table set compression
  async function isCompressionEnabled(
    hyperTableSchema: string,
    hypertableName: string
  ) {
    const res = await db_query_one<{ compression_enabled: boolean }>(
      `SELECT compression_enabled 
      FROM timescaledb_information.hypertables 
      WHERE hypertable_schema = %L
      AND hypertable_name = %L`,
      [hyperTableSchema, hypertableName]
    );
    if (res === null) {
      throw new Error(`No hypertable ${hyperTableSchema}.${hypertableName}`);
    }
    return res.compression_enabled;
  }

  // types
  if (!(await typeExists("chain_enum"))) {
    await db_query(`
        CREATE TYPE chain_enum AS ENUM ('ethereum');
    `);
  }
  await db_query(`
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'arbitrum';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'aurora';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'avax';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'bsc';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'celo';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'cronos';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'emerald';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'fantom';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'fuse';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'harmony';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'heco';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'metis';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'moonbeam';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'moonriver';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'optimism';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'polygon';
    ALTER TYPE chain_enum ADD VALUE IF NOT EXISTS 'syscoin';
  `);

  if (!(await typeExists("evm_address"))) {
    await db_query(`
      CREATE DOMAIN evm_address AS BYTEA NOT NULL;
    `);
  }

  if (!(await typeExists("uint_256"))) {
    await db_query(`
      CREATE DOMAIN uint_256 
        AS NUMERIC NOT NULL
        CHECK (VALUE >= 0 AND VALUE < 2^256)
        CHECK (SCALE(VALUE) = 0)
    `);
  }

  if (!(await typeExists("int_256"))) {
    await db_query(`
      CREATE DOMAIN int_256 
        AS NUMERIC NOT NULL
        CHECK (VALUE >= -2^255 AND VALUE < (2^255)-1)
        CHECK (SCALE(VALUE) = 0)
    `);
  }

  // schemas
  await db_query(`
    CREATE SCHEMA IF NOT EXISTS beefy_raw;
    CREATE SCHEMA IF NOT EXISTS beefy_derived;
    CREATE SCHEMA IF NOT EXISTS beefy_report;
  `);

  // helper function
  await db_query(`
      CREATE OR REPLACE FUNCTION format_evm_address(bytea) RETURNS character varying 
        AS $$
          SELECT '0x' || encode($1::bytea, 'hex')
        $$
        LANGUAGE SQL
        IMMUTABLE
        RETURNS NULL ON NULL INPUT;

    CREATE OR REPLACE FUNCTION evm_address_to_bytea(varchar) RETURNS bytea 
      AS $$
        select decode(substring($1 ,3), 'hex')
      $$
      LANGUAGE SQL
      IMMUTABLE
      RETURNS NULL ON NULL INPUT;
  `);

  // transfer table
  await db_query(`
    CREATE TABLE IF NOT EXISTS beefy_raw.erc20_transfer_ts (
      chain chain_enum NOT NULL,
      contract_address evm_address NOT NULL,
      datetime TIMESTAMPTZ NOT NULL,
      from_address evm_address not null,
      to_address evm_address not null,
      value uint_256 not null
    );
    SELECT create_hypertable(
      relation => 'beefy_raw.erc20_transfer_ts', 
      time_column_name => 'datetime', 
      -- partitioning_column => 'chain',
      -- number_partitions => 20,
      chunk_time_interval => INTERVAL '7 days', 
      if_not_exists => true
    );
  `);

  if (!(await isCompressionEnabled("beefy_raw", "erc20_transfer_ts"))) {
    await db_query(`
      ALTER TABLE beefy_raw.erc20_transfer_ts SET (
        timescaledb.compress, 
        timescaledb.compress_segmentby = 'chain, contract_address',
        timescaledb.compress_orderby = 'datetime DESC'
      );
      SELECT add_compression_policy(
        hypertable => 'beefy_raw.erc20_transfer_ts', 
        compress_after => INTERVAL '10 days', -- keep a margin as data will arrive in batches
        if_not_exists => true
      );
    `);
  }

  // balance diff table
  await db_query(`
    CREATE TABLE IF NOT EXISTS beefy_raw.erc20_balance_diff_ts (
      chain chain_enum NOT NULL,
      contract_address evm_address NOT NULL,
      datetime TIMESTAMPTZ NOT NULL,
      investor_address evm_address not null,
      balance_diff int_256 not null
    );
    SELECT create_hypertable(
      relation => 'beefy_raw.erc20_balance_diff_ts', 
      time_column_name => 'datetime', 
      chunk_time_interval => INTERVAL '7 days', 
      if_not_exists => true
    );
  `);

  if (!(await isCompressionEnabled("beefy_raw", "erc20_balance_diff_ts"))) {
    await db_query(`
      ALTER TABLE beefy_raw.erc20_balance_diff_ts SET (
        timescaledb.compress, 
        timescaledb.compress_segmentby = 'chain, contract_address',
        timescaledb.compress_orderby = 'datetime DESC'
      );
      SELECT add_compression_policy(
        hypertable => 'beefy_raw.erc20_balance_diff_ts', 
        compress_after => INTERVAL '10 days', -- keep a margin as data will arrive in batches
        if_not_exists => true
      );
    `);
  }

  // PPFS
  await db_query(`
    CREATE TABLE IF NOT EXISTS beefy_raw.vault_ppfs_ts (
      chain chain_enum NOT NULL,
      contract_address evm_address NOT NULL,
      datetime TIMESTAMPTZ NOT NULL,
      ppfs uint_256 not null
    );
    SELECT create_hypertable(
      relation => 'beefy_raw.vault_ppfs_ts', 
      time_column_name => 'datetime', 
      -- partitioning_column => 'chain',
      -- number_partitions => 20,
      chunk_time_interval => INTERVAL '14 days', 
      if_not_exists => true
    );
  `);

  if (!(await isCompressionEnabled("beefy_raw", "vault_ppfs_ts"))) {
    await db_query(`
      ALTER TABLE beefy_raw.vault_ppfs_ts SET (
        timescaledb.compress, 
        timescaledb.compress_segmentby = 'chain, contract_address',
        timescaledb.compress_orderby = 'datetime DESC'
      );
      SELECT add_compression_policy(
        hypertable => 'beefy_raw.vault_ppfs_ts', 
        compress_after => INTERVAL '20 days', -- keep a margin as data will arrive in batches
        if_not_exists => true
      );
    `);
  }

  // oracle price
  await db_query(`
    CREATE TABLE IF NOT EXISTS beefy_raw.oracle_price_ts (
      oracle_id varchar NOT NULL,
      datetime TIMESTAMPTZ NOT NULL,
      usd_value double precision not null
    );
    SELECT create_hypertable(
      relation => 'beefy_raw.oracle_price_ts', 
      time_column_name => 'datetime', 
      chunk_time_interval => INTERVAL '14 days', 
      if_not_exists => true
    );
  `);

  if (!(await isCompressionEnabled("beefy_raw", "oracle_price_ts"))) {
    await db_query(`
      ALTER TABLE beefy_raw.oracle_price_ts SET (
        timescaledb.compress, 
        timescaledb.compress_segmentby = 'oracle_id',
        timescaledb.compress_orderby = 'datetime DESC'
      );
      SELECT add_compression_policy(
        hypertable => 'beefy_raw.oracle_price_ts', 
        compress_after => INTERVAL '20 days', -- keep a margin as data will arrive in batches
        if_not_exists => true
      );
    `);
  }

  await db_query(`
    CREATE TABLE IF NOT EXISTS beefy_raw.vault (
      chain chain_enum NOT NULL,
      token_address evm_address NOT NULL,
      vault_id varchar NOT NULL,
      token_name varchar NOT NULL,
      want_address evm_address NOT NULL,
      want_decimals INTEGER NOT NULL,
      want_price_oracle_id varchar NOT NULL,
      end_of_life boolean not null,
      assets_oracle_id varchar[] not null,
      PRIMARY KEY(chain, token_address)
    );
  `);

  // continuous aggregates: ppfs
  await db_query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS beefy_derived.vault_ppfs_4h_ts WITH (timescaledb.continuous)
      AS select ts.chain, ts.contract_address, 
          time_bucket('4h', ts.datetime) as datetime, 
          avg(ts.ppfs) as avg_ppfs
      from beefy_raw.vault_ppfs_ts ts
      group by 1,2,3;
  `);
  // continuous aggregates: prices
  await db_query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS beefy_derived.oracle_price_4h_ts WITH (timescaledb.continuous)
      AS select oracle_id,
          time_bucket('4h', datetime) as datetime, 
          avg(usd_value) as avg_usd_value
      from beefy_raw.oracle_price_ts
      group by 1,2;
  `);
  // continuous aggregates: transfer diffs
  await db_query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS beefy_derived.erc20_balance_diff_4h_ts WITH (timescaledb.continuous)
      AS select chain, contract_address, investor_address, 
          time_bucket('4h', datetime) as datetime, 
          sum(balance_diff) as balance_diff,
          count(*) as trx_count
      from beefy_raw.erc20_balance_diff_ts
      group by 1,2,3,4;
  `);

  // helper materialized view
  await db_query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS beefy_derived.vault_ppfs_and_price_4h_ts as 
      with vault_scope as (
          select chain, token_address, vault_id, want_price_oracle_id, want_decimals
          from beefy_raw.vault
      ), 
      want_prices_ts as (
          select oracle_id, datetime, avg_usd_value
          from beefy_derived.oracle_price_4h_ts
          where oracle_id in (
              select distinct scope.want_price_oracle_id 
              from vault_scope scope
          )
      ),
      ppfs_ts as (
          select chain, contract_address, datetime, avg_ppfs
          from beefy_derived.vault_ppfs_4h_ts ts
          where (chain, contract_address) in (
              select distinct scope.chain, scope.token_address
              from vault_scope scope
          )
      )
      select 
          v.chain, v.vault_id, v.token_address as contract_address, v.want_decimals, 
          coalesce(p.datetime, usd.datetime) as datetime, 
          p.avg_ppfs, usd.avg_usd_value as avg_want_usd_value
      from ppfs_ts p
      full outer join vault_scope v on v.chain = p.chain and v.token_address = p.contract_address
      full outer join want_prices_ts usd on usd.oracle_id = v.want_price_oracle_id and usd.datetime = p.datetime
      order by v.chain, v.vault_id, datetime
    ;
    CREATE INDEX IF NOT EXISTS idx_chain_vpp4h ON beefy_derived.vault_ppfs_and_price_4h_ts (chain);
    CREATE INDEX IF NOT EXISTS idx_address_vpp4h ON beefy_derived.vault_ppfs_and_price_4h_ts (contract_address);
    CREATE INDEX IF NOT EXISTS idx_datetime_vpp4h ON beefy_derived.vault_ppfs_and_price_4h_ts (datetime);
  `);

  // helper erc20 balance derived table
  await db_query(`
    CREATE TABLE IF NOT EXISTS beefy_derived.erc20_investor_balance_4h_ts (
      chain chain_enum NOT NULL,
      contract_address evm_address NOT NULL,
      investor_address evm_address NOT NULL,
      datetime TIMESTAMPTZ NOT NULL,
      balance_diff int_256,
      balance int_256 not null
    );
    SELECT create_hypertable(
      relation => 'beefy_derived.erc20_investor_balance_4h_ts', 
      time_column_name => 'datetime', 
      chunk_time_interval => INTERVAL '14 days', 
      if_not_exists => true
    );
  `);
}

// this is kind of a continuous aggregate
// there currently is no way to do continuous aggregates with window functions (cumulative sum to get the balance)
// so we drop and rebuild this table as needed
// it needs to be an hypertable if we want to use ts functions like time_bucket_gapfill so materialized view are not a good fit
export async function rebuildERC20BalanceTs() {
  const rows = await db_query<{
    chain: string;
    contract_address: string;
    investor_address: string;
    first_datetime: Date;
    last_datetime: Date;
  }>(`
    SELECT 
      chain,
      format_evm_address(contract_address) as contract_address,
      format_evm_address(investor_address) as investor_address,
      min(datetime) as first_datetime, 
      max(datetime) as last_datetime 
    FROM beefy_derived.erc20_balance_diff_4h_ts
    GROUP BY 1,2,3
  `);
  for (const row of rows) {
    logger.verbose(`[DB] Refreshing data for investor ${JSON.stringify(row)}`);
    await db_query(
      `
      DELETE FROM beefy_derived.erc20_investor_balance_4h_ts
      WHERE chain = %L
        and contract_address = %L
        and investor_address = %L
    `,
      [
        row.chain,
        strAddressToPgBytea(row.contract_address),
        strAddressToPgBytea(row.investor_address),
      ]
    );
    await db_query(
      `
      INSERT INTO beefy_derived.erc20_investor_balance_4h_ts (
          chain, contract_address, investor_address,
          datetime,
          balance_diff, balance
      ) 
      select 
          %L, %L, %L,
          datetime,
          coalesce(balance_diff, 0),
          sum(coalesce(balance_diff, 0)) over (order by datetime) as balance
      from (
          select time_bucket_gapfill('4h', datetime) as datetime,
              sum(balance_diff) as balance_diff
          from beefy_derived.erc20_balance_diff_4h_ts
          where datetime between %L and %L
              and chain = %L
              and contract_address = %L
              and investor_address = %L
          group by 1
      ) as t
      where balance_diff != 0
    `,
      [
        row.chain,
        strAddressToPgBytea(row.contract_address),
        strAddressToPgBytea(row.investor_address),
        row.first_datetime,
        row.last_datetime,
        row.chain,
        strAddressToPgBytea(row.contract_address),
        strAddressToPgBytea(row.investor_address),
      ]
    );
  }
}
