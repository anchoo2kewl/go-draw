package draw

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/anchoo2kewl/go-draw/store"
)

// routes returns a single http.Handler that dispatches all draw endpoints.
// It uses manual path matching (not http.ServeMux) so the handler is fully
// compatible with routers that set r.SetPathValue or r.Pattern before
// dispatching (e.g. chi v5.2+ with Go 1.22+).
//
// Route map (assuming basePath = "/draw"):
//
//	GET  /draw/              → list all drawings
//	GET  /draw/new           → create a new drawing and redirect to /edit
//	GET  /draw/{id}          → read-only viewer
//	GET  /draw/{id}/edit     → full editor
//	GET  /draw/{id}/data     → raw scene JSON (used by frontend)
//	POST /draw/{id}/save     → persist scene JSON
//	POST /draw/{id}/delete   → remove drawing
//	POST /draw/api/new       → create drawing, return JSON {id, edit_url, view_url}
//	GET  /draw/api/list      → list all drawings as JSON
//	POST /draw/api/{id}/rename → rename drawing, return JSON {ok: true}
//	POST /draw/api/{id}/delete → delete drawing, return JSON {ok: true}
//	GET  /draw/static/...    → embedded CSS/JS/icons
func (d *Draw) routes() http.Handler {
	base := strings.TrimRight(d.basePath, "/")

	// Static assets — fs.Sub strips the "static/" prefix from the embedded FS.
	staticSub, _ := fs.Sub(staticFS, "static")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Strip the base prefix to get the remainder.
		path := strings.TrimPrefix(r.URL.Path, base)
		path = strings.TrimPrefix(path, "/")

		// Static assets: serve directly from embedded FS.
		// Sets Cache-Control and explicit Content-Type so that parent router
		// middleware (e.g. SetHeader("Content-Type","application/json")) is
		// overridden for JS/CSS files.
		if strings.HasPrefix(path, "static/") {
			fileName := strings.TrimPrefix(path, "static/")
			if fileName == "" {
				http.NotFound(w, r)
				return
			}
			// Clear any Content-Type set by parent middleware (e.g. "application/json")
			// so http.ServeFileFS can detect the correct MIME type from the extension.
			w.Header().Del("Content-Type")
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFileFS(w, r, staticSub, fileName)
			return
		}

		// Uploaded images: serve from uploadDir with long cache.
		if strings.HasPrefix(path, "uploads/") {
			fileName := strings.TrimPrefix(path, "uploads/")
			if fileName == "" || strings.Contains(fileName, "..") {
				http.NotFound(w, r)
				return
			}
			w.Header().Del("Content-Type")
			w.Header().Set("Cache-Control", "public, max-age=31536000")
			http.ServeFile(w, r, filepath.Join(d.uploadDir, fileName))
			return
		}

		switch {
		case path == "" || path == "/":
			d.handleList(w, r)

		case path == "new":
			d.handleNew(w, r)

		case path == "api/new":
			if r.Method == http.MethodPost {
				d.handleAPINew(w, r)
			} else {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}

		case path == "api/list":
			d.handleAPIList(w, r)

		case path == "api/upload":
			if r.Method == http.MethodPost {
				d.handleUpload(w, r)
			} else {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}

		case strings.HasPrefix(path, "api/") && strings.HasSuffix(path, "/rename"):
			if r.Method == http.MethodPost {
				id := strings.TrimPrefix(path, "api/")
				id = strings.TrimSuffix(id, "/rename")
				d.handleAPIRename(w, r, id)
			} else {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}

		case strings.HasPrefix(path, "api/") && strings.HasSuffix(path, "/delete"):
			if r.Method == http.MethodPost {
				id := strings.TrimPrefix(path, "api/")
				id = strings.TrimSuffix(id, "/delete")
				d.handleAPIDelete(w, r, id)
			} else {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}

		default:
			// /draw/{id}  or  /draw/{id}/edit  or  /draw/{id}/data  etc.
			parts := strings.SplitN(path, "/", 2)
			id := parts[0]
			sub := ""
			if len(parts) == 2 {
				sub = parts[1]
			}
			switch sub {
			case "edit":
				d.handleEditor(w, r, id)
			case "data":
				d.handleData(w, r, id)
			case "save":
				if r.Method == http.MethodPost {
					d.handleSave(w, r, id)
				} else {
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				}
			case "delete":
				if r.Method == http.MethodPost {
					d.handleDelete(w, r, id)
				} else {
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				}
			case "":
				d.handleViewer(w, r, id)
			default:
				http.NotFound(w, r)
			}
		}
	})
}

