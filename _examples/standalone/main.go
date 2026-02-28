// Example: standalone server demonstrating go-draw integration.
//
//	cd _examples/standalone && go run main.go
//	Visit: http://localhost:8080/draw/
package main

import (
	"html/template"
	"log"
	"net/http"

	godraw "github.com/anchoo2kewl/go-draw"
	"github.com/anchoo2kewl/go-draw/store"
)

func main() {
	// ── Option A: default file store under ./draw-data ──────────────────────
	d, err := godraw.New(
		godraw.WithBasePath("/draw"),
	)

	// ── Option B: custom store directory ───────────────────────────────────
	// fs, _ := store.NewFileStore("/var/data/my-drawings")
	// d, err := godraw.New(
	//     godraw.WithStore(fs),
	//     godraw.WithBasePath("/draw"),
	// )

	_ = store.ErrNotFound // import used above in option B comment

	if err != nil {
		log.Fatal(err)
	}

	// Mount the draw handler under /draw/
	http.Handle("/draw/", d.Handler())

	// Demo page showing all embedding methods
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		drawingID := r.URL.Query().Get("id")

		iframeSnippet := ""
		embedSnippet := ""
		if drawingID != "" {
			iframeSnippet = d.ViewerSnippet(drawingID, "100%", "500px")
			embedSnippet = d.EmbedSnippet(drawingID, "100%", "520px", "view")
		}

		indexTmpl.Execute(w, map[string]any{
			"IframeSnippet": template.HTML(iframeSnippet),
			"EmbedSnippet":  template.HTML(embedSnippet),
			"DrawingID":     drawingID,
			"BasePath":      "/draw",
		})
	})

	log.Println("Listening on :8080  ->  http://localhost:8080/draw/")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

var indexTmpl = template.Must(template.New("index").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>go-draw demo</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #1e1e2e; }
    h1 { margin-bottom: .5rem; }
    h2 { margin-top: 2rem; font-size: 1.2rem; }
    .tip { color: #888; font-size: .875rem; margin-bottom: 1.5rem; }
    .section { margin-bottom: 2rem; padding: 1.5rem; background: #fafafa; border: 1px solid #e0e0e0; border-radius: 10px; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: .85rem; }
    .btn { display: inline-block; padding: .5rem 1rem; background: #1e1e2e; color: #fff; border: none; border-radius: 8px; cursor: pointer; text-decoration: none; font-size: .875rem; }
    .btn:hover { background: #333; }
  </style>
</head>
<body>
  <h1>go-draw demo</h1>
  <p class="tip">
    Visit <a href="/draw/">/draw/</a> to manage drawings, then embed using <code>/?id=your-drawing-id</code>
  </p>

  {{if .DrawingID}}
    <h2>1. Simple iframe embed</h2>
    <div class="section">
      {{.IframeSnippet}}
    </div>

    <h2>2. Resizable embed widget (drag edges to resize)</h2>
    <div class="section">
      {{.EmbedSnippet}}
    </div>
  {{else}}
    <div class="section">
      <p>No drawing ID provided. <a href="/draw/" class="btn">Create a drawing</a> then embed it here.</p>
      <p style="margin-top:1rem;">Or create one programmatically:</p>
      <button class="btn" onclick="createNew()">+ New Canvas (via API)</button>
      <p id="new-result" style="margin-top:.5rem;font-size:.85rem;color:#888;"></p>
    </div>
  {{end}}

  <script src="{{.BasePath}}/static/embed.js"></script>
  <script>
    async function createNew() {
      try {
        const data = await GoDraw.newCanvas({ basePath: "{{.BasePath}}" });
        document.getElementById("new-result").innerHTML =
          'Created: <a href="/?id=' + data.id + '">embed ' + data.id + '</a> | ' +
          '<a href="' + data.edit_url + '">edit</a> | ' +
          '<a href="' + data.view_url + '">view</a>';
      } catch (err) {
        document.getElementById("new-result").textContent = "Error: " + err.message;
      }
    }
  </script>
</body>
</html>`))
