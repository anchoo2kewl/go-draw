package draw

// Server-side SVG export for drawings. Mirrors the shape rendering that
// canvas.js produces for its "Export SVG" button, but runs in Go so external
// consumers (e.g. syndicated blog renderers) can fetch a static image of a
// drawing without spinning up a headless browser.
//
// Endpoint:
//
//	GET /draw/{id}/export.svg[?bg=transparent|light|dark]
//
// The default background is transparent so embedders can drop the SVG onto
// pages with any theme.

import (
	"encoding/json"
	"fmt"
	"html"
	"math"
	"net/http"
	"strings"

	"github.com/anchoo2kewl/go-draw/store"
)

type svgElement struct {
	ID          string      `json:"id"`
	Type        string      `json:"type"`
	X           float64     `json:"x"`
	Y           float64     `json:"y"`
	X2          float64     `json:"x2,omitempty"`
	Y2          float64     `json:"y2,omitempty"`
	W           float64     `json:"w,omitempty"`
	H           float64     `json:"h,omitempty"`
	StrokeColor string      `json:"strokeColor,omitempty"`
	FillColor   string      `json:"fillColor,omitempty"`
	StrokeWidth float64     `json:"strokeWidth,omitempty"`
	StrokeStyle string      `json:"strokeStyle,omitempty"`
	Roundness   string      `json:"roundness,omitempty"`
	Opacity     *float64    `json:"opacity,omitempty"`
	Angle       float64     `json:"angle,omitempty"`
	Text        string      `json:"text,omitempty"`
	FontSize    float64     `json:"fontSize,omitempty"`
	FontFamily  string      `json:"fontFamily,omitempty"`
	TextAlign   string      `json:"textAlign,omitempty"`
	Src         string      `json:"src,omitempty"`
	Pts         []svgPoint  `json:"pts,omitempty"`
	Cp          *svgPoint   `json:"cp,omitempty"`
	GroupID     string      `json:"groupId,omitempty"`
	_extra      interface{} // unused — keeps json.Unmarshal happy with unknown fields
}

type svgPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type svgScene struct {
	Elements []svgElement `json:"elements"`
}