// ── List ─────────────────────────────────────────────────────────────────────

var listTmpl = template.Must(template.New("list").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drawings</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8f8f8;color:#1e1e2e;padding:2rem}
  h1{font-size:1.5rem;margin-bottom:1.5rem;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
  .card{background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:1.2rem 1.4rem;display:flex;flex-direction:column;gap:.5rem}
  .card h2{font-size:1rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .card .meta{font-size:.75rem;color:#888}
  .card .actions{display:flex;gap:.5rem;margin-top:.4rem}
  .btn{display:inline-block;padding:.3rem .8rem;border-radius:6px;font-size:.8rem;text-decoration:none;border:none;cursor:pointer}
  .btn-view{background:#f0f0f0;color:#333}
  .btn-edit{background:#1e1e2e;color:#fff}
  .btn-del{background:#fee2e2;color:#dc2626}
  .new-btn{display:inline-flex;align-items:center;gap:.4rem;background:#1e1e2e;color:#fff;padding:.55rem 1.1rem;border-radius:8px;text-decoration:none;font-size:.875rem;margin-bottom:1.5rem}
  .empty{color:#888;font-size:.9rem;margin-top:1rem}
</style>
</head>
<body>
<a class="new-btn" href="{{.BasePath}}/new">+ New Drawing</a>
<h1>Drawings</h1>
{{if .Drawings}}
<div class="grid">
{{range .Drawings}}
  <div class="card">
    <h2>{{if .Title}}{{.Title}}{{else}}(untitled){{end}}</h2>
    <div class="meta">Updated {{.UpdatedAt.Format "Jan 2, 2006 15:04"}}</div>
    <div class="actions">
      <a class="btn btn-view" href="{{$.BasePath}}/{{.ID}}">View</a>
      <a class="btn btn-edit" href="{{$.BasePath}}/{{.ID}}/edit">Edit</a>
      <form method="POST" action="{{$.BasePath}}/{{.ID}}/delete" style="display:inline" onsubmit="return confirm('Delete this drawing?')">
        <button class="btn btn-del" type="submit">Delete</button>
      </form>
    </div>
  </div>
{{end}}
</div>
{{else}}
<p class="empty">No drawings yet. Create your first one above.</p>
{{end}}
</body>
</html>`))

func (d *Draw) handleList(w http.ResponseWriter, r *http.Request) {
	drawings, err := d.store.List()
	if err != nil {
		http.Error(w, "failed to list drawings", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	listTmpl.Execute(w, map[string]any{
		"Drawings": drawings,
		"BasePath": d.basePath,
	})
}

// ── New ───────────────────────────────────────────────────────────────────────

func (d *Draw) handleNew(w http.ResponseWriter, r *http.Request) {
	id := newID()
	drawing := &store.Drawing{
		ID:        id,
		Title:     "Untitled",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		Scene:     json.RawMessage(`{"version":1,"elements":[]}`),
	}
	if err := d.store.Save(drawing); err != nil {
		http.Error(w, "could not create drawing: "+err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, d.basePath+"/"+id+"/edit", http.StatusSeeOther)
}

// ── API New (JSON) ───────────────────────────────────────────────────────────

func (d *Draw) handleAPINew(w http.ResponseWriter, r *http.Request) {
	id := newID()
	drawing := &store.Drawing{
		ID:        id,
		Title:     "Untitled",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		Scene:     json.RawMessage(`{"version":1,"elements":[]}`),
	}
	if err := d.store.Save(drawing); err != nil {
		http.Error(w, "could not create drawing: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(map[string]string{
		"id":       id,
		"edit_url": d.basePath + "/" + id + "/edit",
		"view_url": d.basePath + "/" + id,
	})
}

// ── Data (JSON) ───────────────────────────────────────────────────────────────

func (d *Draw) handleData(w http.ResponseWriter, r *http.Request, id string) {
	drawing, err := d.store.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(map[string]any{
		"id":    drawing.ID,
		"title": drawing.Title,
		"scene": drawing.Scene,
	})
}

// ── Save ──────────────────────────────────────────────────────────────────────

type saveRequest struct {
	Title string          `json:"title"`
	Scene json.RawMessage `json:"scene"`
}

func (d *Draw) handleSave(w http.ResponseWriter, r *http.Request, id string) {
	body := http.MaxBytesReader(w, r.Body, d.maxSceneBytes)
	raw, err := io.ReadAll(body)
	if err != nil {
		http.Error(w, "request too large or read error", http.StatusRequestEntityTooLarge)
		return
	}

	var req saveRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	existing, err := d.store.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		// auto-create if frontend somehow hits save on unknown id
		existing = &store.Drawing{
			ID:        id,
			CreatedAt: time.Now(),
		}
	} else if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	existing.Title = req.Title
	existing.Scene = req.Scene
	existing.UpdatedAt = time.Now()

	if err := d.store.Save(existing); err != nil {
		http.Error(w, "save failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": id})
}

// ── Delete ────────────────────────────────────────────────────────────────────

func (d *Draw) handleDelete(w http.ResponseWriter, r *http.Request, id string) {
	if err := d.store.Delete(id); err != nil && !errors.Is(err, store.ErrNotFound) {
		http.Error(w, "delete failed", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, d.basePath+"/", http.StatusSeeOther)
}

// ── Editor ────────────────────────────────────────────────────────────────────

func (d *Draw) handleEditor(w http.ResponseWriter, r *http.Request, id string) {
	_, err := d.store.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	serveCanvas(w, r, id, d.basePath, "edit")
}

// ── Viewer ────────────────────────────────────────────────────────────────────

func (d *Draw) handleViewer(w http.ResponseWriter, r *http.Request, id string) {
	_, err := d.store.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	serveCanvas(w, r, id, d.basePath, "view")
}

// ── API List ──────────────────────────────────────────────────────────────────

func (d *Draw) handleAPIList(w http.ResponseWriter, r *http.Request) {
	drawings, err := d.store.List()
	if err != nil {
		http.Error(w, "failed to list drawings", http.StatusInternalServerError)
		return
	}
	type item struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		UpdatedAt string `json:"updated_at"`
	}
	items := make([]item, len(drawings))
	for i, d := range drawings {
		items[i] = item{
			ID:        d.ID,
			Title:     d.Title,
			UpdatedAt: d.UpdatedAt.Format(time.RFC3339),
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"drawings": items})
}

// ── API Rename ────────────────────────────────────────────────────────────────

func (d *Draw) handleAPIRename(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	drawing, err := d.store.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	drawing.Title = req.Title
	drawing.UpdatedAt = time.Now()
	if err := d.store.Save(drawing); err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// ── API Delete (JSON) ─────────────────────────────────────────────────────────

func (d *Draw) handleAPIDelete(w http.ResponseWriter, r *http.Request, id string) {
	if err := d.store.Delete(id); err != nil && !errors.Is(err, store.ErrNotFound) {
		http.Error(w, "delete failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// ── Upload ────────────────────────────────────────────────────────────────────

var allowedImageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true,
	".gif": true, ".webp": true, ".svg": true,
}

func (d *Draw) handleUpload(w http.ResponseWriter, r *http.Request) {
	const maxUpload = 10 << 20 // 10 MB
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)

	if err := r.ParseMultipartForm(maxUpload); err != nil {
		http.Error(w, "file too large (max 10 MB)", http.StatusRequestEntityTooLarge)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedImageExts[ext] {
		http.Error(w, fmt.Sprintf("unsupported file type: %s", ext), http.StatusBadRequest)
		return
	}

	name := newID() + ext
	dst, err := os.Create(filepath.Join(d.uploadDir, name))
	if err != nil {
		http.Error(w, "failed to save file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		http.Error(w, "failed to write file", http.StatusInternalServerError)
		return
	}

	base := strings.TrimRight(d.basePath, "/")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"url": base + "/uploads/" + name,
	})
}
