# go-draw

Embeddable canvas drawing editor for Go web apps — Excalidraw-style tools, pure vanilla JS, zero frontend dependencies.

Designed to be embedded in [go-wiki](https://github.com/anchoo2kewl/go-wiki), [taskai](https://github.com/anchoo2kewl/taskai), blogs, and any Go web application. Authors draw on an edit page, readers get a pan/zoom-only viewport. Embeds are resizable and support fullscreen.

## Features

- **Tools** — Select, Rectangle, Ellipse, Line, Arrow, Pencil, Text
- **Editor** — Full toolbar, color picker, stroke width, font size, undo/redo (Ctrl+Z/Y), keyboard shortcuts, auto-save after 2s idle
- **Viewer** — Read-only canvas: pan (drag / touch), zoom (scroll / pinch), no edit UI
- **Fullscreen** — Toggle via button or F11, works in both editor and viewer modes
- **Resizable embed** — Drag edges/corner to resize the embedded viewport in any host page
- **New canvas API** — Create drawings programmatically via JSON endpoint or JS widget
- **Dot-grid background** — scales with zoom
- **Storage interface** — swap in any backend; default is atomic JSON files on disk
- **Embedded assets** — CSS, JS, templates via Go's `embed.FS` — no npm, no build step
- **Zero external Go dependencies** — stdlib only

## Install

```sh
go get github.com/anchoo2kewl/go-draw
```

## Quick start

```go
package main

import (
    "log"
    "net/http"

    godraw "github.com/anchoo2kewl/go-draw"
)

func main() {
    d, err := godraw.New(
        godraw.WithBasePath("/draw"),     // default
    )
    if err != nil {
        log.Fatal(err)
    }

    http.Handle("/draw/", d.Handler())   // trailing slash required
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

Visit `http://localhost:8080/draw/` to create a drawing, share its ID.

## Embedding

### Simple iframe (go-wiki, blog)

```go
// Read-only viewer
snippet := draw.ViewerSnippet("my-drawing-id", "100%", "520px")

// Full editor
snippet := draw.EditorSnippet("my-drawing-id", "100%", "600px")

// Pass template.HTML(snippet) to your template.
```

### Resizable embed widget (recommended)

The embed widget wraps the iframe in a container with drag-to-resize handles on all edges.

```go
// In your Go handler:
snippet := draw.EmbedSnippet("my-drawing-id", "100%", "520px", "view") // or "edit"
// Returns HTML with the iframe + embed.js script
```

Or use the widget directly in HTML:

```html
<div class="godraw-embed"
     data-src="/draw/my-drawing-id"
     data-width="100%"
     data-height="520px">
</div>
<script src="/draw/static/embed.js"></script>
```

The embed container can be resized by:
- Dragging the bottom-right corner handle (resize both dimensions)
- Dragging the right edge (resize width)
- Dragging the bottom edge (resize height)

### JavaScript API (taskai, SPAs)

Include `embed.js` and use the `GoDraw` global:

```html
<script src="/draw/static/embed.js"></script>
<script>
  // Embed into a container element
  const el = document.getElementById("my-drawing-container");
  GoDraw.embed(el, {
    src: "/draw/my-drawing-id/edit",
    width: "100%",
    height: "600px",
    basePath: "/draw"
  });

  // Create a new canvas programmatically
  const data = await GoDraw.newCanvas({ basePath: "/draw" });
  // data = { id: "abc123", edit_url: "/draw/abc123/edit", view_url: "/draw/abc123" }
</script>
```

### Events

The embed widget fires custom events on the container element:

```javascript
container.addEventListener("godraw:ready", e => {
  console.log("Canvas ready:", e.detail.id, e.detail.mode);
});

container.addEventListener("godraw:new-canvas", e => {
  console.log("New canvas created:", e.detail.id);
});

container.addEventListener("godraw:fullscreen", e => {
  console.log("Fullscreen:", e.detail.active);
});
```

## Fullscreen

Fullscreen is available in both editor and viewer modes:
- Click the fullscreen button (bottom-right corner)
- Press F11
- Works inside iframes (requires `allowfullscreen` attribute, added automatically by all snippet methods)

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/draw/` | List all drawings |
| `GET` | `/draw/new` | Create drawing, redirect to edit |
| `GET` | `/draw/{id}` | Read-only viewer |
| `GET` | `/draw/{id}/edit` | Full editor |
| `GET` | `/draw/{id}/data` | Raw scene JSON |
| `POST` | `/draw/{id}/save` | Persist scene JSON |
| `POST` | `/draw/{id}/delete` | Delete drawing |
| `POST` | `/draw/api/new` | Create drawing (with optional title & scene), return JSON |
| `GET` | `/draw/api/list` | List all drawings as JSON |
| `POST` | `/draw/api/{id}/rename` | Rename a drawing |
| `POST` | `/draw/api/{id}/delete` | Delete a drawing (JSON response) |

### API: Create new drawing

Create an empty drawing:

```
POST /draw/api/new
→ { "id": "abc123xyz", "edit_url": "/draw/abc123xyz/edit", "view_url": "/draw/abc123xyz" }
```

Create a drawing with title and pre-built scene:

```
POST /draw/api/new
Content-Type: application/json

{
  "title": "Architecture Diagram",
  "scene": {
    "version": 1,
    "elements": [
      {
        "id": "r1", "type": "rect",
        "x": 100, "y": 50, "w": 200, "h": 80,
        "strokeColor": "#1e1e2e", "fillColor": "#dbeafe",
        "opacity": 100, "strokeWidth": 2,
        "text": "My Service", "fontSize": 14
      }
    ]
  }
}
→ { "id": "abc123xyz", "edit_url": "/draw/abc123xyz/edit", "view_url": "/draw/abc123xyz" }
```

### API: Save / update a drawing

```
POST /draw/{id}/save
Content-Type: application/json

{ "title": "New Title", "scene": { "version": 1, "elements": [...] } }
→ { "ok": true, "id": "abc123xyz" }
```

### API: Get drawing data

```
GET /draw/{id}/data
→ { "id": "abc123xyz", "title": "My Drawing", "scene": { "version": 1, "elements": [...] } }
```

### API: Rename a drawing

```
POST /draw/api/{id}/rename
Content-Type: application/json

{ "title": "New Name" }
→ { "ok": true }
```

## Options

```go
godraw.New(
    godraw.WithBasePath("/draw"),           // URL prefix (default: "/draw")
    godraw.WithStore(myStore),              // custom storage backend
    godraw.WithMaxSceneBytes(4 << 20),      // max save payload (default: 2 MB)
)
```

## Custom storage backend

Implement `store.Store`:

```go
type Store interface {
    Get(id string) (*Drawing, error)
    Save(d *Drawing) error
    List() ([]*Drawing, error)
    Delete(id string) error
}
```

Then pass it via `godraw.WithStore(myStore)`.

## Keyboard shortcuts (editor)

| Key | Action |
|-----|--------|
| `V` | Select tool |
| `R` | Rectangle |
| `E` | Ellipse |
| `L` | Line |
| `A` | Arrow |
| `P` | Pencil |
| `T` | Text |
| `Del` / `Backspace` | Delete selected |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+S` | Save |
| `Esc` | Deselect / cancel text |
| `Space + drag` | Pan (in any tool) |
| `F11` | Toggle fullscreen |
| Scroll | Zoom |

## Scene format

Drawings are stored as JSON. The `scene` field is opaque to the Go layer — it is produced and consumed by the frontend (`canvas.js`). When creating drawings programmatically via the API, you must follow this format exactly.

### Structure

```json
{
  "version": 1,
  "elements": [ ... ]
}
```

### Common element properties

Every element has these fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (any string, must be unique within the scene) |
| `type` | string | Element type: `rect`, `ellipse`, `line`, `arrow`, `pencil`, `text`, `image` |
| `strokeColor` | string | Stroke/border color as hex (e.g. `"#1e1e2e"`) |
| `fillColor` | string | Fill color as hex, or `""` / `"transparent"` for none |
| `opacity` | number | **0–100** (not 0–1). `100` = fully opaque, `50` = half transparent |
| `strokeWidth` | number | Stroke width in pixels (1–4) |
| `strokeStyle` | string | `"solid"` (default), `"dashed"`, or `"dotted"` |
| `roughness` | number | `0` = clean, `1`+ = hand-drawn style |
| `roundness` | string | `"sharp"` (default) or `"round"` (rounded corners for rects) |
| `angle` | number | Rotation in radians (0 = no rotation) |

### Element types

**Rectangle** (`rect`) and **Ellipse** (`ellipse`):

```json
{ "id": "r1", "type": "rect", "x": 100, "y": 50, "w": 200, "h": 80, ... }
```

- `x`, `y` — top-left corner position
- `w`, `h` — width and height
- `text` (optional) — centered label inside the shape
- `fontSize` (optional) — label font size in pixels (default: 16)

**Arrow** (`arrow`) and **Line** (`line`):

```json
{ "id": "a1", "type": "arrow", "x": 100, "y": 50, "x2": 100, "y2": 150, ... }
```

- `x`, `y` — start point
- `x2`, `y2` — end point
- Do **not** use `w`, `h` for arrows/lines — they use endpoint coordinates

**Text** (`text`):

```json
{ "id": "t1", "type": "text", "x": 100, "y": 50, "w": 200, "h": 20, "text": "Hello", "fontSize": 16, ... }
```

- `x`, `y` — top-left position
- `w`, `h` — bounding box (used for selection/hit testing)
- `text` — the text content
- `fontSize` — font size in pixels

**Pencil** (`pencil`):

```json
{ "id": "p1", "type": "pencil", "pts": [{"x": 10, "y": 20}, {"x": 15, "y": 25}, ...], ... }
```

- `pts` — array of `{x, y}` points

**Image** (`image`):

```json
{ "id": "i1", "type": "image", "x": 100, "y": 50, "w": 300, "h": 200, "src": "/draw/uploads/abc.png", ... }
```

- `x`, `y` — top-left position
- `w`, `h` — display dimensions
- `src` — image URL

### Full example

```json
{
  "version": 1,
  "elements": [
    {
      "id": "box1", "type": "rect",
      "x": 100, "y": 50, "w": 200, "h": 80,
      "strokeColor": "#2563eb", "fillColor": "#dbeafe",
      "opacity": 100, "strokeWidth": 2, "angle": 0,
      "text": "Service A", "fontSize": 14
    },
    {
      "id": "arr1", "type": "arrow",
      "x": 200, "y": 130, "x2": 200, "y2": 200,
      "strokeColor": "#2563eb", "fillColor": "",
      "opacity": 100, "strokeWidth": 2, "angle": 0
    },
    {
      "id": "box2", "type": "rect",
      "x": 100, "y": 200, "w": 200, "h": 80,
      "strokeColor": "#059669", "fillColor": "#ecfdf5",
      "opacity": 100, "strokeWidth": 2, "angle": 0,
      "text": "Service B", "fontSize": 14
    },
    {
      "id": "label1", "type": "text",
      "x": 320, "y": 80, "w": 100, "h": 18,
      "strokeColor": "#6b7280", "fillColor": "",
      "opacity": 70, "strokeWidth": 1, "angle": 0,
      "text": "Annotation", "fontSize": 12
    }
  ]
}
```

## Package layout

```
go-draw/
├── draw.go          Top-level Draw struct, New(), ViewerSnippet(), EmbedSnippet()
├── options.go       Functional options
├── handler.go       HTTP routes and handlers (including API endpoints)
├── embed.go         //go:embed + canvas template
├── store/
│   └── store.go     Store interface + FileStore implementation
├── static/
│   ├── canvas.js    Canvas engine (editor + viewer + fullscreen)
│   └── embed.js     Host-page embed widget (resize + events + JS API)
└── _examples/
    └── standalone/
        └── main.go  Runnable demo server
```

## License

MIT