// handleExportSVG serves GET /draw/{id}/export.svg. Background defaults to
// transparent; pass ?bg=light or ?bg=dark for an opaque backdrop.
func (d *Draw) handleExportSVG(w http.ResponseWriter, r *http.Request, id string) {
	drawing, err := d.store.Get(id)
	if err == store.ErrNotFound {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	var scene svgScene
	if len(drawing.Scene) > 0 {
		if err := json.Unmarshal(drawing.Scene, &scene); err != nil {
			http.Error(w, "invalid scene data", http.StatusInternalServerError)
			return
		}
	}

	bg := r.URL.Query().Get("bg")
	svg := renderSceneSVG(scene, bg)

	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	// ETag = drawing UpdatedAt so consumers can conditional-GET if they cache.
	w.Header().Set("ETag", fmt.Sprintf(`"draw-%s-%d"`, id, drawing.UpdatedAt.Unix()))
	w.Write([]byte(svg))
}

// renderSceneSVG produces a self-contained SVG string for the given scene.
// `bgMode` is "transparent" (default), "light", or "dark".
func renderSceneSVG(scene svgScene, bgMode string) string {
	const pad = 20.0
	if len(scene.Elements) == 0 {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" viewBox="0 0 100 40"><text x="50" y="25" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#9ca3af">empty drawing</text></svg>`
	}

	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, e := range scene.Elements {
		bx, by, bw, bh := elementBBox(e)
		if bx < minX {
			minX = bx
		}
		if by < minY {
			minY = by
		}
		if bx+bw > maxX {
			maxX = bx + bw
		}
		if by+bh > maxY {
			maxY = by + bh
		}
	}
	w := (maxX - minX) + pad*2
	h := (maxY - minY) + pad*2
	ox := -minX + pad
	oy := -minY + pad

	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">`,
		f(w), f(h), f(w), f(h))
	b.WriteByte('\n')
	switch strings.ToLower(bgMode) {
	case "light":
		fmt.Fprintf(&b, `<rect width="%s" height="%s" fill="#ffffff"/>`, f(w), f(h))
		b.WriteByte('\n')
	case "dark":
		fmt.Fprintf(&b, `<rect width="%s" height="%s" fill="#1a1a2e"/>`, f(w), f(h))
		b.WriteByte('\n')
	}
	fmt.Fprintf(&b, `<g transform="translate(%s,%s)">`, f(ox), f(oy))
	b.WriteByte('\n')

	for _, el := range scene.Elements {
		writeElementSVG(&b, el)
	}

	b.WriteString("</g>\n</svg>\n")
	return b.String()
}

func elementBBox(el svgElement) (x, y, w, h float64) {
	switch el.Type {
	case "rect", "diamond", "ellipse", "text", "image":
		return minf(el.X, el.X+el.W), minf(el.Y, el.Y+el.H), math.Abs(el.W), math.Abs(el.H)
	case "line", "arrow":
		if len(el.Pts) > 0 {
			xs := []float64{}
			ys := []float64{}
			for _, p := range el.Pts {
				xs = append(xs, p.X)
				ys = append(ys, p.Y)
			}
			if el.Cp != nil {
				xs = append(xs, el.Cp.X)
				ys = append(ys, el.Cp.Y)
			}
			mx, my := xs[0], ys[0]
			mxx, mxy := xs[0], ys[0]
			for i := range xs {
				if xs[i] < mx {
					mx = xs[i]
				}
				if xs[i] > mxx {
					mxx = xs[i]
				}
				if ys[i] < my {
					my = ys[i]
				}
				if ys[i] > mxy {
					mxy = ys[i]
				}
			}
			return mx, my, mxx - mx, mxy - my
		}
		mx := minf(el.X, el.X2)
		my := minf(el.Y, el.Y2)
		w := math.Abs(el.X2 - el.X)
		h := math.Abs(el.Y2 - el.Y)
		if el.Cp != nil {
			if el.Cp.X < mx {
				w += mx - el.Cp.X
				mx = el.Cp.X
			}
			if el.Cp.X > mx+w {
				w = el.Cp.X - mx
			}
			if el.Cp.Y < my {
				h += my - el.Cp.Y
				my = el.Cp.Y
			}
			if el.Cp.Y > my+h {
				h = el.Cp.Y - my
			}
		}
		return mx, my, w, h
	case "pencil":
		if len(el.Pts) == 0 {
			return 0, 0, 0, 0
		}
		mx, my := el.Pts[0].X, el.Pts[0].Y
		mxx, mxy := mx, my
		for _, p := range el.Pts {
			if p.X < mx {
				mx = p.X
			}
			if p.X > mxx {
				mxx = p.X
			}
			if p.Y < my {
				my = p.Y
			}
			if p.Y > mxy {
				mxy = p.Y
			}
		}
		return mx, my, mxx - mx, mxy - my
	}
	return 0, 0, 0, 0
}

func writeElementSVG(b *strings.Builder, el svgElement) {
	stroke := def(el.StrokeColor, "#1e1e2e")
	fill := def(el.FillColor, "transparent")
	sw := el.StrokeWidth
	if sw == 0 {
		sw = 2
	}
	op := 1.0
	if el.Opacity != nil {
		op = *el.Opacity / 100
	}
	dash := ""
	switch el.StrokeStyle {
	case "dashed":
		dash = fmt.Sprintf(` stroke-dasharray="%s,%s"`, f(sw*4), f(sw*3))
	case "dotted":
		dash = fmt.Sprintf(` stroke-dasharray="%s,%s"`, f(sw*0.5), f(sw*2.5))
	}
	rot := ""
	if el.Angle != 0 {
		bx, by, bw, bh := elementBBox(el)
		cx := bx + bw/2
		cy := by + bh/2
		rot = fmt.Sprintf(` transform="rotate(%s,%s,%s)"`, f(el.Angle*180/math.Pi), f(cx), f(cy))
	}
	ff := fontCSS(el.FontFamily)
	fs := el.FontSize
	if fs == 0 {
		fs = 16
	}

	switch el.Type {
	case "rect":
		r := 0.0
		if el.Roundness == "round" {
			r = math.Min(math.Abs(el.W), math.Abs(el.H)) * 0.15
		}
		fmt.Fprintf(b, `  <rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
			f(el.X), f(el.Y), f(el.W), f(el.H), f(r),
			escAttr(fill), escAttr(stroke), f(sw), f(op), dash, rot)
		b.WriteByte('\n')
		if el.Text != "" {
			bx, by, bw, bh := elementBBox(el)
			fmt.Fprintf(b, `  <text x="%s" y="%s" text-anchor="middle" dominant-baseline="central" font-size="%s" font-family="%s" fill="%s" opacity="%s"%s>%s</text>`,
				f(bx+bw/2), f(by+bh/2), f(fs), ff, escAttr(stroke), f(op), rot, escText(el.Text))
			b.WriteByte('\n')
		}
	case "diamond":
		dcx := el.X + el.W/2
		dcy := el.Y + el.H/2
		fmt.Fprintf(b, `  <polygon points="%s,%s %s,%s %s,%s %s,%s" fill="%s" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
			f(dcx), f(el.Y), f(el.X+el.W), f(dcy), f(dcx), f(el.Y+el.H), f(el.X), f(dcy),
			escAttr(fill), escAttr(stroke), f(sw), f(op), dash, rot)
		b.WriteByte('\n')
		if el.Text != "" {
			fmt.Fprintf(b, `  <text x="%s" y="%s" text-anchor="middle" dominant-baseline="central" font-size="%s" font-family="%s" fill="%s" opacity="%s"%s>%s</text>`,
				f(dcx), f(dcy), f(fs), ff, escAttr(stroke), f(op), rot, escText(el.Text))
			b.WriteByte('\n')
		}
	case "ellipse":
		cx := el.X + el.W/2
		cy := el.Y + el.H/2
		rx := math.Abs(el.W / 2)
		ry := math.Abs(el.H / 2)
		fmt.Fprintf(b, `  <ellipse cx="%s" cy="%s" rx="%s" ry="%s" fill="%s" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
			f(cx), f(cy), f(rx), f(ry), escAttr(fill), escAttr(stroke), f(sw), f(op), dash, rot)
		b.WriteByte('\n')
		if el.Text != "" {
			fmt.Fprintf(b, `  <text x="%s" y="%s" text-anchor="middle" dominant-baseline="central" font-size="%s" font-family="%s" fill="%s" opacity="%s"%s>%s</text>`,
				f(cx), f(cy), f(fs), ff, escAttr(stroke), f(op), rot, escText(el.Text))
			b.WriteByte('\n')
		}
	case "line":
		if len(el.Pts) > 1 {
			pts := pointString(el.Pts)
			fmt.Fprintf(b, `  <polyline points="%s" fill="none" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
				pts, escAttr(stroke), f(sw), f(op), dash, rot)
			b.WriteByte('\n')
		} else if el.Cp != nil {
			fmt.Fprintf(b, `  <path d="M%s,%s Q%s,%s %s,%s" fill="none" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
				f(el.X), f(el.Y), f(el.Cp.X), f(el.Cp.Y), f(el.X2), f(el.Y2),
				escAttr(stroke), f(sw), f(op), dash, rot)
			b.WriteByte('\n')
		} else {
			fmt.Fprintf(b, `  <line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
				f(el.X), f(el.Y), f(el.X2), f(el.Y2), escAttr(stroke), f(sw), f(op), dash, rot)
			b.WriteByte('\n')
		}
	case "arrow":
		var endX, endY, prevX, prevY float64
		if len(el.Pts) > 1 {
			fmt.Fprintf(b, `  <polyline points="%s" fill="none" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
				pointString(el.Pts), escAttr(stroke), f(sw), f(op), dash, rot)
			b.WriteByte('\n')
			endX = el.Pts[len(el.Pts)-1].X
			endY = el.Pts[len(el.Pts)-1].Y
			prevX = el.Pts[len(el.Pts)-2].X
			prevY = el.Pts[len(el.Pts)-2].Y
		} else if el.Cp != nil {
			fmt.Fprintf(b, `  <path d="M%s,%s Q%s,%s %s,%s" fill="none" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
				f(el.X), f(el.Y), f(el.Cp.X), f(el.Cp.Y), f(el.X2), f(el.Y2),
				escAttr(stroke), f(sw), f(op), dash, rot)
			b.WriteByte('\n')
			endX = el.X2
			endY = el.Y2
			prevX = el.Cp.X
			prevY = el.Cp.Y
		} else {
			fmt.Fprintf(b, `  <line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%s" opacity="%s"%s%s/>`,
				f(el.X), f(el.Y), f(el.X2), f(el.Y2), escAttr(stroke), f(sw), f(op), dash, rot)
			b.WriteByte('\n')
			endX = el.X2
			endY = el.Y2
			prevX = el.X
			prevY = el.Y
		}
		dx := endX - prevX
		dy := endY - prevY
		length := math.Hypot(dx, dy)
		if length < 0.001 {
			return
		}
		ux := dx / length
		uy := dy / length
		headLen := math.Min(12, length*0.3)
		ax1 := endX - headLen*ux + headLen*0.4*uy
		ay1 := endY - headLen*uy - headLen*0.4*ux
		ax2 := endX - headLen*ux - headLen*0.4*uy
		ay2 := endY - headLen*uy + headLen*0.4*ux
		fmt.Fprintf(b, `  <polygon points="%s,%s %s,%s %s,%s" fill="%s" opacity="%s"%s/>`,
			f(endX), f(endY), f(ax1), f(ay1), f(ax2), f(ay2), escAttr(stroke), f(op), rot)
		b.WriteByte('\n')
	case "pencil":
		if len(el.Pts) > 1 {
			var pb strings.Builder
			fmt.Fprintf(&pb, "M%s,%s", f(el.Pts[0].X), f(el.Pts[0].Y))
			for i := 1; i < len(el.Pts); i++ {
				fmt.Fprintf(&pb, " L%s,%s", f(el.Pts[i].X), f(el.Pts[i].Y))
			}
			fmt.Fprintf(b, `  <path d="%s" fill="none" stroke="%s" stroke-width="%s" opacity="%s" stroke-linecap="round" stroke-linejoin="round"%s%s/>`,
				pb.String(), escAttr(stroke), f(sw), f(op), dash, rot)
			b.WriteByte('\n')
		}
	case "text":
		lines := strings.Split(el.Text, "\n")
		lh := fs * 1.3
		for i, line := range lines {
			fmt.Fprintf(b, `  <text x="%s" y="%s" font-size="%s" fill="%s" opacity="%s" font-family="%s"%s>%s</text>`,
				f(el.X), f(el.Y+(float64(i)+0.8)*lh), f(fs), escAttr(stroke), f(op), ff, rot, escText(line))
			b.WriteByte('\n')
		}
	case "image":
		if el.Src != "" {
			fmt.Fprintf(b, `  <image href="%s" x="%s" y="%s" width="%s" height="%s" opacity="%s"%s/>`,
				escAttr(el.Src), f(el.X), f(el.Y), f(el.W), f(el.H), f(op), rot)
			b.WriteByte('\n')
		}
	}
}

// fontCSS returns a font-family stack using single quotes so it can be
// dropped straight into an SVG attribute without escaping.
func fontCSS(ff string) string {
	switch ff {
	case "hand":
		return `'Virgil', 'Segoe Print', 'Comic Sans MS', cursive`
	case "serif":
		return `'Georgia', 'Times New Roman', serif`
	case "mono":
		return `'SFMono-Regular', 'Consolas', 'Liberation Mono', monospace`
	default:
		return `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
	}
}

func pointString(pts []svgPoint) string {
	parts := make([]string, len(pts))
	for i, p := range pts {
		parts[i] = f(p.X) + "," + f(p.Y)
	}
	return strings.Join(parts, " ")
}

func escText(s string) string {
	return html.EscapeString(s)
}

func escAttr(s string) string {
	return strings.ReplaceAll(html.EscapeString(s), "\"", "&quot;")
}

func def(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// f formats a float like JavaScript would: integer when whole, else up to
// four decimals with trailing zeros stripped. Keeps the SVG small.
func f(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	if v == math.Trunc(v) {
		return fmt.Sprintf("%d", int64(v))
	}
	s := fmt.Sprintf("%.4f", v)
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	return s
}
