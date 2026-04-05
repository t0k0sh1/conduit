//! PostgreSQL catalog queries for the object tree (lazy-loaded from the frontend).

use serde::{Deserialize, Serialize};
use tokio_postgres::error::{DbError, ErrorPosition};
use tokio_postgres::{Error as PgError, NoTls, SimpleQueryMessage};

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

/// Read-only row preview for a table, view, or materialized view (`SELECT * ... LIMIT`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePreview {
    pub columns: Vec<String>,
    pub rows: Vec<serde_json::Value>,
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

    // `information_schema.columns` omits materialized views in PostgreSQL, so column
    // metadata would be empty and the UI would show a row count with no cells.
    let col_rows = client
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
        .map_err(|e| e.to_string())?;
    let columns: Vec<String> = col_rows
        .into_iter()
        .map(|r| r.get::<_, String>(0))
        .collect();

    let fq = format!(
        "SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text \
         FROM (SELECT * FROM {}.{} LIMIT $1) t",
        quote_ident(&schema),
        quote_ident(&table)
    );
    let data_row = client
        .query_one(&fq, &[&lim_i64])
        .await
        .map_err(|e| e.to_string())?;
    let json_text: String = data_row.get(0);
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&json_text).map_err(|e| e.to_string())?;

    Ok(TablePreview { columns, rows })
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

/// User-facing schemas (excludes `pg_*`, `information_schema`, etc.).
pub async fn list_user_schemas(params: PgConnectionParams) -> Result<Vec<String>, String> {
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
    Ok(rows
        .into_iter()
        .map(|r| r.get::<_, String>(0))
        .collect())
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
