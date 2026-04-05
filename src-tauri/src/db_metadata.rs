//! PostgreSQL catalog queries for the object tree (lazy-loaded from the frontend).

use serde::{Deserialize, Serialize};
use std::collections::btree_map::Entry;
use std::collections::BTreeMap;
use tokio_postgres::error::{DbError, ErrorPosition};
use tokio_postgres::{Client, Error as PgError, NoTls, SimpleQueryMessage};

pub const MAX_SQL_TEXT_BYTES: usize = 1_048_576;

/// Connection fields required to open a session (matches JS `ConnectionProfile` subset).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgConnectionParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
}

fn validate_ident(schema: &str) -> Result<(), String> {
    if schema.is_empty() || schema.len() > 63 {
        return Err("Invalid identifier.".into());
    }
    let mut it = schema.chars();
    let first = it.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err("Invalid identifier.".into());
    }
    for c in it {
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '$') {
            return Err("Invalid identifier.".into());
        }
    }
    Ok(())
}

/// Double-quote a validated PostgreSQL identifier for use in SQL text.
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

const TABLE_PREVIEW_DEFAULT_LIMIT: u32 = 100;
const TABLE_PREVIEW_MAX_LIMIT: u32 = 1000;

/// Primary key constraint on a relation (from `pg_catalog` / `information_schema`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
}

/// Foreign key constraint referencing another table.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

/// Unique constraint (`UNIQUE` on columns).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueConstraintInfo {
    pub name: String,
    pub columns: Vec<String>,
}

/// Index on the relation (`pg_indexes.indexdef`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub definition: String,
}

/// Planner estimate and `pg_stat_all_tables` activity (heap relations only; views omit heap stats).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStatistics {
    /// `pg_class.relkind` single-char code (`r`, `v`, `m`, …).
    pub relkind: String,
    /// `pg_class.reltuples` rounded; `-1` means unknown until `ANALYZE`.
    pub estimated_row_count: i64,
    pub total_bytes: i64,
    pub heap_bytes: i64,
    pub index_bytes: i64,
    /// `true` when a `pg_stat_all_tables` row exists (base tables, matviews, etc.; `false` for views).
    pub heap_stats_available: bool,
    pub seq_scan: Option<i64>,
    pub seq_tup_read: Option<i64>,
    pub idx_scan: Option<i64>,
    pub idx_tup_fetch: Option<i64>,
    pub n_tup_ins: Option<i64>,
    pub n_tup_upd: Option<i64>,
    pub n_tup_del: Option<i64>,
    pub n_live_tup: Option<i64>,
    pub n_dead_tup: Option<i64>,
    pub last_vacuum: Option<String>,
    pub last_autovacuum: Option<String>,
    pub last_analyze: Option<String>,
    pub last_autoanalyze: Option<String>,
    pub vacuum_count: Option<i64>,
    pub autovacuum_count: Option<i64>,
    pub analyze_count: Option<i64>,
    pub autoanalyze_count: Option<i64>,
}

/// PK, FK, unique constraints, and indexes for the table preview panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMetadata {
    pub statistics: TableStatistics,
    pub primary_key: Option<PrimaryKeyInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub unique_constraints: Vec<UniqueConstraintInfo>,
    pub indexes: Vec<IndexInfo>,
}

/// Read-only row preview for a table, view, or materialized view (`SELECT * ... LIMIT`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePreview {
    pub columns: Vec<String>,
    pub rows: Vec<serde_json::Value>,
    pub metadata: TableMetadata,
}

/// Outcome of one statement in a `simple_query` batch (multiple statements separated by `;`).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SqlStatementResult {
    #[serde(rename = "rows")]
    Rows {
        columns: Vec<String>,
        /// Cell values in column order (aligned with `columns`).
        rows: Vec<Vec<serde_json::Value>>,
    },
    #[serde(rename = "command")]
    Command { rows_affected: u64 },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionResult {
    pub statements: Vec<SqlStatementResult>,
}

/// Structured error for `execute_sql` (serialized to JSON with `PG_JSON:` prefix for the frontend).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PgExecutionError {
    /// `query` | `connection` | `authentication` | `client`
    pub category: String,
    pub sql_state: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character index in the SQL string when provided by PostgreSQL.
    pub position: Option<u32>,
}

const PG_JSON_PREFIX: &str = "PG_JSON:";

