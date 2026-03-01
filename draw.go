// Package draw provides an embeddable canvas drawing editor and viewer for Go
// web applications. It follows the same embedding conventions as go-wiki:
// all HTML/CSS/JS assets are embedded via Go's embed package, no npm step
// required, and a single http.Handler is returned for mounting on any mux.
//
// Quick start:
//
//	d, err := draw.New(
//	    draw.WithBasePath("/draw"),
//	)
//	if err != nil {
//	    log.Fatal(err)
//	}
//	http.Handle("/draw/", d.Handler())
//	http.ListenAndServe(":8080", nil)
//
// Then visit /draw/ to list drawings, /draw/{id}/edit to author one, and
// embed /draw/{id} as a read-only viewport in any page.
package draw

import (
	"fmt"
	"net/http"
	"os"

	"github.com/anchoo2kewl/go-draw/store"
)

const defaultBasePath = "/draw"
const defaultMaxScene = int64(2 << 20) // 2 MB
const defaultStoreDir = "./draw-data"
const defaultUploadDir = "./draw-uploads"

// Draw is the top-level object. Create one with New() and mount its Handler.
type Draw struct {
	store         store.Store
	basePath      string
	maxSceneBytes int64
	uploadDir     string
}

// New creates a Draw instance with the provided options.
// If no WithStore option is given, a FileStore is created under ./draw-data.
func New(opts ...Option) (*Draw, error) {
	d := &Draw{
		basePath:      defaultBasePath,
		maxSceneBytes: defaultMaxScene,
		uploadDir:     defaultUploadDir,
	}
	for _, o := range opts {
		o(d)
	}
	if d.store == nil {
		fs, err := store.NewFileStore(defaultStoreDir)
		if err != nil {
			return nil, fmt.Errorf("go-draw: failed to initialise default file store: %w", err)
		}
		d.store = fs
	}
	if err := os.MkdirAll(d.uploadDir, 0o755); err != nil {
		return nil, fmt.Errorf("go-draw: failed to create upload directory: %w", err)
	}
	return d, nil
}

// Handler returns an http.Handler that serves all draw routes.
// Mount it with a trailing-slash prefix:
//
//	http.Handle("/draw/", draw.Handler())
func (d *Draw) Handler() http.Handler {
	return d.routes()
}

// ViewerSnippet returns an HTML <iframe> fragment that embeds the read-only
// viewer for the drawing with the given id. width and height are CSS values.
//
//	snippet := draw.ViewerSnippet("system-architecture", "100%", "520px")
func (d *Draw) ViewerSnippet(id, width, height string) string {
	return fmt.Sprintf(
		`<iframe src="%s/%s" width="%s" height="%s" style="border:none;border-radius:8px;" loading="lazy" allowfullscreen></iframe>`,
		d.basePath, id, width, height,
	)
}

// EditorSnippet returns an HTML <iframe> fragment that embeds the full editor
// for the drawing with the given id. width and height are CSS values.
//
//	snippet := draw.EditorSnippet("system-architecture", "100%", "600px")
func (d *Draw) EditorSnippet(id, width, height string) string {
	return fmt.Sprintf(
		`<iframe src="%s/%s/edit" width="%s" height="%s" style="border:none;border-radius:8px;" loading="lazy" allowfullscreen></iframe>`,
		d.basePath, id, width, height,
	)
}

// EmbedSnippet returns an HTML fragment with a resizable, fullscreen-capable
// container wrapping a go-draw iframe. It includes the embed.js widget script.
// The mode parameter should be "view" or "edit".
//
//	snippet := draw.EmbedSnippet("my-drawing", "100%", "520px", "view")
func (d *Draw) EmbedSnippet(id, width, height, mode string) string {
	src := fmt.Sprintf("%s/%s", d.basePath, id)
	if mode == "edit" {
		src += "/edit"
	}
	return fmt.Sprintf(
		`<div class="godraw-embed" data-src="%s" data-width="%s" data-height="%s" data-base-path="%s"></div>
<script data-cfasync="false" src="%s/static/embed.js"></script>`,
		src, width, height, d.basePath, d.basePath,
	)
}
