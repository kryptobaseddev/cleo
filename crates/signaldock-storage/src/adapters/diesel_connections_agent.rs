//! Diesel implementation of [`AgentConnectionRepository`].
//!
//! Manages SSE/WebSocket connection lifecycle in the `agent_connections` table.

use anyhow::Result;
use async_trait::async_trait;
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use uuid::Uuid;

use crate::adapters::diesel_helpers::*;
use crate::adapters::diesel_store::DieselStore;
use crate::schema::agent_connections;
use crate::traits::{AgentConnection, AgentConnectionRepository};

/// Diesel row for reading from `agent_connections`.
#[derive(Queryable, Selectable, Debug)]
#[diesel(table_name = agent_connections)]
#[cfg_attr(feature = "sqlite", diesel(check_for_backend(diesel::sqlite::Sqlite)))]
#[cfg_attr(feature = "postgres", diesel(check_for_backend(diesel::pg::Pg)))]
struct AgentConnectionRow {
    id: String,
    agent_id: String,
    transport_type: String,
    connection_id: Option<String>,
    connected_at: i64,
    last_heartbeat: i64,
    connection_metadata: Option<String>,
    created_at: i64,
}

/// Diesel row for inserting into `agent_connections`.
#[derive(Insertable, Debug)]
#[diesel(table_name = agent_connections)]
struct NewAgentConnectionRow {
    id: String,
    agent_id: String,
    transport_type: String,
    connection_id: Option<String>,
    connected_at: i64,
    last_heartbeat: i64,
    connection_metadata: Option<String>,
    created_at: i64,
}

fn row_to_connection(row: AgentConnectionRow) -> AgentConnection {
    AgentConnection {
        id: row.id,
        agent_id: row.agent_id,
        transport_type: row.transport_type,
        connection_id: row.connection_id,
        connected_at: row.connected_at,
        last_heartbeat: row.last_heartbeat,
        connection_metadata: row.connection_metadata,
        created_at: row.created_at,
    }
}

/// Generates `AgentConnectionRepository` impl for a concrete connection type.
macro_rules! impl_agent_connection_repository {
    ($conn:ty) => {
        #[async_trait]
        impl AgentConnectionRepository for DieselStore<$conn> {
            async fn open_connection(
                &self,
                agent_id: &str,
                transport_type: &str,
                connection_id: Option<&str>,
                metadata: Option<&str>,
            ) -> Result<AgentConnection> {
                let now = now_ts();
                let id = Uuid::new_v4().to_string();
                let new_row = NewAgentConnectionRow {
                    id: id.clone(),
                    agent_id: agent_id.to_string(),
                    transport_type: transport_type.to_string(),
                    connection_id: connection_id.map(String::from),
                    connected_at: now,
                    last_heartbeat: now,
                    connection_metadata: metadata.map(String::from),
                    created_at: now,
                };

                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::insert_into(agent_connections::table)
                    .values(&new_row)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                let row: AgentConnectionRow = agent_connections::table
                    .find(&id)
                    .first(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                Ok(row_to_connection(row))
            }

            async fn heartbeat(&self, id: &str) -> Result<()> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(agent_connections::table.find(id))
                    .set(agent_connections::last_heartbeat.eq(now))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(())
            }

            async fn close_connection(&self, id: &str) -> Result<()> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::delete(agent_connections::table.find(id))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(())
            }

            async fn list_connections(&self, agent_id: &str) -> Result<Vec<AgentConnection>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let rows: Vec<AgentConnectionRow> = agent_connections::table
                    .filter(agent_connections::agent_id.eq(agent_id))
                    .order(agent_connections::connected_at.desc())
                    .load(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(rows.into_iter().map(row_to_connection).collect())
            }

            async fn reap_stale(&self, before_ts: i64) -> Result<u64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let deleted = diesel::delete(
                    agent_connections::table
                        .filter(agent_connections::last_heartbeat.lt(before_ts)),
                )
                .execute(&mut conn)
                .await
                .map_err(diesel_err)?;
                Ok(deleted as u64)
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_agent_connection_repository!(SqliteConn);

#[cfg(feature = "postgres")]
impl_agent_connection_repository!(PgConn);
