package draw

import (
	"github.com/anchoo2kewl/go-draw/store"
)

// Option is a functional option for configuring Draw.
type Option func(*Draw)

// WithStore sets a custom storage backend.
// Defaults to a FileStore writing to "./draw-data".
func WithStore(s store.Store) Option {
	return func(d *Draw) {
		d.store = s
	}
}

// WithBasePath sets the URL prefix under which all draw routes are registered.
// Example: WithBasePath("/draw")  →  routes at /draw/, /draw/{id}, etc.
// Defaults to "/draw".
func WithBasePath(path string) Option {
	return func(d *Draw) {
		d.basePath = path
	}
}

// WithMaxSceneBytes caps the size of a scene payload accepted on save.
// Defaults to 2 MB.
func WithMaxSceneBytes(n int64) Option {
	return func(d *Draw) {
		d.maxSceneBytes = n
	}
}