fn pg_execution_error_to_invoke(e: PgExecutionError) -> String {
    match serde_json::to_string(&e) {
        Ok(json) => format!("{PG_JSON_PREFIX}{json}"),
        Err(_) => e.message,
    }
}

fn map_db_error(db: &DbError) -> PgExecutionError {
    let code = db.code().code();
    let category = if code.starts_with("28") {
        "authentication"
    } else if code.starts_with("08") {
        "connection"
    } else {
        "query"
    };
    let position = db.position().and_then(|p| match p {
        ErrorPosition::Original(n) => Some(*n),
        ErrorPosition::Internal { position, .. } => Some(*position),
    });
    PgExecutionError {
        category: category.to_string(),
        sql_state: Some(code.to_string()),
        message: db.message().to_string(),
        detail: db.detail().map(|s| s.to_string()),
        hint: db.hint().map(|s| s.to_string()),
        position,
    }
}

fn map_tokio_postgres_error(e: PgError) -> PgExecutionError {
    use std::error::Error as StdError;
    let mut cur: Option<&dyn StdError> = Some(&e);
    while let Some(err) = cur {
        if let Some(db) = err.downcast_ref::<DbError>() {
            return map_db_error(db);
        }
        cur = err.source();
    }

    let mut cur_io: Option<&dyn StdError> = Some(&e);
    while let Some(err) = cur_io {
        if let Some(io_err) = err.downcast_ref::<std::io::Error>() {
            return PgExecutionError {
                category: "connection".into(),
                sql_state: None,
                message: io_err.to_string(),
                detail: None,
                hint: None,
                position: None,
            };
        }
        cur_io = err.source();
    }

    PgExecutionError {
        category: "client".into(),
        sql_state: None,
        message: e.to_string(),
        detail: None,
        hint: None,
        position: None,
    }
}

fn parse_simple_query_messages(msgs: Vec<SimpleQueryMessage>) -> Result<Vec<SqlStatementResult>, String> {
    let mut out = Vec::new();
    let mut cols: Option<Vec<String>> = None;
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();

    for m in msgs {
        match m {
            SimpleQueryMessage::RowDescription(c) => {
                rows.clear();
                cols = Some(c.iter().map(|col| col.name().to_string()).collect());
            }
            SimpleQueryMessage::Row(r) => {
                let n = r.len();
                let mut row = Vec::with_capacity(n);
                for i in 0..n {
                    let cell = match r.try_get(i) {
                        Ok(None) => serde_json::Value::Null,
                        Ok(Some(s)) => serde_json::Value::String(s.into()),
                        Err(_) => serde_json::Value::String("(unavailable)".into()),
                    };
                    row.push(cell);
                }
                rows.push(row);
            }
            SimpleQueryMessage::CommandComplete(n) => {
                if let Some(c) = cols.take() {
                    out.push(SqlStatementResult::Rows {
                        columns: c,
                        rows: std::mem::take(&mut rows),
                    });
                } else {
                    out.push(SqlStatementResult::Command {
                        rows_affected: n,
                    });
                }
            }
            _ => {
                return Err("Unexpected response from the database server.".into());
            }
        }
    }

    Ok(out)
}

/// Runs arbitrary SQL (including multiple statements) using the PostgreSQL simple query protocol.
pub async fn execute_sql(params: PgConnectionParams, sql: String) -> Result<SqlExecutionResult, String> {
    if sql.len() > MAX_SQL_TEXT_BYTES {
        return Err(format!(
            "SQL text exceeds maximum length ({} bytes).",
            MAX_SQL_TEXT_BYTES
        ));
    }
    if sql.trim().is_empty() {
        return Err("SQL text is empty.".into());
    }

    let client = connect_raw(&params)
        .await
        .map_err(|e| pg_execution_error_to_invoke(map_tokio_postgres_error(e)))?;
    let msgs = client
        .simple_query(&sql)
        .await
        .map_err(|e| pg_execution_error_to_invoke(map_tokio_postgres_error(e)))?;
    let statements = parse_simple_query_messages(msgs)?;
    Ok(SqlExecutionResult { statements })
}

async fn fetch_primary_key_info(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Option<PrimaryKeyInfo>, String> {
    let rows = client
        .query(
            "SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_schema = kcu.constraint_schema \
               AND tc.constraint_name = kcu.constraint_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND tc.table_schema = $1 \
               AND tc.table_name = $2 \
             ORDER BY kcu.ordinal_position",
            &[&schema, &table],
        )
        .await
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(None);
    }
    let name: String = rows[0].get(0);
    let columns: Vec<String> = rows.iter().map(|r| r.get::<_, String>(1)).collect();
    Ok(Some(PrimaryKeyInfo { name, columns }))
}

