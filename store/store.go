// Package store defines the storage interface and a default file-based
// implementation for persisting drawing data as JSON files on disk.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ErrNotFound is returned when a drawing does not exist.
var ErrNotFound = errors.New("drawing not found")

// Drawing is the on-disk representation of a saved canvas.
type Drawing struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
	Scene     json.RawMessage `json:"scene"` // opaque canvas JSON from the frontend
}

// Store is the interface every storage backend must satisfy.
type Store interface {
	// Get retrieves a drawing by its ID. Returns ErrNotFound if missing.
	Get(id string) (*Drawing, error)
	// Save creates or updates a drawing.
	Save(d *Drawing) error
	// List returns metadata for all saved drawings (Scene omitted).
	List() ([]*Drawing, error)
	// Delete removes a drawing.
	Delete(id string) error
}

// slugRE validates drawing IDs (URL-safe slugs).
var slugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{0,62}$`)

// ValidateID checks that id is a safe slug.
func ValidateID(id string) error {
	if !slugRE.MatchString(id) {
		return fmt.Errorf("id %q is not a valid slug (lowercase alphanumeric + hyphens, 1-63 chars)", id)
	}
	return nil
}

// FileStore stores each drawing as a single JSON file under a base directory.
type FileStore struct {
	dir string
}

// NewFileStore creates a FileStore that keeps files in dir.
// The directory is created if it does not exist.
func NewFileStore(dir string) (*FileStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("go-draw/store: cannot create directory %s: %w", dir, err)
	}
	return &FileStore{dir: dir}, nil
}

func (fs *FileStore) path(id string) string {
	return filepath.Join(fs.dir, id+".json")
}

func (fs *FileStore) Get(id string) (*Drawing, error) {
	data, err := os.ReadFile(fs.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var d Drawing
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("go-draw/store: corrupt file for %s: %w", id, err)
	}
	return &d, nil
}

func (fs *FileStore) Save(d *Drawing) error {
	if err := ValidateID(d.ID); err != nil {
		return err
	}
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	tmp := fs.path(d.ID) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, fs.path(d.ID))
}

func (fs *FileStore) List() ([]*Drawing, error) {
	entries, err := os.ReadDir(fs.dir)
	if err != nil {
		return nil, err
	}
	var out []*Drawing
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		d, err := fs.Get(id)
		if err != nil {
			continue // skip corrupt files
		}
		// Return lightweight copy without scene blob
		out = append(out, &Drawing{
			ID:        d.ID,
			Title:     d.Title,
			CreatedAt: d.CreatedAt,
			UpdatedAt: d.UpdatedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out, nil
}

func (fs *FileStore) Delete(id string) error {
	err := os.Remove(fs.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	return err
}
