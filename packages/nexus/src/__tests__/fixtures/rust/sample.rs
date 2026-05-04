//! Fixture file for the Rust extractor regression tests.
//!
//! Exercises every node kind: fn (function), struct (with fields and impl),
//! enum, trait, impl (bare + trait-for-struct = heritage), type alias,
//! const, static, mod (inline), and explicit use declarations.

use std::collections::HashMap;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

// --- Type alias ---

/// Branded string identifier for entities.
pub type EntityId = String;

// --- Constants and statics ---

/// Default capacity for in-memory repositories.
pub const DEFAULT_CAPACITY: usize = 64;

/// Global repository instance counter (for testing only).
pub static INSTANCE_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

// --- Enum ---

/// Lifecycle status of a domain entity.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Active,
    Inactive,
    Pending,
}

impl Display for Status {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Status::Active => write!(f, "active"),
            Status::Inactive => write!(f, "inactive"),
            Status::Pending => write!(f, "pending"),
        }
    }
}

// --- Traits ---

/// Contract for persistable domain objects.
pub trait Storable {
    fn get_id(&self) -> &EntityId;
    fn save(&mut self) -> io::Result<()>;
    fn delete(&mut self) -> io::Result<()>;
}

/// Contract for JSON-serialisable objects.
pub trait Serializable {
    fn to_json(&self) -> String;
}

// --- Structs ---

/// Shared fields for all domain entities.
pub struct BaseModel {
    pub id: EntityId,
    pub status: Status,
}

impl BaseModel {
    /// Construct a new BaseModel.
    pub fn new(id: EntityId) -> Self {
        BaseModel { id, status: Status::Active }
    }

    /// Check whether the entity is active.
    pub fn is_active(&self) -> bool {
        self.status == Status::Active
    }
}

/// A concrete user domain entity.
pub struct User {
    pub base: BaseModel,
    pub email: String,
    pub name: String,
}

impl User {
    /// Construct a new User.
    pub fn new(id: EntityId, email: String, name: String) -> Self {
        User { base: BaseModel::new(id), email, name }
    }
}

impl Storable for User {
    fn get_id(&self) -> &EntityId {
        &self.base.id
    }

    fn save(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn delete(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Serializable for User {
    fn to_json(&self) -> String {
        format!("{{\"id\":\"{}\",\"email\":\"{}\"}}", self.base.id, self.email)
    }
}

/// In-memory repository generic over any Storable.
pub struct BaseRepository {
    items: HashMap<EntityId, Box<dyn Storable>>,
}

impl BaseRepository {
    /// Construct an empty repository.
    pub fn new() -> Self {
        INSTANCE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        BaseRepository { items: HashMap::with_capacity(DEFAULT_CAPACITY) }
    }

    /// Save an entity into the repository.
    pub fn save<S: Storable + 'static>(&mut self, entity: S) {
        self.items.insert(entity.get_id().clone(), Box::new(entity));
    }

    /// Delete an entity by ID.
    pub fn delete(&mut self, id: &EntityId) -> bool {
        self.items.remove(id).is_some()
    }

    /// Return all entity IDs.
    pub fn ids(&self) -> Vec<&EntityId> {
        self.items.keys().collect()
    }

    /// Return the number of stored entities.
    pub fn count(&self) -> usize {
        self.items.len()
    }
}

/// Thread-safe wrapper around BaseRepository.
pub struct SyncRepository {
    inner: Arc<Mutex<BaseRepository>>,
}

impl SyncRepository {
    /// Construct a fresh SyncRepository.
    pub fn new() -> Self {
        SyncRepository { inner: Arc::new(Mutex::new(BaseRepository::new())) }
    }

    /// Save an entity (acquires lock).
    pub fn save<S: Storable + 'static>(&self, entity: S) {
        let mut guard = self.inner.lock().unwrap();
        guard.save(entity);
    }

    /// Return the count of stored entities (acquires lock).
    pub fn count(&self) -> usize {
        let guard = self.inner.lock().unwrap();
        guard.count()
    }
}

// --- A stream reader struct ---

/// Wrapper that counts bytes read from any Read source.
pub struct StreamReader<R: Read> {
    source: R,
    total: u64,
}

impl<R: Read> StreamReader<R> {
    /// Wrap an existing reader.
    pub fn new(source: R) -> Self {
        StreamReader { source, total: 0 }
    }

    /// Return total bytes read so far.
    pub fn total(&self) -> u64 {
        self.total
    }
}

impl<R: Read> Read for StreamReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.source.read(buf)?;
        self.total += n as u64;
        Ok(n)
    }
}

// --- Top-level functions ---

/// Create a well-formed EntityId from a raw string.
pub fn make_entity_id(raw: &str) -> EntityId {
    raw.trim().to_lowercase()
}

/// Parse a JSON string and return the value or None.
pub fn safe_parse(json: &str) -> Option<serde_json::Value> {
    serde_json::from_str(json).ok()
}

// --- Inline module (exercises mod node kind) ---

/// Utilities for identifier manipulation.
pub mod util {
    use std::collections::HashSet;

    /// Normalise a raw identifier string.
    pub fn normalise(raw: &str) -> String {
        raw.trim().to_lowercase().replace(' ', "_")
    }

    /// Check whether a string is a reserved identifier.
    pub fn is_reserved(id: &str, reserved: &HashSet<&str>) -> bool {
        reserved.contains(id)
    }
}