async fn fetch_foreign_keys_info(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let rows = client
        .query(
            "SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position, \
                    kcu2.table_schema AS foreign_table_schema, \
                    kcu2.table_name AS foreign_table_name, \
                    kcu2.column_name AS foreign_column_name \
             FROM information_schema.table_constraints AS tc \
             JOIN information_schema.key_column_usage AS kcu \
               ON tc.constraint_schema = kcu.constraint_schema \
               AND tc.constraint_name = kcu.constraint_name \
             JOIN information_schema.referential_constraints AS rc \
               ON tc.constraint_catalog = rc.constraint_catalog \
               AND tc.constraint_schema = rc.constraint_schema \
               AND tc.constraint_name = rc.constraint_name \
             JOIN information_schema.key_column_usage AS kcu2 \
               ON rc.unique_constraint_catalog = kcu2.constraint_catalog \
               AND rc.unique_constraint_schema = kcu2.constraint_schema \
               AND rc.unique_constraint_name = kcu2.constraint_name \
               AND kcu.ordinal_position = kcu2.ordinal_position \
             WHERE tc.constraint_type = 'FOREIGN KEY' \
               AND tc.table_schema = $1 \
               AND tc.table_name = $2 \
             ORDER BY tc.constraint_name, kcu.ordinal_position",
            &[&schema, &table],
        )
        .await
        .map_err(|e| e.to_string())?;

    #[derive(Default)]
    struct FkAccum {
        referenced_schema: String,
        referenced_table: String,
        columns: Vec<String>,
        referenced_columns: Vec<String>,
    }

    let mut map: BTreeMap<String, FkAccum> = BTreeMap::new();
    for r in rows {
        let name: String = r.get(0);
        let fk_col: String = r.get(1);
        let ref_schema: String = r.get(3);
        let ref_table: String = r.get(4);
        let ref_col: String = r.get(5);
        match map.entry(name) {
            Entry::Vacant(v) => {
                v.insert(FkAccum {
                    referenced_schema: ref_schema,
                    referenced_table: ref_table,
                    columns: vec![fk_col],
                    referenced_columns: vec![ref_col],
                });
            }
            Entry::Occupied(mut o) => {
                o.get_mut().columns.push(fk_col);
                o.get_mut().referenced_columns.push(ref_col);
            }
        }
    }

    Ok(map
        .into_iter()
        .map(|(name, acc)| ForeignKeyInfo {
            name,
            columns: acc.columns,
            referenced_schema: acc.referenced_schema,
            referenced_table: acc.referenced_table,
            referenced_columns: acc.referenced_columns,
        })
        .collect())
}

