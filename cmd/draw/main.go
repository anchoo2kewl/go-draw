// Standalone go-draw server for draw.biswas.me
//
//	go run ./cmd/draw
//	Visit: http://localhost:8090/draw/
package main

import (
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"

	godraw "github.com/anchoo2kewl/go-draw"
	"github.com/anchoo2kewl/go-draw/store"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "/data/drawings"
	}

	uploadDir := os.Getenv("UPLOAD_DIR")
	if uploadDir == "" {
		uploadDir = "/data/uploads"
	}

	fs, err := store.NewFileStore(dataDir)
	if err != nil {
		log.Fatalf("failed to init file store: %v", err)
	}

	d, err := godraw.New(
		godraw.WithStore(fs),
		godraw.WithBasePath("/draw"),
		godraw.WithUploadDir(uploadDir),
		godraw.WithCollabEnabled(true),
	)
	if err != nil {
		log.Fatalf("failed to create draw instance: %v", err)
	}

	// Mount the draw handler
	http.Handle("/draw/", d.Handler())

	// WebSocket collaboration relay
	collab := NewCollabServer()
	http.Handle("/ws/", collab.Handler())

	// Health check
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})

	// Landing page
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		landingTmpl.Execute(w, nil)
	})

	log.Printf("go-draw listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

var landingTmpl = template.Must(template.New("landing").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>draw.biswas.me - Free Collaborative Drawing</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8f8f8;color:#1e1e2e;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem}
  .hero{max-width:600px}
  h1{font-size:2.5rem;font-weight:700;margin-bottom:.5rem;letter-spacing:-.02em}
  h1 span{color:#6366f1}
  .subtitle{color:#666;font-size:1.1rem;margin-bottom:2rem;line-height:1.6}
  .btn{display:inline-flex;align-items:center;gap:.5rem;padding:.75rem 1.5rem;border-radius:10px;font-size:1rem;text-decoration:none;font-weight:600;transition:transform .15s,box-shadow .15s}
  .btn-primary{background:#6366f1;color:#fff;box-shadow:0 4px 14px rgba(99,102,241,.35)}
  .btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.45)}
  .btn-secondary{background:#fff;color:#1e1e2e;border:1px solid #e0e0e0;margin-left:.75rem}
  .btn-secondary:hover{background:#f0f0f0}
  .features{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1.25rem;margin-top:3rem;max-width:600px;text-align:left}
  .feature{background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:1rem 1.2rem}
  .feature h3{font-size:.9rem;margin-bottom:.3rem}
  .feature p{font-size:.8rem;color:#888;line-height:1.5}
  footer{margin-top:3rem;color:#aaa;font-size:.8rem}
  footer a{color:#6366f1;text-decoration:none}
</style>
</head>
<body>
<div class="hero">
  <h1>draw<span>.biswas.me</span></h1>
  <p class="subtitle">
    Free, open-source collaborative drawing tool.<br>
    Create diagrams, sketches, and wireframes with end-to-end encryption.
  </p>
  <div>
    <a href="/draw/new" class="btn btn-primary">+ New Drawing</a>
    <a href="/draw/" class="btn btn-secondary">Browse Drawings</a>
  </div>
  <div class="features">
    <div class="feature">
      <h3>Real-time Collaboration</h3>
      <p>Draw together with encrypted WebSocket sync. No sign-up needed.</p>
    </div>
    <div class="feature">
      <h3>Export Anywhere</h3>
      <p>Download as PNG or SVG. Copy/paste, multi-select, dark mode.</p>
    </div>
    <div class="feature">
      <h3>Privacy First</h3>
      <p>End-to-end encrypted. Server never sees your drawing content.</p>
    </div>
    <div class="feature">
      <h3>Open Source</h3>
      <p>Built with Go + vanilla JS. Zero dependencies. MIT licensed.</p>
    </div>
  </div>
</div>
<footer>
  Powered by <a href="https://github.com/anchoo2kewl/go-draw">go-draw</a>
</footer>
</body>
</html>`))
