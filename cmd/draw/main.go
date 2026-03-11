// Standalone go-draw server for draw.biswas.me
//
//	go run ./cmd/draw
//	Visit: http://localhost:8090/
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

	// Favicon at root — serve the embedded SVG directly
	faviconData := godraw.FaviconSVG()
	http.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(faviconData)
	})

	// Root serves the canvas directly with localStorage persistence
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		canvasTmpl.Execute(w, nil)
	})

	log.Printf("go-draw listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

var canvasTmpl = template.Must(template.New("canvas-local").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>draw.biswas.me</title>
<link rel="icon" type="image/svg+xml" href="/draw/static/favicon.svg">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:#f4f4f5}
#app{display:flex;flex-direction:column;width:100%;height:100%}
</style>
</head>
<body>
<div id="app"></div>
<script data-cfasync="false">
  window.GODRAW_CONFIG = {
    mode:     "edit",
    id:       "local",
    basePath: "/draw",
    storage:  "local"
  };
</script>
<script data-cfasync="false" src="/draw/static/canvas.js"></script>
</body>
</html>`))