async fn fetch_unique_constraints_info(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<UniqueConstraintInfo>, String> {
    let rows = client
        .query(
            "SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_schema = kcu.constraint_schema \
               AND tc.constraint_name = kcu.constraint_name \
             WHERE tc.constraint_type = 'UNIQUE' \
               AND tc.table_schema = $1 \
               AND tc.table_name = $2 \
             ORDER BY tc.constraint_name, kcu.ordinal_position",
            &[&schema, &table],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in rows {
        let name: String = r.get(0);
        let col: String = r.get(1);
        map.entry(name).or_default().push(col);
    }

    Ok(map
        .into_iter()
        .map(|(name, columns)| UniqueConstraintInfo { name, columns })
        .collect())
}

async fn fetch_indexes_info(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let rows = client
        .query(
            "SELECT indexname, indexdef FROM pg_indexes \
             WHERE schemaname = $1 AND tablename = $2 \
             ORDER BY indexname",
            &[&schema, &table],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| IndexInfo {
            name: r.get(0),
            definition: r.get(1),
        })
        .collect())
}

async fn fetch_table_statistics(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<TableStatistics, String> {
    let row = client
        .query_one(
            "SELECT \
               c.relkind::text AS relkind, \
               c.reltuples::bigint AS estimated_row_count, \
               pg_total_relation_size(c.oid)::bigint AS total_bytes, \
               pg_relation_size(c.oid)::bigint AS heap_bytes, \
               COALESCE(pg_indexes_size(c.oid), 0)::bigint AS index_bytes, \
               (s.relid IS NOT NULL) AS heap_stats_available, \
               s.seq_scan, s.seq_tup_read, s.idx_scan, s.idx_tup_fetch, \
               s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_live_tup, s.n_dead_tup, \
               s.last_vacuum::text, s.last_autovacuum::text, s.last_analyze::text, \
               s.last_autoanalyze::text, \
               s.vacuum_count, s.autovacuum_count, s.analyze_count, s.autoanalyze_count \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid = c.oid \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(TableStatistics {
        relkind: row.get(0),
        estimated_row_count: row.get(1),
        total_bytes: row.get(2),
        heap_bytes: row.get(3),
        index_bytes: row.get(4),
        heap_stats_available: row.get(5),
        seq_scan: row.get(6),
        seq_tup_read: row.get(7),
        idx_scan: row.get(8),
        idx_tup_fetch: row.get(9),
        n_tup_ins: row.get(10),
        n_tup_upd: row.get(11),
        n_tup_del: row.get(12),
        n_live_tup: row.get(13),
        n_dead_tup: row.get(14),
        last_vacuum: row.get(15),
        last_autovacuum: row.get(16),
        last_analyze: row.get(17),
        last_autoanalyze: row.get(18),
        vacuum_count: row.get(19),
        autovacuum_count: row.get(20),
        analyze_count: row.get(21),
        autoanalyze_count: row.get(22),
    })
}

async fn fetch_table_metadata(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<TableMetadata, String> {
    let (statistics, primary_key, foreign_keys, unique_constraints, indexes) = tokio::try_join!(
        fetch_table_statistics(client, schema, table),
        fetch_primary_key_info(client, schema, table),
        fetch_foreign_keys_info(client, schema, table),
        fetch_unique_constraints_info(client, schema, table),
        fetch_indexes_info(client, schema, table),
    )?;
    Ok(TableMetadata {
        statistics,
        primary_key,
        foreign_keys,
        unique_constraints,
        indexes,
    })
}

pub async fn fetch_table_preview(
    params: PgConnectionParams,
    schema: String,
    table: String,
    limit: Option<u32>,
) -> Result<TablePreview, String> {
    validate_ident(&schema)?;
    validate_ident(&table)?;
    let lim = limit.unwrap_or(TABLE_PREVIEW_DEFAULT_LIMIT).clamp(1, TABLE_PREVIEW_MAX_LIMIT);
    let lim_i64 = i64::from(lim);

    let client = connect(&params).await?;

    let fq = format!(
        "SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text \
         FROM (SELECT * FROM {}.{} LIMIT $1) t",
        quote_ident(&schema),
        quote_ident(&table)
    );

    // `information_schema.columns` omits materialized views in PostgreSQL, so column
    // metadata would be empty and the UI would show a row count with no cells.
    let (col_rows, metadata, data_row) = tokio::try_join!(
        async {
            client
                .query(
                    "SELECT a.attname::text AS column_name \
                     FROM pg_catalog.pg_attribute a \
                     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = $1 AND c.relname = $2 \
                       AND a.attnum > 0 AND NOT a.attisdropped \
                     ORDER BY a.attnum",
                    &[&schema, &table],
                )
                .await
                .map_err(|e| e.to_string())
        },
        fetch_table_metadata(&client, &schema, &table),
        async {
            client
                .query_one(&fq, &[&lim_i64])
                .await
                .map_err(|e| e.to_string())
        },
    )?;

    let columns: Vec<String> = col_rows
        .into_iter()
        .map(|r| r.get::<_, String>(0))
        .collect();

    let json_text: String = data_row.get(0);
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&json_text).map_err(|e| e.to_string())?;

    Ok(TablePreview {
        columns,
        rows,
        metadata,
    })
}

/// Opens a connection and runs `SELECT 1` to verify authentication and database access.
pub async fn test_connection(params: PgConnectionParams) -> Result<(), String> {
    let client = connect(&params).await?;
    client
        .query_one("SELECT 1", &[])
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn connect_raw(params: &PgConnectionParams) -> Result<tokio_postgres::Client, PgError> {
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&params.host);
    cfg.port(params.port);
    cfg.user(&params.user);
    cfg.password(&params.password);
    cfg.dbname(&params.database);
    let (client, connection) = cfg.connect(NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

async fn connect(params: &PgConnectionParams) -> Result<tokio_postgres::Client, String> {
    connect_raw(params).await.map_err(|e| e.to_string())
}

/// User-facing schema list plus the session default schema (`current_schema()`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSchemasSnapshot {
    pub schema_names: Vec<String>,
    pub default_schema: String,
}

fn resolve_default_schema(schema_names: &[String], current_opt: Option<String>) -> String {
    if !schema_names.is_empty() {
        if let Some(ref s) = current_opt {
            if schema_names.iter().any(|n| n == s) {
                return s.clone();
            }
        }
        if schema_names.iter().any(|n| n == "public") {
            return "public".to_string();
        }
        return schema_names[0].clone();
    }
    current_opt.unwrap_or_else(|| "public".to_string())
}

/// User-facing schemas (excludes `pg_*`, `information_schema`, etc.) and `current_schema()`.
pub async fn list_user_schemas(params: PgConnectionParams) -> Result<UserSchemasSnapshot, String> {
    let client = connect(&params).await?;
    let rows = client
        .query(
            "SELECT nspname FROM pg_catalog.pg_namespace \
             WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
               AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\' \
             ORDER BY nspname",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    let schema_names: Vec<String> = rows
        .into_iter()
        .map(|r| r.get::<_, String>(0))
        .collect();

    let current_row = client
        .query_one("SELECT current_schema()", &[])
        .await
        .map_err(|e| e.to_string())?;
    let current_opt: Option<String> = current_row.get(0);
    let default_schema = resolve_default_schema(&schema_names, current_opt);

    Ok(UserSchemasSnapshot {
        schema_names,
        default_schema,
    })
}

/// `pg_catalog` and `information_schema` for the system subtree.
pub async fn list_system_schema_names(params: PgConnectionParams) -> Result<Vec<String>, String> {
    let client = connect(&params).await?;
    let rows = client
        .query(
            "SELECT nspname FROM pg_catalog.pg_namespace \
             WHERE nspname IN ('pg_catalog', 'information_schema') \
             ORDER BY nspname",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| r.get::<_, String>(0))
        .collect())
}

#[derive(Debug, Clone, Copy)]
pub enum RelationKind {
    Tables,
    Views,
    MaterializedViews,
    Functions,
    Sequences,
}

pub fn parse_relation_kind(s: &str) -> Result<RelationKind, String> {
    match s {
        "tables" => Ok(RelationKind::Tables),
        "views" => Ok(RelationKind::Views),
        "materialized_views" => Ok(RelationKind::MaterializedViews),
        "functions" => Ok(RelationKind::Functions),
        "sequences" => Ok(RelationKind::Sequences),
        _ => Err(format!("Unknown relation kind: {s}")),
    }
}

pub async fn list_relation_objects(
    params: PgConnectionParams,
    schema: String,
    kind: RelationKind,
) -> Result<Vec<String>, String> {
    validate_ident(&schema)?;
    let client = connect(&params).await?;
    let rows = match kind {
        RelationKind::Tables => {
            client
                .query(
                    "SELECT table_name FROM information_schema.tables \
                     WHERE table_schema = $1 AND table_type = 'BASE TABLE' \
                     ORDER BY table_name",
                    &[&schema],
                )
                .await
        }
        RelationKind::Views => {
            client
                .query(
                    "SELECT table_name FROM information_schema.tables \
                     WHERE table_schema = $1 AND table_type = 'VIEW' \
                     ORDER BY table_name",
                    &[&schema],
                )
                .await
        }
        RelationKind::MaterializedViews => {
            client
                .query(
                    "SELECT matviewname FROM pg_catalog.pg_matviews \
                     WHERE schemaname = $1 ORDER BY matviewname",
                    &[&schema],
                )
                .await
        }
        RelationKind::Functions => {
            client
                .query(
                    "SELECT routine_name FROM information_schema.routines \
                     WHERE routine_schema = $1 AND routine_type = 'FUNCTION' \
                     ORDER BY routine_name",
                    &[&schema],
                )
                .await
        }
        RelationKind::Sequences => {
            client
                .query(
                    "SELECT sequence_name FROM information_schema.sequences \
                     WHERE sequence_schema = $1 ORDER BY sequence_name",
                    &[&schema],
                )
                .await
        }
    }
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| r.get::<_, String>(0)).collect())
}

pub async fn list_extensions(params: PgConnectionParams) -> Result<Vec<String>, String> {
    let client = connect(&params).await?;
    let rows = client
        .query(
            "SELECT extname FROM pg_catalog.pg_extension ORDER BY extname",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| r.get::<_, String>(0))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_ident_accepts_public() {
        validate_ident("public").unwrap();
    }

    #[test]
    fn validate_ident_rejects_semicolon() {
        assert!(validate_ident("bad;").is_err());
    }
}
