// Package runstore is an in-memory store of paused agent runs, keyed by
// threadID+runID, so an interrupted run can be resumed by a later request.
//
// This is deliberately process-local and non-durable — it exists to demonstrate
// the AG-UI interrupt -> resume cycle for the local proof, not for production.
//
// KEY-TRUST CAVEAT: keys are built from the client-supplied threadID/runID and
// are neither authenticated nor namespaced per caller. Within one process a
// client that reuses another client's IDs could overwrite or drain a paused run.
// A bounded size + TTL caps memory; real multi-tenant use must gate /agentic
// behind auth and namespace keys by the authenticated principal.
package runstore

import (
	"sync"
	"time"

	"github.com/cloudwego/eino/schema"
)

const (
	// defaultTTL is how long a paused run survives without being resumed.
	defaultTTL = 30 * time.Minute
	// defaultMaxEntries caps the number of paused runs held at once.
	defaultMaxEntries = 1024
)

// Saved is the state captured when a run pauses on a tool-approval interrupt.
type Saved struct {
	// Messages is the full eino conversation up to and including the assistant
	// message that proposed the pending tool calls. The assistant message is kept
	// whole (including Extra, which carries reasoning items the codex model needs
	// threaded across turns).
	Messages []*schema.Message
	// Pending are the tool calls awaiting human approval.
	Pending []schema.ToolCall
	// State is the agent state snapshot at pause time.
	State map[string]any
}

type entry struct {
	saved *Saved
	at    time.Time
}

// Store is a concurrency-safe map of paused runs with lazy TTL expiry and a
// bounded size (oldest-evicted on overflow).
type Store struct {
	mu         sync.Mutex
	m          map[string]*entry
	ttl        time.Duration
	maxEntries int
	now        func() time.Time // injectable clock for tests
}

// New creates an empty Store with default TTL and size bound.
func New() *Store {
	return &Store{
		m:          make(map[string]*entry),
		ttl:        defaultTTL,
		maxEntries: defaultMaxEntries,
		now:        time.Now,
	}
}

// Key builds the lookup key for a run.
func Key(threadID, runID string) string {
	return threadID + "|" + runID
}

// Save records a paused run. It purges expired entries first, then evicts the
// oldest entry if the store is still at capacity.
func (s *Store) Save(key string, saved *Saved) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.purgeExpiredLocked(now)
	if _, exists := s.m[key]; !exists && len(s.m) >= s.maxEntries {
		s.evictOldestLocked()
	}
	// Copy the caller's slices and State map so the store owns its data and a
	// later mutation of the caller's Messages/Pending/State can't reach the saved
	// run. (The *schema.Message pointees are still shared by reference; the only
	// caller builds a fresh messages slice per turn and never mutates a message in
	// place, so a deep clone of the pointees would be wasted work.)
	state := make(map[string]any, len(saved.State))
	for k, v := range saved.State {
		state[k] = v
	}
	stored := &Saved{
		Messages: append([]*schema.Message(nil), saved.Messages...),
		Pending:  append([]schema.ToolCall(nil), saved.Pending...),
		State:    state,
	}
	s.m[key] = &entry{saved: stored, at: now}
}

// Load returns a paused run and whether it was present. An entry past its TTL is
// treated as a miss and deleted in-line.
func (s *Store) Load(key string) (*Saved, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.m[key]
	if !ok {
		return nil, false
	}
	if s.now().Sub(e.at) >= s.ttl {
		delete(s.m, key)
		return nil, false
	}
	return e.saved, true
}

// Delete removes a paused run (called once it has been resumed).
func (s *Store) Delete(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, key)
}

// LoadAndDelete atomically returns a paused run and removes it from the store, so
// exactly one caller can claim a given paused run. An entry past its TTL is treated
// as a miss (and is still removed). This is the resume primitive: a plain
// Load-then-Delete is a TOCTOU race that lets two concurrent resumes of the same
// thread/run both observe the entry and both execute its pending tool calls.
func (s *Store) LoadAndDelete(key string) (*Saved, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.m[key]
	if !ok {
		return nil, false
	}
	delete(s.m, key)
	if s.now().Sub(e.at) >= s.ttl {
		return nil, false
	}
	return e.saved, true
}

func (s *Store) purgeExpiredLocked(now time.Time) {
	for k, e := range s.m {
		if now.Sub(e.at) >= s.ttl {
			delete(s.m, k)
		}
	}
}

func (s *Store) evictOldestLocked() {
	var oldestKey string
	var oldestAt time.Time
	first := true
	for k, e := range s.m {
		if first || e.at.Before(oldestAt) {
			oldestKey, oldestAt, first = k, e.at, false
		}
	}
	if !first {
		delete(s.m, oldestKey)
	}
}
