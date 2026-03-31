//! Diesel table definitions for the SignalDock storage schema.
//!
//! These `table!` macros define the SQLite schema that the Diesel adapters
//! operate on. Table names and column types mirror the consolidated migration
//! at `migrations/2026-03-28-000000_initial/up.sql`.
//!
//! **Note:** The `messages_fts` virtual table (FTS5) is not representable
//! in Diesel `table!` macros and is managed via raw SQL.

diesel::table! {
    /// Core user accounts for SignalDock platform.
    users (id) {
        id -> Text,
        email -> Text,
        password_hash -> Text,
        name -> Nullable<Text>,
        slug -> Nullable<Text>,
        default_agent_id -> Nullable<Text>,
        username -> Nullable<Text>,
        display_username -> Nullable<Text>,
        email_verified -> Bool,
        image -> Nullable<Text>,
        role -> Text,
        banned -> Bool,
        ban_reason -> Nullable<Text>,
        ban_expires -> Nullable<Text>,
        two_factor_enabled -> Bool,
        metadata -> Nullable<Text>,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    /// Multi-tenant organizations for agent fleet management.
    organization (id) {
        id -> Text,
        name -> Text,
        slug -> Nullable<Text>,
        logo -> Nullable<Text>,
        metadata -> Nullable<Text>,
        owner_id -> Nullable<Text>,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    /// Registered agents with capabilities, skills, and connection metadata.
    agents (id) {
        id -> Text,
        agent_id -> Text,
        name -> Text,
        description -> Nullable<Text>,
        class -> Text,
        privacy_tier -> Text,
        owner_id -> Nullable<Text>,
        endpoint -> Nullable<Text>,
        webhook_secret -> Nullable<Text>,
        capabilities -> Text,
        skills -> Text,
        avatar -> Nullable<Text>,
        messages_sent -> Integer,
        messages_received -> Integer,
        conversation_count -> Integer,
        friend_count -> Integer,
        status -> Text,
        last_seen -> Nullable<BigInt>,
        payment_config -> Nullable<Text>,
        api_key_hash -> Nullable<Text>,
        organization_id -> Nullable<Text>,
        transport_type -> Text,
        api_key_encrypted -> Nullable<Text>,
        api_base_url -> Text,
        classification -> Nullable<Text>,
        transport_config -> Text,
        is_active -> Bool,
        last_used_at -> Nullable<BigInt>,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    /// Active agent connections for SSE/WebSocket heartbeat and stale detection.
    agent_connections (id) {
        id -> Text,
        agent_id -> Text,
        transport_type -> Text,
        connection_id -> Nullable<Text>,
        connected_at -> BigInt,
        last_heartbeat -> BigInt,
        connection_metadata -> Nullable<Text>,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Conversation threads between agents.
    conversations (id) {
        id -> Text,
        participants -> Text,
        visibility -> Text,
        message_count -> Integer,
        last_message_at -> Nullable<BigInt>,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    /// Individual messages within conversations.
    messages (id) {
        id -> Text,
        conversation_id -> Text,
        from_agent_id -> Text,
        to_agent_id -> Text,
        content -> Text,
        content_type -> Text,
        status -> Text,
        attachments -> Text,
        group_id -> Nullable<Text>,
        metadata -> Nullable<Text>,
        reply_to -> Nullable<Text>,
        created_at -> BigInt,
        delivered_at -> Nullable<BigInt>,
        read_at -> Nullable<BigInt>,
    }
}

diesel::table! {
    /// One-time claim codes for agent ownership transfer.
    claim_codes (id) {
        id -> Text,
        agent_id -> Text,
        code -> Text,
        expires_at -> BigInt,
        used_at -> Nullable<BigInt>,
        used_by -> Nullable<Text>,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Bidirectional agent-to-agent connections (friendships).
    connections (id) {
        id -> Text,
        agent_a -> Text,
        agent_b -> Text,
        status -> Text,
        initiated_by -> Text,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    /// Persistent delivery job queue with retry backoff.
    delivery_jobs (id) {
        id -> Text,
        message_id -> Text,
        payload -> Text,
        status -> Text,
        attempts -> Integer,
        max_attempts -> Integer,
        next_attempt_at -> BigInt,
        last_error -> Nullable<Text>,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    /// Permanently failed delivery jobs that exhausted all retries.
    dead_letters (id) {
        id -> Text,
        message_id -> Text,
        job_id -> Text,
        reason -> Text,
        attempts -> Integer,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Pinned messages for bookmarking important content.
    message_pins (id) {
        id -> Text,
        message_id -> Text,
        conversation_id -> Text,
        pinned_by -> Text,
        note -> Nullable<Text>,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Compressed content blobs with versioning and lifecycle management.
    attachments (slug) {
        slug -> Text,
        conversation_id -> Text,
        from_agent_id -> Text,
        content -> Binary,
        original_size -> BigInt,
        compressed_size -> BigInt,
        content_hash -> Text,
        format -> Text,
        title -> Nullable<Text>,
        tokens -> BigInt,
        expires_at -> BigInt,
        storage_key -> Nullable<Text>,
        mode -> Text,
        version_count -> Integer,
        current_version -> Integer,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Canonical capability definitions for the agent registry.
    capabilities (id) {
        id -> Text,
        slug -> Text,
        name -> Text,
        description -> Text,
        category -> Text,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Canonical skill definitions for the agent registry.
    skills (id) {
        id -> Text,
        slug -> Text,
        name -> Text,
        description -> Text,
        category -> Text,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Junction table linking agents to their capabilities.
    agent_capabilities (agent_id, capability_id) {
        agent_id -> Text,
        capability_id -> Text,
    }
}

diesel::table! {
    /// Junction table linking agents to their skills.
    agent_skills (agent_id, skill_id) {
        agent_id -> Text,
        skill_id -> Text,
    }
}

diesel::table! {
    /// OAuth provider account links (better-auth).
    accounts (id) {
        id -> Text,
        user_id -> Text,
        account_id -> Text,
        provider_id -> Text,
        access_token -> Nullable<Text>,
        refresh_token -> Nullable<Text>,
        id_token -> Nullable<Text>,
        access_token_expires_at -> Nullable<Text>,
        refresh_token_expires_at -> Nullable<Text>,
        scope -> Nullable<Text>,
        password -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    /// Active user sessions (better-auth).
    sessions (id) {
        id -> Text,
        user_id -> Text,
        token -> Text,
        ip_address -> Nullable<Text>,
        user_agent -> Nullable<Text>,
        expires_at -> Text,
        active_organization_id -> Nullable<Text>,
        impersonated_by -> Nullable<Text>,
        active -> Bool,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    /// Email and reset verification tokens (better-auth).
    verifications (id) {
        id -> Text,
        identifier -> Text,
        value -> Text,
        expires_at -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    /// Organization-scoped API keys for agent fleet management.
    org_agent_keys (id) {
        id -> Text,
        organization_id -> Text,
        agent_id -> Text,
        created_by -> Text,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Version history for collaborative document attachments.
    attachment_versions (id) {
        id -> Text,
        slug -> Text,
        version_number -> Integer,
        author_agent_id -> Text,
        change_type -> Text,
        patch_text -> Nullable<Text>,
        storage_key -> Text,
        content_hash -> Text,
        original_size -> BigInt,
        compressed_size -> BigInt,
        tokens -> BigInt,
        change_summary -> Nullable<Text>,
        sections_modified -> Text,
        tokens_added -> BigInt,
        tokens_removed -> BigInt,
        created_at -> BigInt,
    }
}

diesel::table! {
    /// Approval tracking for collaborative document review workflows.
    attachment_approvals (id) {
        id -> Text,
        slug -> Text,
        reviewer_agent_id -> Text,
        status -> Text,
        comment -> Nullable<Text>,
        version_reviewed -> Integer,
        created_at -> BigInt,
        updated_at -> BigInt,
    }
}

diesel::table! {
    /// Materialized contributor summary for collaborative documents.
    attachment_contributors (slug, agent_id) {
        slug -> Text,
        agent_id -> Text,
        version_count -> Integer,
        total_tokens_added -> BigInt,
        total_tokens_removed -> BigInt,
        first_contribution_at -> BigInt,
        last_contribution_at -> BigInt,
    }
}

// ============================================================================
// Foreign key relationships (joinable! macros)
// ============================================================================

diesel::joinable!(agent_connections -> agents (agent_id));
diesel::joinable!(agents -> users (owner_id));
diesel::joinable!(agents -> organization (organization_id));
diesel::joinable!(messages -> conversations (conversation_id));
diesel::joinable!(claim_codes -> agents (agent_id));
diesel::joinable!(claim_codes -> users (used_by));
diesel::joinable!(agent_capabilities -> agents (agent_id));
diesel::joinable!(agent_capabilities -> capabilities (capability_id));
diesel::joinable!(agent_skills -> agents (agent_id));
diesel::joinable!(agent_skills -> skills (skill_id));
diesel::joinable!(accounts -> users (user_id));
diesel::joinable!(sessions -> users (user_id));
diesel::joinable!(org_agent_keys -> organization (organization_id));
diesel::joinable!(org_agent_keys -> agents (agent_id));
diesel::joinable!(attachment_versions -> attachments (slug));
diesel::joinable!(attachment_approvals -> attachments (slug));
diesel::joinable!(attachment_contributors -> attachments (slug));

// ============================================================================
// Cross-table query allowlist
// ============================================================================

diesel::allow_tables_to_appear_in_same_query!(
    users,
    organization,
    agents,
    agent_connections,
    conversations,
    messages,
    claim_codes,
    connections,
    delivery_jobs,
    dead_letters,
    message_pins,
    attachments,
    capabilities,
    skills,
    agent_capabilities,
    agent_skills,
    accounts,
    sessions,
    verifications,
    org_agent_keys,
    attachment_versions,
    attachment_approvals,
    attachment_contributors,
);
