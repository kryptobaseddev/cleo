// Package fixture provides a minimal but realistic Go sample for
// extractor regression testing.
//
// Exercises: Function, Struct (with fields), Interface, Method (with
// receiver), struct embedding (heritage), and explicit import declarations.
package fixture

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Status represents the lifecycle state of an entity.
type Status int

const (
	StatusActive   Status = iota
	StatusInactive Status = iota
	StatusPending  Status = iota
)

// EntityID is a branded string identifier.
type EntityID = string

// Storable is implemented by all persistable domain objects.
type Storable interface {
	GetID() EntityID
	Save() error
	Delete() error
}

// Serializable is implemented by objects that can produce JSON.
type Serializable interface {
	ToJSON() ([]byte, error)
}

// BaseModel provides shared fields for domain entities.
type BaseModel struct {
	ID     EntityID
	Status Status
}

// GetID returns the entity identifier.
func (b *BaseModel) GetID() EntityID {
	return b.ID
}

// User is a concrete domain entity.
type User struct {
	BaseModel
	Email string
	Name  string
}

// Save persists the User (no-op in fixture).
func (u *User) Save() error {
	fmt.Printf("saving user %s\n", u.ID)
	return nil
}

// Delete removes the User (no-op in fixture).
func (u *User) Delete() error {
	return nil
}

// ToJSON serialises the User.
func (u *User) ToJSON() ([]byte, error) {
	return json.Marshal(u)
}

// BaseRepository provides in-memory storage for any Storable.
type BaseRepository struct {
	mu    sync.RWMutex
	items map[EntityID]Storable
}

// NewBaseRepository constructs a fresh BaseRepository.
func NewBaseRepository() *BaseRepository {
	return &BaseRepository{items: make(map[EntityID]Storable)}
}

// Save persists an entity.
func (r *BaseRepository) Save(s Storable) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[s.GetID()] = s
	return nil
}

// Delete removes an entity by ID.
func (r *BaseRepository) Delete(id EntityID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.items[id]; !ok {
		return errors.New("not found")
	}
	delete(r.items, id)
	return nil
}

// FindAll returns every stored entity.
func (r *BaseRepository) FindAll() []Storable {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Storable, 0, len(r.items))
	for _, v := range r.items {
		out = append(out, v)
	}
	return out
}

// Count returns the number of stored entities.
func (r *BaseRepository) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.items)
}

// UserRepository adds user-specific queries on top of BaseRepository.
type UserRepository struct {
	BaseRepository
	emailIndex map[string]EntityID
}

// NewUserRepository constructs a fresh UserRepository.
func NewUserRepository() *UserRepository {
	return &UserRepository{
		BaseRepository: *NewBaseRepository(),
		emailIndex:     make(map[string]EntityID),
	}
}

// AddUser stores a user and indexes by email.
func (r *UserRepository) AddUser(u *User) error {
	if err := r.Save(u); err != nil {
		return err
	}
	r.emailIndex[u.Email] = u.ID
	return nil
}

// FindByEmail locates a user by email address.
func (r *UserRepository) FindByEmail(email string) (*User, error) {
	id, ok := r.emailIndex[email]
	if !ok {
		return nil, errors.New("not found")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.items[id]
	if !ok {
		return nil, errors.New("not found")
	}
	u, ok := s.(*User)
	if !ok {
		return nil, errors.New("type mismatch")
	}
	return u, nil
}

// StreamReader wraps an io.Reader with read tracking.
type StreamReader struct {
	r     io.Reader
	total int64
}

// NewStreamReader wraps r.
func NewStreamReader(r io.Reader) *StreamReader {
	return &StreamReader{r: r}
}

// Read reads from the underlying reader.
func (sr *StreamReader) Read(p []byte) (int, error) {
	n, err := sr.r.Read(p)
	sr.total += int64(n)
	return n, err
}

// Total returns the total bytes read so far.
func (sr *StreamReader) Total() int64 {
	return sr.total
}

// MakeEntityID normalises a raw string into an EntityID.
func MakeEntityID(raw string) EntityID {
	return raw
}

// SafeJSON marshals v and returns nil on error.
func SafeJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}
