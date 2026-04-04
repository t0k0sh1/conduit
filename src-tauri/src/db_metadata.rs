//! PostgreSQL catalog queries for the object tree (lazy-loaded from the frontend).

use serde::{Deserialize, Serialize};
use tokio_postgres::NoTls;

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

async fn connect(params: &PgConnectionParams) -> Result<tokio_postgres::Client, String> {
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&params.host);
    cfg.port(params.port);
    cfg.user(&params.user);
    cfg.password(&params.password);
    cfg.dbname(&params.database);
    let (client, connection) = cfg.connect(NoTls).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
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
