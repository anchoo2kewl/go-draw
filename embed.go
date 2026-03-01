package draw

import (
	"embed"
	"html/template"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

//go:embed static
var staticFS embed.FS

// canvasTmpl inlines the drawing page. It loads canvas.js from the static
// directory and passes the mode ("edit" | "view") and drawing id to JS.
var canvasTmpl = template.Must(template.New("canvas").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{if eq .Mode "edit"}}Edit Drawing{{else}}View Drawing{{end}}</title>
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
    mode:     {{.Mode | js}},
    id:       {{.ID | js}},
    basePath: {{.BasePath | js}}
  };
</script>
<script data-cfasync="false" src="{{.BasePath}}/static/canvas.js"></script>
</body>
</html>`))

func serveCanvas(w http.ResponseWriter, r *http.Request, id, basePath, mode string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	canvasTmpl.Execute(w, map[string]string{
		"Mode":     mode,
		"ID":       id,
		"BasePath": basePath,
	})
}

// newID generates a short URL-safe random slug for a new drawing.
func newID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	var sb strings.Builder
	sb.Grow(10)
	for i := 0; i < 10; i++ {
		sb.WriteByte(chars[rng.Intn(len(chars))])
	}
	return sb.String()
}
