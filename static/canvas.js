/*!
 * go-draw canvas.js
 * Pure vanilla JS canvas drawing engine.
 * Supports: select, rectangle, ellipse, line, arrow, pencil, text
 * Edit mode: full toolbar + sidebar property panel + save
 * View mode: pan + zoom only, no editing
 * Fullscreen: toggle via button or F11, works in both modes
 */
(function () {
  "use strict";

  const CFG = window.GODRAW_CONFIG || { mode: "view", id: "", basePath: "/draw" };
  const IS_EDIT = CFG.mode === "edit";
  const IS_EMBED = window !== window.top; // running inside an iframe

  // ── Data model ────────────────────────────────────────────────────────────
  let scene = { version: 1, elements: [] };
  let title = "Untitled";

  // ── Viewport state ────────────────────────────────────────────────────────
  let vp = { x: 0, y: 0, scale: 1 };

  // ── Tool state ────────────────────────────────────────────────────────────
  let activeTool = "select";
  let strokeColor = "#1e1e2e";
  let fillColor = "transparent";
  let strokeWidth = 2;
  let fontSize = 16;
  let fontFamily = "hand";       // "hand" | "sans-serif" | "mono" | "serif"
  let textAlign = "center";     // "left" | "center" | "right"
  let strokeStyle = "solid";   // "solid" | "dashed" | "dotted"
  let roughness = 0;           // 0=architect, 1=artist, 2=cartoonist
  let roundness = "sharp";     // "sharp" | "round"
  let opacity = 100;           // 0-100

  // ── Interaction state ────────────────────────────────────────────────────
  let drawing = false;
  let currentEl = null;
  let startX = 0, startY = 0;
  let pencilPoints = [];
  let panning = false;
  let panStart = { x: 0, y: 0, vpx: 0, vpy: 0 };
  let selectedIds = new Set();
  let dragOffset = { x: 0, y: 0 };
  let isDragging = false;
  let isRotating = false;
  let rotateStartAngle = 0;
  let rotateOriginalAngle = 0;
  let textInput = null;

  // ── Clipboard (internal copy/paste) ──────────────────────────────────────
  let clipboardElements = [];

  // ── Marquee selection ──────────────────────────────────────────────────
  let marquee = null; // { x, y, w, h } in world coords while dragging

  // ── Font family map ─────────────────────────────────────────────────────
  const FONT_CSS = {
    "sans-serif": '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    "serif":      '"Georgia", "Times New Roman", serif',
    "mono":       '"SFMono-Regular", "Consolas", "Liberation Mono", monospace',
    "hand":       '"Segoe Print", "Comic Sans MS", cursive',
  };
  function fontCSS(ff) { return FONT_CSS[ff] || FONT_CSS["sans-serif"]; }

  // ── Dark mode ──────────────────────────────────────────────────────────
  let darkMode = localStorage.getItem("godraw-dark") === "true";

  // ── Eraser state ─────────────────────────────────────────────────────────
  let eraserActive = false;
  let erasedIds = new Set();
  let eraserCursorPos = null;
  const ERASER_RADIUS = 18;

  // ── Image cache ─────────────────────────────────────────────────────────
  const imageCache = new Map();
  function getImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const img = new Image();
    img.src = src;
    img.onload = () => render();
    imageCache.set(src, img);
    return img;
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  let undoStack = [];
  let redoStack = [];
  const UNDO_LIMIT = 60;

  let autoSaveTimer = null;
  let collabSyncTimer = null;
  function snapshot() {
    undoStack.push(JSON.stringify(scene.elements));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    // Auto-save after 2s of inactivity
    if (IS_EDIT) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(saveDrawing, 2000);
    }
    // Broadcast changes to collab peers (debounced)
    if (CFG.collabEnabled && window.GodrawCollab && window.GodrawCollab.isConnected()) {
      clearTimeout(collabSyncTimer);
      collabSyncTimer = setTimeout(() => {
        window.GodrawCollab.sendElementUpdate(scene.elements);
      }, 100);
    }
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(scene.elements));
    scene.elements = JSON.parse(undoStack.pop());
    selectedIds.clear();
    render();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(scene.elements));
    scene.elements = JSON.parse(redoStack.pop());
    selectedIds.clear();
    render();
  }

  // ── ID gen ────────────────────────────────────────────────────────────────
  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  // ── DOM setup ─────────────────────────────────────────────────────────────
  const app = document.getElementById("app");

  // Build toolbar HTML (only in edit mode)
  const TOOLS = [
    { id: "hand",      icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 1.75a.75.75 0 011.5 0V6h.25V2.25a.75.75 0 011.5 0V6h.25V3.25a.75.75 0 011.5 0V9.5l.6-.4a.75.75 0 01.9 1.2l-1.5 1.2c-.7.6-1.6 1-2.7 1h-1c-2.2 0-4-1.8-4-4V6.25a.75.75 0 011.5 0V6L6 2.75a.75.75 0 011.5 0V6z"/></svg>', title: "Hand (H)", num: "" },
    { id: "select",    icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 1L12 8l-4.5 1L5.5 14z"/></svg>', title: "Select (V / 1)", num: "1" },
    { id: "rect",      icon: "\u25AD", title: "Rectangle (R / 2)", num: "2" },
    { id: "ellipse",   icon: "\u25EF", title: "Ellipse (E / 3)", num: "3" },
    { id: "diamond",   icon: "\u25C7", title: "Diamond (D)", num: "" },
    { id: "line",      icon: "\u2571", title: "Line (L / 4)", num: "4" },
    { id: "arrow",     icon: "\u2192", title: "Arrow (A / 5)", num: "5" },
    { id: "pencil",    icon: "\u270F", title: "Pencil (P / 6)", num: "6" },
    { id: "text",      icon: "T", title: "Text (T / 7)", num: "7" },
    { id: "eraser",    icon: "\u232B", title: "Eraser (X / 8)", num: "8" },
    { id: "image",     icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3a1 1 0 011-1h12a1 1 0 011 1v10a1 1 0 01-1 1H2a1 1 0 01-1-1V3zm1 7.5V13h12v-1.5l-3-3-2 2-4-4-3 3zM11 6a1 1 0 100-2 1 1 0 000 2z"/></svg>', title: "Image (I / 9)", num: "9" },
  ];

  let toolbar, canvas, ctx;

  function buildUI() {
    app.innerHTML = "";

    if (IS_EDIT) {
      // ── Top bar ─────────────────────────────────────────────────────────
      const topbar = el("div", { id: "topbar" });
      topbar.innerHTML = `
        <div class="top-left">
          <input id="title-input" type="text" value="${escHtml(title)}" placeholder="Drawing title\u2026" />
        </div>
        <div class="top-center" id="toolbar"></div>
        <div class="top-right">
          <button id="btn-undo" title="Undo (Ctrl+Z)">\u21A9</button>
          <button id="btn-redo" title="Redo (Ctrl+Y)">\u21AA</button>
          <button id="btn-share" title="Share" class="btn-share">\uD83D\uDD17 Share</button>
          <button id="btn-save" title="Save (Ctrl+S)">\uD83D\uDCBE Save</button>
          <span id="save-status"></span>
        </div>
      `;
      app.appendChild(topbar);

      toolbar = topbar.querySelector("#toolbar");
      TOOLS.forEach(t => {
        const b = el("button", { class: "tool-btn" + (t.id === activeTool ? " active" : ""), title: t.title, dataset: { tool: t.id } });
        b.innerHTML = t.icon + (t.num ? `<span class="tool-num">${t.num}</span>` : "");
        toolbar.appendChild(b);
      });

      // "More" dropdown button
      const moreBtn = el("button", { id: "btn-more", class: "tool-btn", title: "More tools" });
      moreBtn.innerHTML = "\u00B7\u00B7\u00B7";
      toolbar.appendChild(moreBtn);

      const moreMenu = el("div", { id: "more-menu" });
      moreMenu.innerHTML = `
        <button id="btn-export-png">\uD83D\uDDBC Export PNG</button>
        <button id="btn-export-svg">\uD83D\uDCC4 Export SVG</button>
        <button id="btn-export-excalidraw">\uD83D\uDCC2 Export .excalidraw</button>
        <hr style="margin:4px 0;border:none;border-top:1px solid #e0e0e0;">
        <button id="btn-import-excalidraw">\uD83D\uDCE5 Import .excalidraw</button>
        <button id="btn-import-library">\uD83D\uDCDA Import Library</button>
        <hr style="margin:4px 0;border:none;border-top:1px solid #e0e0e0;">
        <button id="btn-mermaid-import">Mermaid \u2192 Draw</button>
        <button id="btn-mermaid-export">Draw \u2192 Mermaid</button>
      `;
      document.body.appendChild(moreMenu);

      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rect = moreBtn.getBoundingClientRect();
        moreMenu.style.top = (rect.bottom + 4) + "px";
        moreMenu.style.left = rect.left + "px";
        moreMenu.classList.toggle("open");
      });
      document.addEventListener("click", () => moreMenu.classList.remove("open"));
      moreMenu.querySelector("#btn-export-png").addEventListener("click", () => { moreMenu.classList.remove("open"); exportPNG(); });
      moreMenu.querySelector("#btn-export-svg").addEventListener("click", () => { moreMenu.classList.remove("open"); exportSVG(); });
      moreMenu.querySelector("#btn-export-excalidraw").addEventListener("click", () => { moreMenu.classList.remove("open"); exportExcalidraw(); });
      moreMenu.querySelector("#btn-import-excalidraw").addEventListener("click", () => { moreMenu.classList.remove("open"); importExcalidrawFile(); });
      moreMenu.querySelector("#btn-import-library").addEventListener("click", () => { moreMenu.classList.remove("open"); importExcalidrawLibrary(); });
      moreMenu.querySelector("#btn-mermaid-import").addEventListener("click", () => { moreMenu.classList.remove("open"); openMermaidImport(); });
      moreMenu.querySelector("#btn-mermaid-export").addEventListener("click", () => { moreMenu.classList.remove("open"); openMermaidExport(); });

      // Wire topbar controls
      topbar.querySelector("#btn-undo").addEventListener("click", undo);
      topbar.querySelector("#btn-redo").addEventListener("click", redo);
      topbar.querySelector("#btn-share").addEventListener("click", openShareDialog);
      topbar.querySelector("#btn-save").addEventListener("click", saveDrawing);
      topbar.querySelector("#title-input").addEventListener("input", e => { title = e.target.value; });
      toolbar.addEventListener("click", e => {
        const btn = e.target.closest(".tool-btn");
        if (!btn) return;
        setTool(btn.dataset.tool);
      });

      // ── Main area (sidebar + canvas) ───────────────────────────────────
      const mainArea = el("div", { id: "main-area" });

      const sidebar = buildSidebar();
      mainArea.appendChild(sidebar);

      const wrap = el("div", { id: "canvas-wrap" });
      canvas = el("canvas", { id: "canvas" });
      wrap.appendChild(canvas);
      mainArea.appendChild(wrap);
      app.appendChild(mainArea);

      buildFloatingBar(wrap);
      wireSidebar();
    } else {
      // ── View mode: just canvas ─────────────────────────────────────────
      const wrap = el("div", { id: "canvas-wrap" });
      canvas = el("canvas", { id: "canvas" });
      wrap.appendChild(canvas);
      app.appendChild(wrap);
      buildFloatingBar(wrap);
    }

    ctx = canvas.getContext("2d");
    injectStyles();
    resizeCanvas();
    window.addEventListener("resize", () => { resizeCanvas(); render(); });
    attachCanvasEvents();
    if (IS_EDIT) {
      window.addEventListener("keydown", onKeyDown);
    } else {
      window.addEventListener("keydown", onViewKeyDown);
    }

    // Listen for fullscreen changes
    document.addEventListener("fullscreenchange", onFullscreenChange);
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────
  function buildSidebar() {
    const sb = el("div", { id: "sidebar" });
    sb.innerHTML = `
      <div class="sb-section">
        <div class="sb-label">Stroke</div>
        <div class="sb-row" id="stroke-swatches">
          <button class="swatch" data-color="#1e1e2e" style="background:#1e1e2e" title="Black"></button>
          <button class="swatch" data-color="#e03131" style="background:#e03131" title="Red"></button>
          <button class="swatch" data-color="#2f9e44" style="background:#2f9e44" title="Green"></button>
          <button class="swatch" data-color="#1971c2" style="background:#1971c2" title="Blue"></button>
          <button class="swatch" data-color="#e8590c" style="background:#e8590c" title="Orange"></button>
          <input type="color" id="stroke-color-picker" value="${strokeColor}" title="Custom color">
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Background</div>
        <div class="sb-row" id="fill-swatches">
          <button class="swatch swatch-none" data-color="transparent" title="No fill"></button>
          <button class="swatch" data-color="#ffc9c9" style="background:#ffc9c9" title="Pink"></button>
          <button class="swatch" data-color="#b2f2bb" style="background:#b2f2bb" title="Green"></button>
          <button class="swatch" data-color="#a5d8ff" style="background:#a5d8ff" title="Blue"></button>
          <button class="swatch" data-color="#ffec99" style="background:#ffec99" title="Yellow"></button>
          <input type="color" id="fill-color-picker" value="#ffffff" title="Custom color">
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Stroke width</div>
        <div class="sb-row" id="sw-btns">
          <button class="sb-btn" data-prop="strokeWidth" data-val="1" title="Thin">
            <svg width="20" height="20" viewBox="0 0 20 20"><line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
          </button>
          <button class="sb-btn" data-prop="strokeWidth" data-val="2" title="Medium">
            <svg width="20" height="20" viewBox="0 0 20 20"><line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          </button>
          <button class="sb-btn" data-prop="strokeWidth" data-val="4" title="Thick">
            <svg width="20" height="20" viewBox="0 0 20 20"><line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Stroke style</div>
        <div class="sb-row" id="ss-btns">
          <button class="sb-btn" data-prop="strokeStyle" data-val="solid" title="Solid">
            <svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <button class="sb-btn" data-prop="strokeStyle" data-val="dashed" title="Dashed">
            <svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-dasharray="4,3" stroke-linecap="round"/></svg>
          </button>
          <button class="sb-btn" data-prop="strokeStyle" data-val="dotted" title="Dotted">
            <svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-dasharray="1.5,3" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Sloppiness</div>
        <div class="sb-row" id="rg-btns">
          <button class="sb-btn" data-prop="roughness" data-val="0" title="Architect">
            <svg width="20" height="20" viewBox="0 0 20 20"><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
          <button class="sb-btn" data-prop="roughness" data-val="1" title="Artist">
            <svg width="20" height="20" viewBox="0 0 20 20"><path d="M3 10Q7 8 10 10Q13 12 17 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
          </button>
          <button class="sb-btn" data-prop="roughness" data-val="2" title="Cartoonist">
            <svg width="20" height="20" viewBox="0 0 20 20"><path d="M3 10Q5 7 7 10Q9 13 11 10Q13 7 15 10Q16 12 17 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Edges</div>
        <div class="sb-row" id="rn-btns">
          <button class="sb-btn" data-prop="roundness" data-val="sharp" title="Sharp">
            <svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="5" width="12" height="10" rx="0" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
          </button>
          <button class="sb-btn" data-prop="roundness" data-val="round" title="Round">
            <svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="5" width="12" height="10" rx="3" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Opacity</div>
        <div class="sb-row">
          <input type="range" id="opacity-slider" min="0" max="100" value="100">
          <span id="opacity-val">100</span>
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Layers</div>
        <div class="sb-row" id="layer-btns">
          <button class="sb-btn sb-action" data-action="to-back" title="Send to back">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 13l-4-4h3V3h2v6h3z" fill="currentColor"/><line x1="3" y1="14.5" x2="13" y2="14.5" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
          <button class="sb-btn sb-action" data-action="backward" title="Send backward">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 12l-3-3h2V4h2v5h2z" fill="currentColor"/></svg>
          </button>
          <button class="sb-btn sb-action" data-action="forward" title="Bring forward">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 4l3 3h-2v5H7V7H5z" fill="currentColor"/></svg>
          </button>
          <button class="sb-btn sb-action" data-action="to-front" title="Bring to front">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 3l4 4h-3v6H7V7H4z" fill="currentColor"/><line x1="3" y1="1.5" x2="13" y2="1.5" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-section">
        <div class="sb-label">Actions</div>
        <div class="sb-row" id="action-btns">
          <button class="sb-btn sb-action" data-action="duplicate" title="Duplicate (Ctrl+D)">
            <svg width="16" height="16" viewBox="0 0 16 16"><rect x="5.5" y="1" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="2.5" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
          </button>
          <button class="sb-btn sb-action" data-action="delete" title="Delete (Del)">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M5.5 5.5v6m3-6v6M2.5 3h11m-1.5 0l-.5 9a1.5 1.5 0 01-1.5 1.4H6a1.5 1.5 0 01-1.5-1.4L4 3m2.5 0V1.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5V3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>
          </button>
          <button class="sb-btn sb-action" data-action="copy-link" title="Copy link">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M6.354 8.854a3.5 3.5 0 004.95 0l2-2a3.5 3.5 0 00-4.95-4.95l-1 1m2.292 4.242a3.5 3.5 0 00-4.95 0l-2 2a3.5 3.5 0 004.95 4.95l1-1" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-section" id="font-section" style="display:none">
        <div class="sb-label">Font family</div>
        <div class="sb-row" id="ff-btns">
          <button class="sb-btn" data-prop="fontFamily" data-val="hand" title="Handwriting">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 12.5l2-8h1l2.5 6L10 4h1l3 8.5M1 14h14" stroke="currentColor" stroke-width="0.5" fill="none"/></svg>
          </button>
          <button class="sb-btn" data-prop="fontFamily" data-val="sans-serif" title="Normal">A</button>
          <button class="sb-btn" data-prop="fontFamily" data-val="mono" title="Code">&lt;/&gt;</button>
          <button class="sb-btn" data-prop="fontFamily" data-val="serif" title="Serif"><span style="font-family:Georgia,serif;font-weight:bold">A</span></button>
        </div>
        <div class="sb-label">Font size</div>
        <div class="sb-row" id="fs-btns">
          <button class="sb-btn" data-prop="fontSize" data-val="16" title="Small (16px)">S</button>
          <button class="sb-btn" data-prop="fontSize" data-val="20" title="Medium (20px)">M</button>
          <button class="sb-btn" data-prop="fontSize" data-val="28" title="Large (28px)">L</button>
          <button class="sb-btn" data-prop="fontSize" data-val="36" title="Extra Large (36px)">XL</button>
        </div>
        <div class="sb-label">Text align</div>
        <div class="sb-row" id="ta-btns">
          <button class="sb-btn" data-prop="textAlign" data-val="left" title="Left">
            <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="3" x2="14" y2="3"/><line x1="2" y1="6.5" x2="10" y2="6.5"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="2" y1="13.5" x2="10" y2="13.5"/></svg>
          </button>
          <button class="sb-btn" data-prop="textAlign" data-val="center" title="Center">
            <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="3" x2="14" y2="3"/><line x1="4" y1="6.5" x2="12" y2="6.5"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="4" y1="13.5" x2="12" y2="13.5"/></svg>
          </button>
          <button class="sb-btn" data-prop="textAlign" data-val="right" title="Right">
            <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="3" x2="14" y2="3"/><line x1="6" y1="6.5" x2="14" y2="6.5"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="6" y1="13.5" x2="14" y2="13.5"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-section" id="angle-section" style="display:none">
        <div class="sb-label">Angle</div>
        <div class="sb-row">
          <input type="range" id="angle-slider" min="-180" max="180" value="0" step="1">
          <span id="angle-val" style="font-size:0.72rem;color:#555;min-width:30px;text-align:right">0\u00B0</span>
        </div>
      </div>
    `;
    return sb;
  }

  function wireSidebar() {
    const sb = document.getElementById("sidebar");
    if (!sb) return;

    // Stroke swatches
    sb.querySelectorAll("#stroke-swatches .swatch").forEach(btn => {
      btn.addEventListener("click", () => setProp("strokeColor", btn.dataset.color));
    });
    sb.querySelector("#stroke-color-picker").addEventListener("input", e => setProp("strokeColor", e.target.value));

    // Fill swatches
    sb.querySelectorAll("#fill-swatches .swatch").forEach(btn => {
      btn.addEventListener("click", () => setProp("fillColor", btn.dataset.color));
    });
    sb.querySelector("#fill-color-picker").addEventListener("input", e => setProp("fillColor", e.target.value));

    // Stroke width
    sb.querySelectorAll("#sw-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => setProp("strokeWidth", parseInt(btn.dataset.val)));
    });

    // Stroke style
    sb.querySelectorAll("#ss-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => setProp("strokeStyle", btn.dataset.val));
    });

    // Roughness
    sb.querySelectorAll("#rg-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => setProp("roughness", parseInt(btn.dataset.val)));
    });

    // Roundness
    sb.querySelectorAll("#rn-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => setProp("roundness", btn.dataset.val));
    });

    // Opacity
    sb.querySelector("#opacity-slider").addEventListener("input", e => {
      sb.querySelector("#opacity-val").textContent = e.target.value;
      setProp("opacity", parseInt(e.target.value));
    });

    // Layer buttons
    sb.querySelectorAll("#layer-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => layerAction(btn.dataset.action));
    });

    // Action buttons
    sb.querySelectorAll("#action-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        switch (btn.dataset.action) {
          case "duplicate": duplicateSelected(); break;
          case "delete": deleteSelected(); break;
          case "copy-link": copyLink(); break;
        }
      });
    });

    // Font family buttons
    sb.querySelectorAll("#ff-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => setProp("fontFamily", btn.dataset.val));
    });
    // Font size buttons
    sb.querySelectorAll("#fs-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => setProp("fontSize", parseInt(btn.dataset.val)));
    });
    // Text align buttons
    sb.querySelectorAll("#ta-btns .sb-btn").forEach(btn => {
      btn.addEventListener("click", () => setProp("textAlign", btn.dataset.val));
    });

    // Angle slider
    sb.querySelector("#angle-slider").addEventListener("input", e => {
      const deg = parseInt(e.target.value);
      sb.querySelector("#angle-val").textContent = deg + "\u00B0";
      if (selectedIds.size === 1) {
        const sel = scene.elements.find(el => selectedIds.has(el.id));
        if (sel) {
          snapshot();
          sel.angle = deg * Math.PI / 180;
          render();
        }
      }
    });
  }

  // ── Floating action bar ─────────────────────────────────────────────────
  function buildFloatingBar(wrap) {
    const bar = el("div", { id: "godraw-fab" });

    // Fullscreen toggle
    const fsBtn = el("button", { id: "btn-fullscreen", title: "Toggle fullscreen (F11)" });
    fsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4A1.5 1.5 0 0 1 1.5 0h4a.5.5 0 0 1 0 1h-4zM10 .5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 16 1.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zM.5 10a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 0 14.5v-4a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5z"/></svg>';
    fsBtn.addEventListener("click", toggleFullscreen);
    bar.appendChild(fsBtn);

    // Dark mode toggle
    const dmBtn = el("button", { id: "btn-dark-mode", title: "Toggle dark mode" });
    dmBtn.innerHTML = darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19';
    dmBtn.addEventListener("click", toggleDarkMode);
    bar.appendChild(dmBtn);

    // New canvas button (in embedded mode or always available)
    const newBtn = el("button", { id: "btn-new-canvas", title: "New canvas" });
    newBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/></svg>';
    newBtn.addEventListener("click", createNewCanvas);
    bar.appendChild(newBtn);

    wrap.appendChild(bar);
  }

  // ── Fullscreen ──────────────────────────────────────────────────────────
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const target = document.documentElement;
      (target.requestFullscreen || target.webkitRequestFullscreen).call(target);
    }
  }

  function onFullscreenChange() {
    const btn = document.getElementById("btn-fullscreen");
    if (!btn) return;
    if (isFullscreen()) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 0a.5.5 0 0 1 .5.5v4A1.5 1.5 0 0 1 4.5 6h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 10 4.5v-4a.5.5 0 0 1 .5-.5zM0 10.5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 6 11.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zm10 0a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4z"/></svg>';
      btn.title = "Exit fullscreen (Esc)";
    } else {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4A1.5 1.5 0 0 1 1.5 0h4a.5.5 0 0 1 0 1h-4zM10 .5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 16 1.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zM.5 10a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 0 14.5v-4a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5z"/></svg>';
      btn.title = "Toggle fullscreen (F11)";
    }
    // Resize after fullscreen transition
    setTimeout(() => { resizeCanvas(); render(); }, 100);
    // Notify parent if embedded
    postToParent("fullscreen", { active: isFullscreen() });
  }

  // ── New canvas ──────────────────────────────────────────────────────────
  async function createNewCanvas() {
    try {
      const res = await fetch(`${CFG.basePath}/api/new`, { method: "POST" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      // Notify parent of new canvas
      postToParent("new-canvas", { id: data.id, edit_url: data.edit_url, view_url: data.view_url });
      // Navigate to the new drawing editor
      window.location.href = data.edit_url;
    } catch (err) {
      console.error("go-draw: failed to create new canvas", err);
    }
  }

  // ── PostMessage API (for host page communication) ──────────────────────
  function postToParent(type, payload) {
    if (!IS_EMBED) return;
    try {
      window.parent.postMessage({ source: "go-draw", type, ...payload }, "*");
    } catch (_) { /* cross-origin, ignore */ }
  }

  // Listen for commands from host page
  window.addEventListener("message", e => {
    if (!e.data || e.data.source !== "go-draw-host") return;
    switch (e.data.type) {
      case "fullscreen":
        toggleFullscreen();
        break;
      case "get-size":
        postToParent("size", { width: canvas.width, height: canvas.height });
        break;
    }
  });

  function el(tag, attrs) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "dataset") {
        for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
      } else if (k === "class") {
        e.className = v;
      } else {
        e[k] = v;
      }
    }
    return e;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function injectStyles() {
    if (document.getElementById("godraw-styles")) return;
    const s = document.createElement("style");
    s.id = "godraw-styles";
    s.textContent = `
      #app { display:flex; flex-direction:column; width:100%; height:100%; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      #topbar { display:flex; align-items:center; gap:8px; padding:6px 12px; background:#fff; border-bottom:1px solid #e0e0e0; flex-shrink:0; z-index:10; }
      .top-left,.top-right { display:flex; align-items:center; gap:6px; }
      .top-center { flex:1; display:flex; justify-content:center; }
      #title-input { border:1px solid #ddd; border-radius:6px; padding:4px 8px; font-size:.875rem; width:160px; outline:none; }
      #title-input:focus { border-color:#1e1e2e; }
      #toolbar { display:flex; gap:4px; background:#f4f4f5; border-radius:8px; padding:4px; }
      #toolbar .tool-btn { position:relative; background:none; border:none; border-radius:6px; padding:5px 10px; font-size:1rem; cursor:pointer; color:#555; transition:background .15s; }
      #toolbar .tool-btn:hover { background:#e4e4e7; }
      #toolbar .tool-btn.active { background:#6366f1; color:#fff; box-shadow:0 1px 4px rgba(99,102,241,0.4); }
      .tool-num { position:absolute; bottom:0; right:1px; font-size:8px; line-height:1; opacity:0.55; pointer-events:none; font-family:monospace; }
      .top-right button { background:#f4f4f5; border:none; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:.85rem; }
      .top-right button:hover { background:#e4e4e7; }
      .btn-share { background:#6366f1 !important; color:#fff !important; font-weight:600; }
      .btn-share:hover { background:#5558e6 !important; }
      #btn-save { background:#1e1e2e; color:#fff; font-weight:600; }
      #btn-save:hover { background:#333; }
      #save-status { font-size:.75rem; color:#888; }

      /* Main area: sidebar + canvas */
      #main-area { display:flex; flex:1; overflow:hidden; }

      /* Sidebar */
      #sidebar { width:202px; background:#fff; border-right:1px solid #e0e0e0; overflow-y:auto; flex-shrink:0; padding:4px 0; }
      .sb-section { padding:6px 12px; border-bottom:1px solid #f0f0f0; }
      .sb-section:last-child { border-bottom:none; }
      .sb-label { font-size:0.68rem; color:#999; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px; font-weight:500; }
      .sb-row { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }

      /* Color swatches */
      .swatch { width:22px; height:22px; border-radius:4px; border:2px solid transparent; cursor:pointer; padding:0; box-sizing:border-box; flex-shrink:0; }
      .swatch:hover { border-color:#aaa; }
      .swatch.active { border-color:#1e1e2e; box-shadow:0 0 0 1px #1e1e2e; }
      .swatch-none { background:#fff; border:2px solid #ddd; position:relative; overflow:hidden; }
      .swatch-none::after { content:''; position:absolute; top:0; left:0; right:0; bottom:0; background:linear-gradient(to top right, transparent calc(50% - 0.8px), #e03131 calc(50% - 0.8px), #e03131 calc(50% + 0.8px), transparent calc(50% + 0.8px)); }
      .swatch-none.active { border-color:#1e1e2e; }
      #sidebar input[type=color] { width:22px; height:22px; padding:0; border:1px solid #ddd; border-radius:4px; cursor:pointer; flex-shrink:0; }

      /* Property buttons */
      .sb-btn { display:flex; align-items:center; justify-content:center; width:32px; height:28px; border:1px solid transparent; border-radius:4px; background:none; cursor:pointer; color:#555; padding:0; transition:background .12s; }
      .sb-btn:hover { background:#f0f0f0; }
      .sb-btn.active { background:#e4e4e7; border-color:#ccc; color:#1e1e2e; }

      /* Opacity slider */
      #sidebar input[type=range] { flex:1; height:4px; accent-color:#1e1e2e; cursor:pointer; }
      #opacity-val { font-size:0.72rem; color:#555; min-width:24px; text-align:right; }

      /* Font size select */
      #sidebar select { font-size:0.8rem; border:1px solid #ddd; border-radius:4px; padding:3px 6px; width:100%; cursor:pointer; }

      /* Canvas wrap */
      #canvas-wrap { flex:1; position:relative; overflow:hidden; background:#f4f4f5; }
      #canvas { display:block; cursor:crosshair; }

      /* Floating action bar */
      #godraw-fab { position:absolute; bottom:12px; right:12px; display:flex; gap:6px; z-index:20; }
      #godraw-fab button { width:36px; height:36px; border:none; border-radius:8px; background:rgba(255,255,255,0.92); color:#333; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.15); transition:background .15s, box-shadow .15s; }
      #godraw-fab button:hover { background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.2); }

      /* More dropdown */
      #more-menu { position:fixed; display:none; background:#fff; border:1px solid #e0e0e0; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.15); padding:4px; z-index:1000; min-width:160px; }
      #more-menu.open { display:block; }
      #more-menu button { display:block; width:100%; text-align:left; background:none; border:none; padding:8px 12px; font-size:.85rem; cursor:pointer; border-radius:4px; }
      #more-menu button:hover { background:#f0f0f0; }

      /* Modal */
      .godraw-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; z-index:2000; }
      .godraw-modal { background:#fff; border-radius:12px; padding:20px; min-width:360px; max-width:90vw; box-shadow:0 8px 32px rgba(0,0,0,0.2); }
      .godraw-modal h3 { margin:0 0 12px; font-size:1rem; }
      .godraw-modal textarea { width:100%; min-height:140px; font-family:monospace; font-size:.85rem; border:1px solid #ddd; border-radius:6px; padding:8px; resize:vertical; box-sizing:border-box; }
      .godraw-modal .modal-actions { display:flex; gap:8px; margin-top:12px; justify-content:flex-end; }
      .godraw-modal .modal-btn { padding:6px 16px; border:none; border-radius:6px; cursor:pointer; font-size:.85rem; }
      .godraw-modal .modal-btn-primary { background:#1e1e2e; color:#fff; }
      .godraw-modal .modal-btn-primary:hover { background:#333; }
      .godraw-modal .modal-btn-secondary { background:#f0f0f0; color:#333; }

      /* Library picker */
      .lib-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:8px; max-height:60vh; overflow-y:auto; padding:4px; }
      .lib-item { display:flex; flex-direction:column; align-items:center; padding:8px; border:1px solid #e0e0e0; border-radius:8px; cursor:pointer; transition:background .15s, border-color .15s; }
      .lib-item:hover { background:#f0f0ff; border-color:#6366f1; }
      .lib-preview { width:100px; height:80px; border-radius:4px; background:#fafafa; }
      .lib-name { font-size:.72rem; color:#555; margin-top:4px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100px; }

      /* Dark mode */
      .godraw-dark #topbar { background:#1e1e2e; border-bottom-color:#333; }
      .godraw-dark #title-input { background:#2a2a3e; color:#e0e0e0; border-color:#444; }
      .godraw-dark #title-input:focus { border-color:#6366f1; }
      .godraw-dark #toolbar { background:#2a2a3e; }
      .godraw-dark #toolbar .tool-btn { color:#bbb; }
      .godraw-dark #toolbar .tool-btn:hover { background:#3a3a4e; }
      .godraw-dark .top-right button { background:#2a2a3e; color:#ccc; }
      .godraw-dark .top-right button:hover { background:#3a3a4e; }
      .godraw-dark #btn-save { background:#6366f1; color:#fff; }
      .godraw-dark #btn-save:hover { background:#5558e6; }
      .godraw-dark #sidebar { background:#1e1e2e; border-right-color:#333; }
      .godraw-dark .sb-label { color:#777; }
      .godraw-dark .sb-section { border-bottom-color:#2a2a3e; }
      .godraw-dark .sb-btn { color:#bbb; }
      .godraw-dark .sb-btn:hover { background:#2a2a3e; }
      .godraw-dark .sb-btn.active { background:#3a3a4e; border-color:#555; color:#e0e0e0; }
      .godraw-dark #canvas-wrap { background:#1a1a2e; }
      .godraw-dark #godraw-fab button { background:rgba(30,30,46,0.92); color:#ccc; }
      .godraw-dark #godraw-fab button:hover { background:#2a2a3e; }
      .godraw-dark #more-menu { background:#1e1e2e; border-color:#333; }
      .godraw-dark #more-menu button { color:#ccc; }
      .godraw-dark #more-menu button:hover { background:#2a2a3e; }
      .godraw-dark .godraw-modal { background:#1e1e2e; color:#e0e0e0; }
      .godraw-dark .godraw-modal textarea { background:#2a2a3e; color:#e0e0e0; border-color:#444; }
      .godraw-dark .godraw-modal .modal-btn-secondary { background:#2a2a3e; color:#ccc; }
      .godraw-dark #sidebar input[type=color] { border-color:#444; }
      .godraw-dark #sidebar select { background:#2a2a3e; color:#e0e0e0; border-color:#444; }
      .godraw-dark #sidebar input[type=range] { accent-color:#6366f1; }
      .godraw-dark #save-status { color:#666; }
      .godraw-dark .lib-item { border-color:#444; }
      .godraw-dark .lib-item:hover { background:#2a2a3e; border-color:#6366f1; }
      .godraw-dark .lib-preview { background:#2a2a3e; }
      .godraw-dark .lib-name { color:#999; }

      /* Responsive: collapse sidebar */
      @media (max-width:580px) {
        #sidebar { width:48px; padding:2px 0; }
        .sb-label { display:none; }
        .sb-section { padding:4px; }
        .sb-row { justify-content:center; }
        .swatch { width:18px; height:18px; }
        #sidebar input[type=color] { width:18px; height:18px; }
        .sb-btn { width:28px; height:24px; }
        #sidebar select { width:40px; font-size:0.7rem; }
        #opacity-slider { width:36px; }
        #opacity-val { display:none; }
        #sidebar .sb-action[data-action="copy-link"] { display:none; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Resize ────────────────────────────────────────────────────────────────
  function resizeCanvas() {
    const wrap = canvas.parentElement;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────
  function canvasToWorld(cx, cy) {
    return {
      x: (cx - vp.x) / vp.scale,
      y: (cy - vp.y) / vp.scale,
    };
  }

  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
    };
  }

  // ── Roughness helpers ─────────────────────────────────────────────────────
  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h) || 1;
  }

  function seededRandom(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roughLine(ctx, x1, y1, x2, y2, rough, rng) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.1) return;
    const amp = rough * Math.min(len * 0.08, 6);
    const dx = x2 - x1, dy = y2 - y1;
    const nx = -dy / len, ny = dx / len;
    const cpx = (x1 + x2) / 2 + nx * (rng() - 0.5) * amp * 2;
    const cpy = (y1 + y2) / 2 + ny * (rng() - 0.5) * amp * 2;
    ctx.moveTo(x1 + (rng() - 0.5) * amp * 0.5, y1 + (rng() - 0.5) * amp * 0.5);
    ctx.quadraticCurveTo(cpx, cpy, x2 + (rng() - 0.5) * amp * 0.5, y2 + (rng() - 0.5) * amp * 0.5);
  }

  function roughEllipse(ctx, cx, cy, rx, ry, rough, rng) {
    const steps = 24;
    const maxR = Math.max(rx, ry);
    const amp = rough * Math.min(maxR * 0.05, 4);
    const sx = cx + (rx + (rng() - 0.5) * amp * 2);
    const sy = cy + (rng() - 0.5) * amp;
    ctx.moveTo(sx, sy);
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * (rx + (rng() - 0.5) * amp * 2);
      const y = cy + Math.sin(a) * (ry + (rng() - 0.5) * amp * 2);
      const pa = ((i - 0.5) / steps) * Math.PI * 2;
      const cpx = cx + Math.cos(pa) * (rx + (rng() - 0.5) * amp * 3);
      const cpy = cy + Math.sin(pa) * (ry + (rng() - 0.5) * amp * 3);
      ctx.quadraticCurveTo(cpx, cpy, x, y);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  const GRID_SIZE = 20;

  function render() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = darkMode ? "#1a1a2e" : "#f8f8f8";
    ctx.fillRect(0, 0, W, H);

    // Dot grid
    const gs = GRID_SIZE * vp.scale;
    const offX = ((vp.x % gs) + gs) % gs;
    const offY = ((vp.y % gs) + gs) % gs;
    ctx.fillStyle = darkMode ? "#3a3a5c" : "#d4d4d8";
    for (let x = offX; x < W; x += gs) {
      for (let y = offY; y < H; y += gs) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // World transform
    ctx.save();
    ctx.translate(vp.x, vp.y);
    ctx.scale(vp.scale, vp.scale);

    // Draw all elements
    for (const el of scene.elements) {
      drawElement(ctx, el);
    }

    // Current element (being drawn)
    if (currentEl) drawElement(ctx, currentEl);

    // Selection handles
    if (IS_EDIT) {
      for (const el of scene.elements) {
        if (selectedIds.has(el.id)) drawSelection(ctx, el);
      }
    }

    // Marquee selection rectangle
    if (marquee) {
      ctx.save();
      ctx.fillStyle = "rgba(99, 102, 241, 0.08)";
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 1 / vp.scale;
      ctx.setLineDash([4 / vp.scale, 4 / vp.scale]);
      ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h);
      ctx.strokeRect(marquee.x, marquee.y, marquee.w, marquee.h);
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore();

    // Eraser cursor — drawn in screen space
    if (activeTool === "eraser" && eraserCursorPos) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(eraserCursorPos.cx, eraserCursorPos.cy, ERASER_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = "#e03131";
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.restore();
    }

    // Sync sidebar with current state
    if (IS_EDIT) updateSidebar();
  }

  function applyStyle(ctx, el) {
    ctx.strokeStyle = el.strokeColor || "#1e1e2e";
    ctx.fillStyle = el.fillColor || "transparent";
    ctx.lineWidth = el.strokeWidth || 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = (el.opacity ?? 100) / 100;

    // Stroke style (dash pattern)
    const sw = el.strokeWidth || 2;
    switch (el.strokeStyle || "solid") {
      case "dashed": ctx.setLineDash([sw * 4, sw * 3]); break;
      case "dotted": ctx.setLineDash([sw * 0.5, sw * 2.5]); break;
      default: ctx.setLineDash([]); break;
    }
  }

  function drawElement(ctx, el) {
    ctx.save();
    applyStyle(ctx, el);
    // Apply rotation around element center
    const angle = el.angle || 0;
    if (angle) {
      const c = getCenter(el);
      ctx.translate(c.x, c.y);
      ctx.rotate(angle);
      ctx.translate(-c.x, -c.y);
    }
    switch (el.type) {
      case "rect":     drawRect(ctx, el); break;
      case "diamond":  drawDiamond(ctx, el); break;
      case "ellipse":  drawEllipse(ctx, el); break;
      case "line":     drawLine(ctx, el); break;
      case "arrow":    drawArrow(ctx, el); break;
      case "pencil":   drawPencil(ctx, el); break;
      case "text":     drawText(ctx, el); break;
      case "image":    drawImage(ctx, el); break;
    }
    // Render inline text label for shapes
    if (el.text && el.type !== "text") {
      drawShapeText(ctx, el);
    }
    ctx.restore();
  }

  function drawShapeText(ctx, el) {
    const bb = getBBox(el);
    const fs = el.fontSize || 16;
    ctx.font = `${fs}px ${fontCSS(el.fontFamily)}`;
    ctx.fillStyle = el.strokeColor || "#1e1e2e";
    ctx.textBaseline = "middle";
    const align = el.textAlign || "center";
    ctx.textAlign = align;
    ctx.setLineDash([]);
    const lines = el.text.split("\n");
    const lineHeight = fs * 1.3;
    const totalH = lines.length * lineHeight;
    const startY = bb.y + bb.h / 2 - totalH / 2 + lineHeight / 2;
    lines.forEach((line, i) => {
      let tx = bb.x + bb.w / 2;
      if (align === "left") tx = bb.x + 8;
      else if (align === "right") tx = bb.x + bb.w - 8;
      ctx.fillText(line, tx, startY + i * lineHeight);
    });
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  function drawRect(ctx, el) {
    const { x, y, w, h } = el;
    const r = el.roughness ?? 0;
    const rn = el.roundness || "sharp";
    const radius = rn === "round" ? Math.min(Math.abs(w), Math.abs(h)) * 0.15 : 0;

    // Fill (always clean path)
    if (el.fillColor && el.fillColor !== "transparent") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fillStyle = el.fillColor;
      ctx.fill();
    }

    if (r === 0) {
      // Clean stroke
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.stroke();
    } else {
      // Rough stroke — normalize corners
      const x0 = Math.min(x, x + w), y0 = Math.min(y, y + h);
      const x1 = Math.max(x, x + w), y1 = Math.max(y, y + h);
      const seed = hashCode(el.id);
      for (let pass = 0; pass < 2; pass++) {
        const rng = seededRandom(seed + pass * 1000);
        ctx.beginPath();
        roughLine(ctx, x0, y0, x1, y0, r, rng);
        roughLine(ctx, x1, y0, x1, y1, r, rng);
        roughLine(ctx, x1, y1, x0, y1, r, rng);
        roughLine(ctx, x0, y1, x0, y0, r, rng);
        ctx.stroke();
      }
    }
  }

  function drawDiamond(ctx, el) {
    const { x, y, w, h } = el;
    const r = el.roughness ?? 0;
    const cx = x + w / 2, cy = y + h / 2;

    // Fill (always clean path)
    if (el.fillColor && el.fillColor !== "transparent") {
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.lineTo(x + w, cy);
      ctx.lineTo(cx, y + h);
      ctx.lineTo(x, cy);
      ctx.closePath();
      ctx.fillStyle = el.fillColor;
      ctx.fill();
    }

    if (r === 0) {
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.lineTo(x + w, cy);
      ctx.lineTo(cx, y + h);
      ctx.lineTo(x, cy);
      ctx.closePath();
      ctx.stroke();
    } else {
      const seed = hashCode(el.id);
      for (let pass = 0; pass < 2; pass++) {
        const rng = seededRandom(seed + pass * 1000);
        ctx.beginPath();
        roughLine(ctx, cx, y, x + w, cy, r, rng);
        roughLine(ctx, x + w, cy, cx, y + h, r, rng);
        roughLine(ctx, cx, y + h, x, cy, r, rng);
        roughLine(ctx, x, cy, cx, y, r, rng);
        ctx.stroke();
      }
    }
  }

  function drawEllipse(ctx, el) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    const rx = Math.abs(el.w / 2), ry = Math.abs(el.h / 2);
    const r = el.roughness ?? 0;

    // Fill (always clean path)
    if (el.fillColor && el.fillColor !== "transparent") {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = el.fillColor;
      ctx.fill();
    }

    if (r === 0) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const seed = hashCode(el.id);
      for (let pass = 0; pass < 2; pass++) {
        const rng = seededRandom(seed + pass * 1000);
        ctx.beginPath();
        roughEllipse(ctx, cx, cy, rx, ry, r, rng);
        ctx.stroke();
      }
    }
  }

  function drawLine(ctx, el) {
    const r = el.roughness ?? 0;
    if (el.pts && el.pts.length > 1) {
      if (r === 0) {
        ctx.beginPath();
        ctx.moveTo(el.pts[0].x, el.pts[0].y);
        for (let i = 1; i < el.pts.length; i++) ctx.lineTo(el.pts[i].x, el.pts[i].y);
        ctx.stroke();
      } else {
        const seed = hashCode(el.id);
        for (let pass = 0; pass < 2; pass++) {
          const rng = seededRandom(seed + pass * 1000);
          ctx.beginPath();
          for (let i = 1; i < el.pts.length; i++) roughLine(ctx, el.pts[i-1].x, el.pts[i-1].y, el.pts[i].x, el.pts[i].y, r, rng);
          ctx.stroke();
        }
      }
      return;
    }
    if (r === 0) {
      ctx.beginPath();
      ctx.moveTo(el.x, el.y);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
    } else {
      const seed = hashCode(el.id);
      for (let pass = 0; pass < 2; pass++) {
        const rng = seededRandom(seed + pass * 1000);
        ctx.beginPath();
        roughLine(ctx, el.x, el.y, el.x2, el.y2, r, rng);
        ctx.stroke();
      }
    }
  }

  function drawArrow(ctx, el) {
    const r = el.roughness ?? 0;
    let endX, endY, prevX, prevY;

    if (el.pts && el.pts.length > 1) {
      // Multi-point arrow
      if (r === 0) {
        ctx.beginPath();
        ctx.moveTo(el.pts[0].x, el.pts[0].y);
        for (let i = 1; i < el.pts.length; i++) ctx.lineTo(el.pts[i].x, el.pts[i].y);
        ctx.stroke();
      } else {
        const seed = hashCode(el.id);
        for (let pass = 0; pass < 2; pass++) {
          const rng = seededRandom(seed + pass * 1000);
          ctx.beginPath();
          for (let i = 1; i < el.pts.length; i++) roughLine(ctx, el.pts[i-1].x, el.pts[i-1].y, el.pts[i].x, el.pts[i].y, r, rng);
          ctx.stroke();
        }
      }
      endX = el.pts[el.pts.length-1].x; endY = el.pts[el.pts.length-1].y;
      prevX = el.pts[el.pts.length-2].x; prevY = el.pts[el.pts.length-2].y;
    } else {
      const dx = el.x2 - el.x, dy = el.y2 - el.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      if (r === 0) {
        ctx.beginPath();
        ctx.moveTo(el.x, el.y);
        ctx.lineTo(el.x2, el.y2);
        ctx.stroke();
      } else {
        const seed = hashCode(el.id);
        for (let pass = 0; pass < 2; pass++) {
          const rng = seededRandom(seed + pass * 1000);
          ctx.beginPath();
          roughLine(ctx, el.x, el.y, el.x2, el.y2, r, rng);
          ctx.stroke();
        }
      }
      endX = el.x2; endY = el.y2;
      prevX = el.x; prevY = el.y;
    }

    // Arrowhead (always clean)
    const adx = endX - prevX, ady = endY - prevY;
    const alen = Math.hypot(adx, ady);
    if (alen < 1) return;
    const ux = adx / alen, uy = ady / alen;
    const hw = 10, hl = 18;
    ctx.setLineDash([]); // arrowhead always solid
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - hl * ux + hw * uy, endY - hl * uy - hw * ux);
    ctx.lineTo(endX - hl * ux - hw * uy, endY - hl * uy + hw * ux);
    ctx.closePath();
    ctx.fillStyle = el.strokeColor || "#1e1e2e";
    ctx.fill();
  }

  function drawPencil(ctx, el) {
    if (!el.pts || el.pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(el.pts[0].x, el.pts[0].y);
    for (let i = 1; i < el.pts.length; i++) {
      const mp = { x: (el.pts[i - 1].x + el.pts[i].x) / 2, y: (el.pts[i - 1].y + el.pts[i].y) / 2 };
      ctx.quadraticCurveTo(el.pts[i - 1].x, el.pts[i - 1].y, mp.x, mp.y);
    }
    ctx.stroke();
  }

  function drawText(ctx, el) {
    const fs = el.fontSize || 16;
    ctx.font = `${fs}px ${fontCSS(el.fontFamily)}`;
    ctx.fillStyle = el.strokeColor || "#1e1e2e";
    ctx.textBaseline = "top";
    const align = el.textAlign || "left";
    ctx.textAlign = align;
    const lines = (el.text || "").split("\n");
    const w = el.w || 0;
    lines.forEach((line, i) => {
      let tx = el.x;
      if (align === "center") tx = el.x + w / 2;
      else if (align === "right") tx = el.x + w;
      ctx.fillText(line, tx, el.y + i * fs * 1.3);
    });
    ctx.textAlign = "start";
  }

  function drawImage(ctx, el) {
    const img = getImage(el.src);
    const w = el.w || 200, h = el.h || 150;
    if (img.complete && img.naturalWidth) {
      ctx.drawImage(img, el.x, el.y, w, h);
    } else {
      // Placeholder while loading
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#999";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(el.x, el.y, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ccc";
      ctx.font = "14px sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText("Loading\u2026", el.x + w / 2, el.y + h / 2);
      ctx.restore();
    }
  }

  const ROTATE_HANDLE_DIST = 25; // pixels from top of selection box

  function drawSelection(ctx, el) {
    const bb = getBBox(el);
    const pad = 6;
    const angle = el.angle || 0;
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;

    ctx.save();
    ctx.globalAlpha = 1;

    // Rotate selection around element center
    if (angle) {
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.translate(-cx, -cy);
    }

    // Dashed selection rect
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5 / vp.scale;
    ctx.setLineDash([4 / vp.scale, 3 / vp.scale]);
    ctx.strokeRect(bb.x - pad, bb.y - pad, bb.w + pad * 2, bb.h + pad * 2);
    ctx.setLineDash([]);

    // Corner handles
    const corners = [
      [bb.x - pad, bb.y - pad],
      [bb.x + bb.w + pad, bb.y - pad],
      [bb.x - pad, bb.y + bb.h + pad],
      [bb.x + bb.w + pad, bb.y + bb.h + pad],
    ];
    corners.forEach(([hx, hy]) => {
      ctx.beginPath();
      ctx.arc(hx, hy, 4 / vp.scale, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / vp.scale;
      ctx.stroke();
    });

    // Rotation handle — stem line from top-center to handle
    const handleDist = ROTATE_HANDLE_DIST / vp.scale;
    const stemX = bb.x + bb.w / 2;
    const stemTopY = bb.y - pad;
    const handleY = stemTopY - handleDist;

    ctx.beginPath();
    ctx.moveTo(stemX, stemTopY);
    ctx.lineTo(stemX, handleY);
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1 / vp.scale;
    ctx.stroke();

    // Rotation handle circle
    ctx.beginPath();
    ctx.arc(stemX, handleY, 5 / vp.scale, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5 / vp.scale;
    ctx.stroke();

    // Rotation icon (↻) inside handle
    ctx.fillStyle = "#3b82f6";
    ctx.font = `${9 / vp.scale}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("\u21BB", stemX, handleY);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    ctx.restore();
  }

  function getRotationHandlePos(el) {
    const bb = getBBox(el);
    const pad = 6;
    const angle = el.angle || 0;
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    const handleDist = ROTATE_HANDLE_DIST / vp.scale;
    const localX = bb.x + bb.w / 2;
    const localY = bb.y - pad - handleDist;
    if (!angle) return { x: localX, y: localY };
    return rotatePoint(localX, localY, cx, cy, angle);
  }

  function getBBox(el) {
    switch (el.type) {
      case "rect":
      case "diamond":
      case "ellipse":
      case "text":
      case "image":
        return { x: el.x, y: el.y, w: el.w || 0, h: el.h || 0 };
      case "line":
      case "arrow": {
        if (el.pts && el.pts.length > 1) {
          const xs = el.pts.map(p => p.x), ys = el.pts.map(p => p.y);
          const mx = Math.min(...xs), my = Math.min(...ys);
          return { x: mx, y: my, w: Math.max(...xs) - mx, h: Math.max(...ys) - my };
        }
        const x = Math.min(el.x, el.x2), y = Math.min(el.y, el.y2);
        return { x, y, w: Math.abs(el.x2 - el.x), h: Math.abs(el.y2 - el.y) };
      }
      case "pencil": {
        if (!el.pts || !el.pts.length) return { x: 0, y: 0, w: 0, h: 0 };
        const xs = el.pts.map(p => p.x), ys = el.pts.map(p => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      default:
        return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  function getCenter(el) {
    const bb = getBBox(el);
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  }

  function rotatePoint(px, py, cx, cy, angle) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const dx = px - cx, dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  // ── Hit testing ───────────────────────────────────────────────────────────
  function hitTest(el, wx, wy) {
    // Un-rotate the test point into element's local coordinate space
    const angle = el.angle || 0;
    if (angle) {
      const c = getCenter(el);
      const p = rotatePoint(wx, wy, c.x, c.y, -angle);
      wx = p.x;
      wy = p.y;
    }
    const pad = 8;
    switch (el.type) {
      case "rect":
      case "diamond":
      case "ellipse":
      case "text":
      case "image": {
        const x0 = Math.min(el.x, el.x + el.w), y0 = Math.min(el.y, el.y + el.h);
        const x1 = x0 + Math.abs(el.w), y1 = y0 + Math.abs(el.h);
        return wx >= x0 - pad && wx <= x1 + pad && wy >= y0 - pad && wy <= y1 + pad;
      }
      case "line":
      case "arrow": {
        if (el.pts && el.pts.length > 1) {
          for (let i = 1; i < el.pts.length; i++) {
            if (distToSegment(wx, wy, el.pts[i-1].x, el.pts[i-1].y, el.pts[i].x, el.pts[i].y) < pad + el.strokeWidth) return true;
          }
          return false;
        }
        return distToSegment(wx, wy, el.x, el.y, el.x2, el.y2) < pad + el.strokeWidth;
      }
      case "pencil": {
        if (!el.pts) return false;
        for (let i = 1; i < el.pts.length; i++) {
          if (distToSegment(wx, wy, el.pts[i-1].x, el.pts[i-1].y, el.pts[i].x, el.pts[i].y) < pad + el.strokeWidth) return true;
        }
        return false;
      }
      default: return false;
    }
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function attachCanvasEvents() {
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDblClick);
    // Touch support
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
  }

  function onMouseDown(e) {
    if (e.button === 1 || (e.button === 0 && (e.altKey || e.spaceKey))) {
      // Middle click = pan
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const { cx, cy } = getMousePos(e);

    // Spacebar held = pan regardless of tool
    if (spaceDown) { startPan(e); return; }

    const { x: wx, y: wy } = canvasToWorld(cx, cy);
    startX = wx; startY = wy;

    if (!IS_EDIT) {
      startPan(e);
      return;
    }

    if (activeTool === "hand") {
      startPan(e);
      return;
    }

    if (activeTool === "select") {
      // Check rotation handle first (only when exactly one element selected)
      if (selectedIds.size === 1) {
        const sel = scene.elements.find(e => selectedIds.has(e.id));
        if (sel) {
          const rh = getRotationHandlePos(sel);
          if (Math.hypot(wx - rh.x, wy - rh.y) < 8 / vp.scale) {
            isRotating = true;
            const c = getCenter(sel);
            rotateStartAngle = Math.atan2(wy - c.y, wx - c.x);
            rotateOriginalAngle = sel.angle || 0;
            snapshot();
            canvas.style.cursor = "grabbing";
            render();
            return;
          }
        }
      }
      // Hit test in reverse (topmost first)
      const hit = [...scene.elements].reverse().find(el => hitTest(el, wx, wy));
      if (hit) {
        if (e.shiftKey) {
          // Shift+click: toggle element in/out of selection
          selectedIds = new Set(selectedIds);
          if (selectedIds.has(hit.id)) selectedIds.delete(hit.id);
          else selectedIds.add(hit.id);
        } else if (!selectedIds.has(hit.id)) {
          selectedIds = new Set([hit.id]);
        }
        isDragging = true;
        dragOffset = { x: wx - startX, y: wy - startY };
      } else {
        if (!e.shiftKey) selectedIds.clear();
        // Start marquee selection on empty area
        marquee = { x: wx, y: wy, w: 0, h: 0 };
      }
      render();
      return;
    }

    if (activeTool === "eraser") {
      snapshot();
      eraserActive = true;
      erasedIds = new Set();
      // Erase anything under the cursor
      const hit = scene.elements.find(el => hitTest(el, wx, wy));
      if (hit) {
        erasedIds.add(hit.id);
        scene.elements = scene.elements.filter(el => el.id !== hit.id);
      }
      render();
      return;
    }

    if (activeTool === "image") {
      const clickX = wx, clickY = wy;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        if (!input.files || !input.files[0]) return;
        const fd = new FormData();
        fd.append("file", input.files[0]);
        try {
          const res = await fetch(`${CFG.basePath}/api/upload`, { method: "POST", body: fd });
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          snapshot();
          const img = getImage(data.url);
          const imgEl = {
            id: uid(), type: "image",
            x: clickX, y: clickY,
            w: 200, h: 150,
            src: data.url,
            opacity: 100,
          };
          // Try to use natural dimensions once loaded
          if (img.complete && img.naturalWidth) {
            imgEl.w = Math.min(img.naturalWidth, 400);
            imgEl.h = imgEl.w * (img.naturalHeight / img.naturalWidth);
          }
          scene.elements.push(imgEl);
          selectedIds = new Set([imgEl.id]);
          render();
        } catch (err) {
          console.error("go-draw: upload failed", err);
        }
      };
      input.click();
      return;
    }

    if (activeTool === "text") {
      e.preventDefault(); // prevent browser focus logic from stealing textarea focus
      commitTextInput();
      // If clicking on an existing element, edit its text
      const hit = [...scene.elements].reverse().find(el => hitTest(el, wx, wy));
      if (hit && hit.type === "text") {
        startTextInputOnElement(hit);
      } else if (hit && (hit.type === "rect" || hit.type === "diamond" || hit.type === "ellipse")) {
        startTextInputOnShape(hit);
      } else {
        startTextInput(wx, wy);
      }
      return;
    }

    // Start new shape
    drawing = true;
    pencilPoints = [{ x: wx, y: wy }];
    currentEl = makeElement(wx, wy);
  }

  function onMouseMove(e) {
    if (panning) {
      const { cx, cy } = getMousePos(e);
      vp.x = panStart.vpx + (cx - panStart.x);
      vp.y = panStart.vpy + (cy - panStart.y);
      render();
      return;
    }
    if (!IS_EDIT) return;

    const { cx, cy } = getMousePos(e);
    const { x: wx, y: wy } = canvasToWorld(cx, cy);

    // Broadcast cursor position to collab peers
    if (CFG.collabEnabled && window.GodrawCollab) {
      window.GodrawCollab.sendCursorPosition(wx, wy);
    }

    // Track eraser cursor position for visual feedback
    if (activeTool === "eraser") {
      eraserCursorPos = { cx, cy };
      if (eraserActive) {
        const hit = scene.elements.find(el => hitTest(el, wx, wy));
        if (hit && !erasedIds.has(hit.id)) {
          erasedIds.add(hit.id);
          scene.elements = scene.elements.filter(el => el.id !== hit.id);
        }
      }
      render();
      return;
    }

    // Rotation handle cursor feedback
    if (activeTool === "select" && selectedIds.size === 1 && !isDragging && !isRotating) {
      const sel = scene.elements.find(e => selectedIds.has(e.id));
      if (sel) {
        const rh = getRotationHandlePos(sel);
        if (Math.hypot(wx - rh.x, wy - rh.y) < 8 / vp.scale) {
          canvas.style.cursor = "grab";
        } else {
          canvas.style.cursor = "default";
        }
      }
    }

    // Rotation dragging
    if (isRotating && selectedIds.size === 1) {
      const sel = scene.elements.find(e => selectedIds.has(e.id));
      if (sel) {
        const c = getCenter(sel);
        const currentAngle = Math.atan2(wy - c.y, wx - c.x);
        let newAngle = rotateOriginalAngle + (currentAngle - rotateStartAngle);
        // Snap to 15° when Shift held
        if (e.shiftKey) {
          newAngle = Math.round(newAngle / (Math.PI / 12)) * (Math.PI / 12);
        }
        sel.angle = newAngle;
      }
      render();
      return;
    }

    if (isDragging && selectedIds.size) {
      const dx = wx - startX, dy = wy - startY;
      for (const el of scene.elements) {
        if (!selectedIds.has(el.id)) continue;
        moveElement(el, dx, dy);
      }
      startX = wx; startY = wy;
      render();
      return;
    }

    // Marquee drag update
    if (marquee) {
      marquee.w = wx - marquee.x;
      marquee.h = wy - marquee.y;
      render();
      return;
    }

    if (!drawing) return;
    updateElement(currentEl, wx, wy);
    if (activeTool === "pencil") {
      pencilPoints.push({ x: wx, y: wy });
      currentEl.pts = [...pencilPoints];
    }
    render();
  }

  function onMouseUp(e) {
    if (panning) {
      panning = false;
      if (activeTool === "hand") canvas.style.cursor = "grab";
      else if (activeTool === "eraser") canvas.style.cursor = "none";
      else if (activeTool === "select") canvas.style.cursor = "default";
      else canvas.style.cursor = IS_EDIT ? "crosshair" : "grab";
      return;
    }
    if (eraserActive) { eraserActive = false; erasedIds = new Set(); return; }
    if (isRotating) { isRotating = false; canvas.style.cursor = "default"; return; }
    if (isDragging) { isDragging = false; snapshot(); return; }
    if (marquee) {
      // Select all elements intersecting the marquee rectangle
      const mx = Math.min(marquee.x, marquee.x + marquee.w);
      const my = Math.min(marquee.y, marquee.y + marquee.h);
      const mw = Math.abs(marquee.w);
      const mh = Math.abs(marquee.h);
      if (mw > 2 || mh > 2) {
        for (const el of scene.elements) {
          const bb = getBBox(el);
          // Element intersects marquee if bounding boxes overlap
          if (bb.x + bb.w >= mx && bb.x <= mx + mw && bb.y + bb.h >= my && bb.y <= my + mh) {
            selectedIds.add(el.id);
          }
        }
      }
      marquee = null;
      render();
      return;
    }
    if (!drawing) return;
    drawing = false;
    if (currentEl) {
      const bb = getBBox(currentEl);
      const tooSmall = bb.w < 3 && bb.h < 3 && currentEl.type !== "pencil" && currentEl.type !== "image";
      if (!tooSmall) {
        snapshot();
        scene.elements.push(currentEl);
        selectedIds = new Set([currentEl.id]);
      }
      currentEl = null;
    }
    render();
  }

  let spaceDown = false;
  function onKeyDown(e) {
    if (e.code === "Space" && !e.repeat) {
      spaceDown = true;
      canvas.style.cursor = "grab";
    }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "z") { e.preventDefault(); undo(); }
    if (mod && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
    if (mod && e.key === "s") { e.preventDefault(); saveDrawing(); }
    if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); }
    if (mod && e.key === "c") { e.preventDefault(); copySelected(); }
    if (mod && e.key === "v") { e.preventDefault(); pasteClipboard(); }
    if (mod && e.key === "x") { e.preventDefault(); cutSelected(); }
    if (mod && e.key === "a") { e.preventDefault(); selectAll(); }
    if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
    if (e.key === "h" || e.key === "H") setTool("hand");
    if (e.key === "v" || e.key === "V" || e.key === "1") setTool("select");
    if (e.key === "r" || e.key === "R" || e.key === "2") setTool("rect");
    if (e.key === "d" || e.key === "D") setTool("diamond");
    if (e.key === "e" || e.key === "E" || e.key === "3") setTool("ellipse");
    if (e.key === "l" || e.key === "L" || e.key === "4") setTool("line");
    if (e.key === "a" || e.key === "A" || e.key === "5") setTool("arrow");
    if (e.key === "p" || e.key === "P" || e.key === "6") setTool("pencil");
    if (e.key === "t" || e.key === "T" || e.key === "7") setTool("text");
    if (e.key === "x" || e.key === "X" || e.key === "8") setTool("eraser");
    if (e.key === "i" || e.key === "I" || e.key === "9") setTool("image");
    if (e.key === "0") setTool("select"); // 0 = quick back to select
    if (e.key === "Escape") { commitTextInput(); selectedIds.clear(); render(); }
    if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
  }

  window.addEventListener("keyup", e => {
    if (e.code === "Space") {
      spaceDown = false;
      if (activeTool === "hand") canvas.style.cursor = "grab";
      else if (activeTool === "eraser") canvas.style.cursor = "none";
      else if (activeTool === "select") canvas.style.cursor = "default";
      else canvas.style.cursor = IS_EDIT ? "crosshair" : "grab";
    }
  });

  function onViewKeyDown(e) {
    if (e.code === "Space" && !e.repeat) { spaceDown = true; canvas.style.cursor = "grab"; }
    if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
  }

  function onDblClick(e) {
    if (!IS_EDIT) return;
    e.preventDefault();
    const { cx, cy } = getMousePos(e);
    const { x: wx, y: wy } = canvasToWorld(cx, cy);
    const hit = [...scene.elements].reverse().find(el => hitTest(el, wx, wy));
    if (hit && hit.type === "text") {
      selectedIds = new Set([hit.id]);
      commitTextInput();
      startTextInputOnElement(hit);
    } else if (hit && (hit.type === "rect" || hit.type === "diamond" || hit.type === "ellipse")) {
      // Double-click on shape → edit label text inside
      selectedIds = new Set([hit.id]);
      commitTextInput();
      startTextInputOnShape(hit);
    } else if (!hit) {
      // Double-click on empty canvas creates text
      setTool("text");
      commitTextInput();
      startTextInput(wx, wy);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const { cx, cy } = getMousePos(e);
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.93;
    const newScale = Math.max(0.1, Math.min(10, vp.scale * zoomFactor));
    vp.x = cx - (cx - vp.x) * (newScale / vp.scale);
    vp.y = cy - (cy - vp.y) * (newScale / vp.scale);
    vp.scale = newScale;
    render();
  }

  // Touch (single finger = pan, pinch = zoom)
  let lastTouchDist = 0;
  let lastTouches = null;
  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      lastTouches = e.touches;
      panning = true;
      panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, vpx: vp.x, vpy: vp.y };
    } else if (e.touches.length === 2) {
      panning = false;
      lastTouchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }
  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && panning) {
      vp.x = panStart.vpx + (e.touches[0].clientX - panStart.x);
      vp.y = panStart.vpy + (e.touches[0].clientY - panStart.y);
      render();
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (lastTouchDist) {
        const factor = dist / lastTouchDist;
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = canvas.getBoundingClientRect();
        const px = cx - rect.left, py = cy - rect.top;
        const newScale = Math.max(0.1, Math.min(10, vp.scale * factor));
        vp.x = px - (px - vp.x) * (newScale / vp.scale);
        vp.y = py - (py - vp.y) * (newScale / vp.scale);
        vp.scale = newScale;
      }
      lastTouchDist = dist;
      render();
    }
  }
  function onTouchEnd(e) { panning = false; lastTouchDist = 0; }

  // ── Pan helpers ───────────────────────────────────────────────────────────
  function startPan(e) {
    panning = true;
    const { cx, cy } = getMousePos(e);
    panStart = { x: cx, y: cy, vpx: vp.x, vpy: vp.y };
    canvas.style.cursor = "grabbing";
  }

  // ── Tool helpers ──────────────────────────────────────────────────────────
  function setTool(t) {
    activeTool = t;
    toolbar.querySelectorAll(".tool-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === t);
    });
    commitTextInput();
    selectedIds.clear();
    if (t === "eraser") {
      canvas.style.cursor = "none";
      eraserCursorPos = null;
    } else if (t === "select") {
      canvas.style.cursor = "default";
    } else if (t === "hand") {
      canvas.style.cursor = "grab";
    } else {
      canvas.style.cursor = "crosshair";
    }
    render();
  }

  // ── Property sync ─────────────────────────────────────────────────────────
  function setProp(name, value) {
    // Always update the global default
    switch (name) {
      case "strokeColor": strokeColor = value; break;
      case "fillColor": fillColor = value; break;
      case "strokeWidth": strokeWidth = value; break;
      case "strokeStyle": strokeStyle = value; break;
      case "roughness": roughness = value; break;
      case "roundness": roundness = value; break;
      case "opacity": opacity = value; break;
      case "fontSize": fontSize = value; break;
      case "fontFamily": fontFamily = value; break;
      case "textAlign": textAlign = value; break;
    }
    // Apply to selected elements
    if (selectedIds.size) {
      snapshot();
      for (const el of scene.elements) {
        if (!selectedIds.has(el.id)) continue;
        el[name] = value;
      }
    }
    render();
  }

  function updateSidebar() {
    const sb = document.getElementById("sidebar");
    if (!sb) return;

    // Get values from selected element (single) or globals
    let sel = null;
    if (selectedIds.size === 1) {
      sel = scene.elements.find(e => selectedIds.has(e.id));
    }

    const sc = sel ? (sel.strokeColor || "#1e1e2e") : strokeColor;
    const fc = sel ? (sel.fillColor || "transparent") : fillColor;
    const sw = sel ? (sel.strokeWidth || 2) : strokeWidth;
    const ss = sel ? (sel.strokeStyle || "solid") : strokeStyle;
    const rg = sel ? (sel.roughness ?? 0) : roughness;
    const rn = sel ? (sel.roundness || "sharp") : roundness;
    const op = sel ? (sel.opacity ?? 100) : opacity;
    const fs = sel ? (sel.fontSize || 16) : fontSize;
    const ff = sel ? (sel.fontFamily || "sans-serif") : fontFamily;

    // Stroke swatches
    sb.querySelectorAll("#stroke-swatches .swatch").forEach(b => {
      b.classList.toggle("active", b.dataset.color === sc);
    });
    const scp = sb.querySelector("#stroke-color-picker");
    if (sc !== "transparent") scp.value = sc;

    // Fill swatches
    sb.querySelectorAll("#fill-swatches .swatch").forEach(b => {
      b.classList.toggle("active", b.dataset.color === fc);
    });
    const fcp = sb.querySelector("#fill-color-picker");
    if (fc && fc !== "transparent") fcp.value = fc;

    // Stroke width
    sb.querySelectorAll("#sw-btns .sb-btn").forEach(b => {
      b.classList.toggle("active", parseInt(b.dataset.val) === sw);
    });

    // Stroke style
    sb.querySelectorAll("#ss-btns .sb-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.val === ss);
    });

    // Roughness
    sb.querySelectorAll("#rg-btns .sb-btn").forEach(b => {
      b.classList.toggle("active", parseInt(b.dataset.val) === rg);
    });

    // Roundness
    sb.querySelectorAll("#rn-btns .sb-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.val === rn);
    });

    // Opacity
    sb.querySelector("#opacity-slider").value = op;
    sb.querySelector("#opacity-val").textContent = op;

    // Font section — visible for text tool, text elements, or any shape (for label text)
    const fontSec = document.getElementById("font-section");
    const showFont = activeTool === "text" || (sel && (sel.type === "text" || sel.type === "rect" || sel.type === "diamond" || sel.type === "ellipse" || sel.text));
    fontSec.style.display = showFont ? "" : "none";
    if (showFont) {
      const ta = sel ? (sel.textAlign || "center") : textAlign;
      sb.querySelectorAll("#ff-btns .sb-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.val === ff);
      });
      sb.querySelectorAll("#fs-btns .sb-btn").forEach(b => {
        b.classList.toggle("active", parseInt(b.dataset.val) === fs);
      });
      sb.querySelectorAll("#ta-btns .sb-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.val === ta);
      });
    }

    // Angle section — visible when an element is selected
    const angleSec = document.getElementById("angle-section");
    angleSec.style.display = sel ? "" : "none";
    if (sel) {
      const deg = Math.round((sel.angle || 0) * 180 / Math.PI);
      sb.querySelector("#angle-slider").value = deg;
      sb.querySelector("#angle-val").textContent = deg + "\u00B0";
    }

    // Hide irrelevant sections for eraser/image
    const isEraserNoSel = activeTool === "eraser" && !sel;
    const isImageTool = activeTool === "image" || (sel && sel.type === "image");
    const hideStrokeFill = isEraserNoSel || isImageTool;

    for (const id of ["stroke-swatches", "fill-swatches", "sw-btns", "ss-btns", "rg-btns", "rn-btns"]) {
      const section = sb.querySelector("#" + id);
      if (section) section.closest(".sb-section").style.display = hideStrokeFill ? "none" : "";
    }
  }

  // ── Layer operations ──────────────────────────────────────────────────────
  function layerAction(action) {
    if (selectedIds.size !== 1) return;
    const id = [...selectedIds][0];
    const idx = scene.elements.findIndex(e => e.id === id);
    if (idx === -1) return;
    snapshot();
    const [moved] = scene.elements.splice(idx, 1);
    switch (action) {
      case "to-back": scene.elements.unshift(moved); break;
      case "backward": scene.elements.splice(Math.max(0, idx - 1), 0, moved); break;
      case "forward": scene.elements.splice(Math.min(scene.elements.length, idx + 1), 0, moved); break;
      case "to-front": scene.elements.push(moved); break;
    }
    render();
  }

  // ── Duplicate ─────────────────────────────────────────────────────────────
  function duplicateSelected() {
    if (!selectedIds.size) return;
    snapshot();
    const newIds = new Set();
    for (const el of [...scene.elements]) {
      if (!selectedIds.has(el.id)) continue;
      const clone = JSON.parse(JSON.stringify(el));
      clone.id = uid();
      if (clone.pts) { clone.pts = clone.pts.map(p => ({ x: p.x + 10, y: p.y + 10 })); }
      else {
        if (clone.x !== undefined) { clone.x += 10; clone.y += 10; }
        if (clone.x2 !== undefined) { clone.x2 += 10; clone.y2 += 10; }
      }
      scene.elements.push(clone);
      newIds.add(clone.id);
    }
    selectedIds = newIds;
    render();
  }

  // ── Copy / Paste / Cut ──────────────────────────────────────────────────
  function copySelected() {
    if (!selectedIds.size) return;
    clipboardElements = scene.elements
      .filter(el => selectedIds.has(el.id))
      .map(el => JSON.parse(JSON.stringify(el)));
  }

  function pasteClipboard() {
    if (!clipboardElements.length) return;
    snapshot();
    const newIds = new Set();
    for (const el of clipboardElements) {
      const clone = JSON.parse(JSON.stringify(el));
      clone.id = uid();
      if (clone.x !== undefined) { clone.x += 20; clone.y += 20; }
      if (clone.x2 !== undefined) { clone.x2 += 20; clone.y2 += 20; }
      if (clone.pts) { clone.pts = clone.pts.map(p => ({ x: p.x + 20, y: p.y + 20 })); }
      scene.elements.push(clone);
      newIds.add(clone.id);
    }
    // Update clipboard to offset again on next paste
    clipboardElements = clipboardElements.map(el => {
      const c = JSON.parse(JSON.stringify(el));
      if (c.x !== undefined) { c.x += 20; c.y += 20; }
      if (c.x2 !== undefined) { c.x2 += 20; c.y2 += 20; }
      if (c.pts) { c.pts = c.pts.map(p => ({ x: p.x + 20, y: p.y + 20 })); }
      return c;
    });
    selectedIds = newIds;
    render();
  }

  function cutSelected() {
    copySelected();
    deleteSelected();
  }

  function selectAll() {
    selectedIds = new Set(scene.elements.map(el => el.id));
    render();
  }

  // ── Export PNG ──────────────────────────────────────────────────────────
  function exportPNG() {
    if (!scene.elements.length) return;
    const pad = 20;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of scene.elements) {
      const bb = getBBox(el);
      minX = Math.min(minX, bb.x);
      minY = Math.min(minY, bb.y);
      maxX = Math.max(maxX, bb.x + bb.w);
      maxY = Math.max(maxY, bb.y + bb.h);
    }
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const offCanvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    offCanvas.width = w * dpr;
    offCanvas.height = h * dpr;
    const offCtx = offCanvas.getContext("2d");
    offCtx.scale(dpr, dpr);
    // White background
    offCtx.fillStyle = darkMode ? "#1a1a2e" : "#ffffff";
    offCtx.fillRect(0, 0, w, h);
    offCtx.translate(-minX + pad, -minY + pad);
    for (const el of scene.elements) {
      drawElement(offCtx, el);
    }
    offCanvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (title || "drawing") + ".png";
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  // ── Export SVG ──────────────────────────────────────────────────────────
  function exportSVG() {
    if (!scene.elements.length) return;
    const pad = 20;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of scene.elements) {
      const bb = getBBox(el);
      minX = Math.min(minX, bb.x);
      minY = Math.min(minY, bb.y);
      maxX = Math.max(maxX, bb.x + bb.w);
      maxY = Math.max(maxY, bb.y + bb.h);
    }
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const ox = -minX + pad;
    const oy = -minY + pad;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n`;
    svg += `<rect width="${w}" height="${h}" fill="${darkMode ? '#1a1a2e' : '#ffffff'}"/>\n`;
    svg += `<g transform="translate(${ox},${oy})">\n`;

    for (const el of scene.elements) {
      const sc = el.strokeColor || "#1e1e2e";
      const fc = el.fillColor || "transparent";
      const sw = el.strokeWidth || 2;
      const op = (el.opacity ?? 100) / 100;
      const angle = el.angle || 0;
      const dashArray = el.strokeStyle === "dashed" ? `${sw*4},${sw*3}` : el.strokeStyle === "dotted" ? `${sw*0.5},${sw*2.5}` : "";
      const dash = dashArray ? ` stroke-dasharray="${dashArray}"` : "";
      const rot = angle ? (() => { const c = getCenter(el); return ` transform="rotate(${angle*180/Math.PI},${c.x},${c.y})"`; })() : "";

      switch (el.type) {
        case "rect": {
          const rn = el.roundness || "sharp";
          const r = rn === "round" ? Math.min(Math.abs(el.w), Math.abs(el.h)) * 0.15 : 0;
          svg += `  <rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${r}" fill="${fc}" stroke="${sc}" stroke-width="${sw}" opacity="${op}"${dash}${rot}/>\n`;
          if (el.text) {
            const bb = getBBox(el);
            svg += `  <text x="${bb.x+bb.w/2}" y="${bb.y+bb.h/2}" text-anchor="middle" dominant-baseline="central" font-size="${el.fontSize||16}" font-family="${fontCSS(el.fontFamily)}" fill="${sc}" opacity="${op}"${rot}>${escHtml(el.text)}</text>\n`;
          }
          break;
        }
        case "diamond": {
          const dcx = el.x + el.w/2, dcy = el.y + el.h/2;
          svg += `  <polygon points="${dcx},${el.y} ${el.x+el.w},${dcy} ${dcx},${el.y+el.h} ${el.x},${dcy}" fill="${fc}" stroke="${sc}" stroke-width="${sw}" opacity="${op}"${dash}${rot}/>\n`;
          if (el.text) {
            svg += `  <text x="${dcx}" y="${dcy}" text-anchor="middle" dominant-baseline="central" font-size="${el.fontSize||16}" font-family="${fontCSS(el.fontFamily)}" fill="${sc}" opacity="${op}"${rot}>${escHtml(el.text)}</text>\n`;
          }
          break;
        }
        case "ellipse": {
          const cx = el.x + el.w/2, cy = el.y + el.h/2;
          svg += `  <ellipse cx="${cx}" cy="${cy}" rx="${Math.abs(el.w/2)}" ry="${Math.abs(el.h/2)}" fill="${fc}" stroke="${sc}" stroke-width="${sw}" opacity="${op}"${dash}${rot}/>\n`;
          if (el.text) {
            svg += `  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${el.fontSize||16}" font-family="${fontCSS(el.fontFamily)}" fill="${sc}" opacity="${op}"${rot}>${escHtml(el.text)}</text>\n`;
          }
          break;
        }
        case "line":
          if (el.pts && el.pts.length > 1) {
            let d = `M${el.pts[0].x},${el.pts[0].y}`;
            for (let i = 1; i < el.pts.length; i++) d += ` L${el.pts[i].x},${el.pts[i].y}`;
            svg += `  <polyline points="${el.pts.map(p=>p.x+","+p.y).join(" ")}" fill="none" stroke="${sc}" stroke-width="${sw}" opacity="${op}"${dash}${rot}/>\n`;
          } else {
            svg += `  <line x1="${el.x}" y1="${el.y}" x2="${el.x2}" y2="${el.y2}" stroke="${sc}" stroke-width="${sw}" opacity="${op}"${dash}${rot}/>\n`;
          }
          break;
        case "arrow": {
          let endX, endY, prevX, prevY;
          if (el.pts && el.pts.length > 1) {
            let d = el.pts.map(p=>p.x+","+p.y).join(" ");
            svg += `  <polyline points="${d}" fill="none" stroke="${sc}" stroke-width="${sw}" opacity="${op}"${dash}${rot}/>\n`;
            endX = el.pts[el.pts.length-1].x; endY = el.pts[el.pts.length-1].y;
            prevX = el.pts[el.pts.length-2].x; prevY = el.pts[el.pts.length-2].y;
          } else {
            svg += `  <line x1="${el.x}" y1="${el.y}" x2="${el.x2}" y2="${el.y2}" stroke="${sc}" stroke-width="${sw}" opacity="${op}"${dash}${rot}/>\n`;
            endX = el.x2; endY = el.y2; prevX = el.x; prevY = el.y;
          }
          const dx = endX - prevX, dy = endY - prevY;
          const len = Math.hypot(dx, dy);
          const ux = len ? dx/len : 0, uy = len ? dy/len : 0;
          const headLen = Math.min(12, len * 0.3);
          const ax1 = endX - headLen * ux + headLen * 0.4 * uy;
          const ay1 = endY - headLen * uy - headLen * 0.4 * ux;
          const ax2 = endX - headLen * ux - headLen * 0.4 * uy;
          const ay2 = endY - headLen * uy + headLen * 0.4 * ux;
          svg += `  <polygon points="${endX},${endY} ${ax1},${ay1} ${ax2},${ay2}" fill="${sc}" opacity="${op}"${rot}/>\n`;
          break;
        }
        case "pencil":
          if (el.pts && el.pts.length > 1) {
            let d = `M${el.pts[0].x},${el.pts[0].y}`;
            for (let i = 1; i < el.pts.length; i++) d += ` L${el.pts[i].x},${el.pts[i].y}`;
            svg += `  <path d="${d}" fill="none" stroke="${sc}" stroke-width="${sw}" opacity="${op}" stroke-linecap="round" stroke-linejoin="round"${dash}${rot}/>\n`;
          }
          break;
        case "text": {
          const fs = el.fontSize || 16;
          const lines = (el.text || "").split("\n");
          const lh = fs * 1.3;
          lines.forEach((line, i) => {
            svg += `  <text x="${el.x}" y="${el.y + (i + 0.8) * lh}" font-size="${fs}" fill="${sc}" opacity="${op}" font-family="${fontCSS(el.fontFamily)}"${rot}>${escHtml(line)}</text>\n`;
          });
          break;
        }
        case "image":
          if (el.src) {
            svg += `  <image href="${el.src}" x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" opacity="${op}"${rot}/>\n`;
          }
          break;
      }
    }
    svg += `</g>\n</svg>`;

    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (title || "drawing") + ".svg";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Dark mode ──────────────────────────────────────────────────────────
  function toggleDarkMode() {
    darkMode = !darkMode;
    localStorage.setItem("godraw-dark", darkMode);
    applyDarkMode();
    render();
  }

  function applyDarkMode() {
    document.documentElement.classList.toggle("godraw-dark", darkMode);
    const btn = document.getElementById("btn-dark-mode");
    if (btn) btn.innerHTML = darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19';
  }

  // ── Copy link ─────────────────────────────────────────────────────────────
  function copyLink() {
    const url = window.location.origin + `${CFG.basePath}/${CFG.id}`;
    navigator.clipboard.writeText(url).then(() => {
      const status = document.getElementById("save-status");
      if (status) { status.textContent = "Link copied!"; setTimeout(() => status.textContent = "", 2000); }
    }).catch(() => {});
  }

  // ── Element creation ──────────────────────────────────────────────────────
  function makeElement(wx, wy) {
    const base = {
      id: uid(),
      type: activeTool,
      strokeColor,
      fillColor,
      strokeWidth,
      strokeStyle,
      roughness,
      roundness,
      opacity,
      angle: 0,
    };
    switch (activeTool) {
      case "rect":
      case "diamond":
      case "ellipse":
        return { ...base, x: wx, y: wy, w: 0, h: 0 };
      case "line":
      case "arrow":
        return { ...base, x: wx, y: wy, x2: wx, y2: wy };
      case "pencil":
        return { ...base, pts: [{ x: wx, y: wy }] };
      default:
        return null;
    }
  }

  function updateElement(el, wx, wy) {
    if (!el) return;
    switch (el.type) {
      case "rect":
      case "diamond":
      case "ellipse":
      case "image":
        el.w = wx - startX; el.h = wy - startY;
        break;
      case "line":
      case "arrow":
        el.x2 = wx; el.y2 = wy;
        break;
    }
  }

  function moveElement(el, dx, dy) {
    switch (el.type) {
      case "rect": case "diamond": case "ellipse": case "text": case "image":
        el.x += dx; el.y += dy; break;
      case "line": case "arrow":
        if (el.pts) { el.pts = el.pts.map(p => ({ x: p.x + dx, y: p.y + dy })); }
        else { el.x += dx; el.y += dy; el.x2 += dx; el.y2 += dy; }
        break;
      case "pencil":
        el.pts = el.pts.map(p => ({ x: p.x + dx, y: p.y + dy })); break;
    }
  }

  function deleteSelected() {
    if (!selectedIds.size) return;
    snapshot();
    scene.elements = scene.elements.filter(el => !selectedIds.has(el.id));
    selectedIds.clear();
    render();
  }

  // ── Text input overlay ────────────────────────────────────────────────────
  function startTextInput(wx, wy) {
    const sx = wx * vp.scale + vp.x;
    const sy = wy * vp.scale + vp.y;
    const wrap = canvas.parentElement;

    textInput = document.createElement("textarea");
    textInput.style.cssText = `
      position:absolute; left:${sx}px; top:${sy}px;
      min-width:80px; min-height:${fontSize * 1.4}px;
      font-size:${fontSize * vp.scale}px;
      font-family:${fontCSS(fontFamily)};
      color:${strokeColor}; background:transparent;
      border:1.5px dashed #3b82f6; outline:none; resize:none;
      padding:2px 4px; border-radius:3px;
      line-height:1.3; z-index:10;
    `;
    textInput.dataset.wx = wx;
    textInput.dataset.wy = wy;
    textInput.dataset.fs = fontSize;
    textInput.dataset.textFontFamily = fontFamily;
    wrap.appendChild(textInput);
    requestAnimationFrame(() => textInput && textInput.focus());

    textInput.addEventListener("keydown", e => {
      if (e.key === "Escape") { commitTextInput(); }
    });
    textInput.addEventListener("blur", () => commitTextInput());
    textInput.addEventListener("input", () => render());
  }

  function startTextInputOnElement(el) {
    // Edit existing text element — store original ID to update in place
    scene.elements = scene.elements.filter(e => e.id !== el.id);
    render();
    const sx = el.x * vp.scale + vp.x;
    const sy = el.y * vp.scale + vp.y;
    const wrap = canvas.parentElement;
    textInput = document.createElement("textarea");
    textInput.value = el.text || "";
    textInput.style.cssText = `
      position:absolute; left:${sx}px; top:${sy}px;
      min-width:80px; min-height:${(el.fontSize || 16) * 1.4}px;
      font-size:${(el.fontSize || 16) * vp.scale}px;
      font-family:${fontCSS(el.fontFamily)};
      color:${el.strokeColor || strokeColor}; background:transparent;
      border:1.5px dashed #3b82f6; outline:none; resize:none;
      padding:2px 4px; border-radius:3px; line-height:1.3; z-index:10;
    `;
    textInput.dataset.wx = el.x;
    textInput.dataset.wy = el.y;
    textInput.dataset.fs = el.fontSize || fontSize;
    textInput.dataset.textElementId = el.id;
    textInput.dataset.textStrokeColor = el.strokeColor || strokeColor;
    textInput.dataset.textOpacity = el.opacity != null ? el.opacity : opacity;
    textInput.dataset.textFontFamily = el.fontFamily || fontFamily;
    wrap.appendChild(textInput);
    requestAnimationFrame(() => textInput && textInput.focus());
    textInput.addEventListener("keydown", e => { if (e.key === "Escape") commitTextInput(); });
    textInput.addEventListener("blur", () => commitTextInput());
  }

  function startTextInputOnShape(el) {
    // Edit text label inside a shape (rect, ellipse, etc.)
    // Hide the shape's text while editing to avoid double rendering
    el._savedText = el.text || "";
    el.text = "";
    render();
    const bb = getBBox(el);
    const cx = (bb.x + bb.w / 2) * vp.scale + vp.x;
    const cy = (bb.y + bb.h / 2) * vp.scale + vp.y;
    const wrap = canvas.parentElement;
    const fs = el.fontSize || fontSize;
    textInput = document.createElement("textarea");
    textInput.value = el._savedText;
    textInput.style.cssText = `
      position:absolute; left:${cx}px; top:${cy}px;
      transform:translate(-50%, -50%);
      min-width:60px; min-height:${fs * 1.4}px;
      max-width:${Math.max(80, Math.abs(bb.w) * vp.scale - 16)}px;
      font-size:${fs * vp.scale}px;
      font-family:${fontCSS(el.fontFamily)};
      color:${el.strokeColor || strokeColor}; background:transparent;
      border:1.5px dashed #3b82f6; outline:none; resize:none;
      padding:2px 4px; border-radius:3px; line-height:1.3;
      text-align:center; z-index:10;
    `;
    textInput.dataset.wx = bb.x + bb.w / 2;
    textInput.dataset.wy = bb.y + bb.h / 2;
    textInput.dataset.fs = fs;
    textInput.dataset.shapeId = el.id;
    wrap.appendChild(textInput);
    requestAnimationFrame(() => textInput && textInput.focus());
    textInput.addEventListener("keydown", e => { if (e.key === "Escape") commitTextInput(); });
    textInput.addEventListener("blur", () => commitTextInput());
  }

  function commitTextInput() {
    if (!textInput) return;
    const ti = textInput;
    textInput = null;  // null FIRST — prevents re-entrance via synchronous blur
    const text = ti.value.trim();
    const wx = parseFloat(ti.dataset.wx);
    const wy = parseFloat(ti.dataset.wy);
    const fs = parseInt(ti.dataset.fs);
    const shapeId = ti.dataset.shapeId || "";
    ti.remove();

    // Shape label editing — update the shape's text property
    if (shapeId) {
      const shape = scene.elements.find(e => e.id === shapeId);
      if (shape) {
        snapshot();
        shape.text = text;
        shape.fontSize = fs;
        shape.fontFamily = shape.fontFamily || fontFamily;
        delete shape._savedText;
      }
      render();
      return;
    }

    // Standalone text — discard if empty
    if (!text) { render(); return; }
    snapshot();
    // Measure width (rough)
    const ff = ti.dataset.textFontFamily || fontFamily;
    ctx.font = `${fs}px ${fontCSS(ff)}`;
    const lines = text.split("\n");
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    // Reuse original ID when editing existing text element
    const existingId = ti.dataset.textElementId || "";
    scene.elements.push({
      id: existingId || uid(), type: "text",
      x: wx, y: wy,
      w: maxW, h: lines.length * fs * 1.3,
      text, fontSize: fs, fontFamily: ff, textAlign,
      strokeColor: existingId ? (ti.dataset.textStrokeColor || strokeColor) : strokeColor,
      opacity: existingId ? parseFloat(ti.dataset.textOpacity) : opacity,
    });
    render();
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function saveDrawing() {
    const status = document.getElementById("save-status");
    if (status) status.textContent = "Saving\u2026";
    try {
      if (CFG.storage === "local") {
        localStorage.setItem("godraw-local-scene", JSON.stringify({ title, scene }));
      } else {
        const res = await fetch(`${CFG.basePath}/${CFG.id}/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, scene }),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      if (status) { status.textContent = "Saved \u2713"; setTimeout(() => { status.textContent = ""; }, 2000); }
    } catch (err) {
      if (status) status.textContent = "Error: " + err.message;
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  async function loadDrawing() {
    try {
      var data;
      if (CFG.storage === "local") {
        var raw = localStorage.getItem("godraw-local-scene");
        data = raw ? JSON.parse(raw) : { title: "Untitled", scene: { version: 1, elements: [] } };
      } else {
        const res = await fetch(`${CFG.basePath}/${CFG.id}/data`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        data = await res.json();
      }
      title = data.title || "Untitled";
      scene = typeof data.scene === "string" ? JSON.parse(data.scene) : (data.scene || { version: 1, elements: [] });
      if (IS_EDIT) {
        const ti = document.getElementById("title-input");
        if (ti) ti.value = title;
      }
      render();
    } catch (err) {
      console.error("go-draw: failed to load drawing", err);
    }
  }

  // ── Zoom to fit ────────────────────────────────────────────────────────────
  function zoomToFit() {
    if (!scene.elements.length) {
      vp.x = canvas.width / 2;
      vp.y = canvas.height / 2;
      vp.scale = 1;
      return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < scene.elements.length; i++) {
      var bb = getBBox(scene.elements[i]);
      if (bb.x < minX) minX = bb.x;
      if (bb.y < minY) minY = bb.y;
      if (bb.x + bb.w > maxX) maxX = bb.x + bb.w;
      if (bb.y + bb.h > maxY) maxY = bb.y + bb.h;
    }
    var contentW = maxX - minX;
    var contentH = maxY - minY;
    if (contentW < 1) contentW = 1;
    if (contentH < 1) contentH = 1;
    var pad = 40;
    var scaleX = (canvas.width - pad * 2) / contentW;
    var scaleY = (canvas.height - pad * 2) / contentH;
    vp.scale = Math.min(scaleX, scaleY, 2);
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    vp.x = canvas.width / 2 - cx * vp.scale;
    vp.y = canvas.height / 2 - cy * vp.scale;
  }

  // Center on content at a given scale
  function centerOnContent(scale) {
    vp.scale = scale;
    if (scene.elements.length) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < scene.elements.length; i++) {
        var bb = getBBox(scene.elements[i]);
        if (bb.x < minX) minX = bb.x;
        if (bb.y < minY) minY = bb.y;
        if (bb.x + bb.w > maxX) maxX = bb.x + bb.w;
        if (bb.y + bb.h > maxY) maxY = bb.y + bb.h;
      }
      var cx = (minX + maxX) / 2;
      var cy = (minY + maxY) / 2;
      vp.x = canvas.width / 2 - cx * vp.scale;
      vp.y = canvas.height / 2 - cy * vp.scale;
    }
  }

  // Parse zoom query param: "fit", "1.5", "150%", "50%" etc.
  function getZoomParam() {
    try {
      var params = new URLSearchParams(window.location.search);
      var z = params.get("zoom");
      if (!z) return null;
      if (z === "fit") return "fit";
      if (z.endsWith("%")) z = z.slice(0, -1);
      var n = parseFloat(z);
      if (!isNaN(n) && n > 0) {
        return n > 10 ? n / 100 : n;
      }
      return null;
    } catch (_) { return null; }
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────
  function openModal(html) {
    const overlay = document.createElement("div");
    overlay.className = "godraw-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "godraw-modal";
    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(overlay); });
    return { overlay, modal };
  }

  function closeModal(overlay) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // ── Share dialog ───────────────────────────────────────────────────────
  function openShareDialog() {
    const origin = window.location.origin;
    const viewUrl = `${origin}${CFG.basePath}/${CFG.id}`;
    const editUrl = `${origin}${CFG.basePath}/${CFG.id}/edit`;
    const collabUrl = editUrl + (window.location.hash || "");
    const embedCode = `<iframe src="${viewUrl}" width="100%" height="500" style="border:none;border-radius:8px;" loading="lazy" allowfullscreen></iframe>`;

    const { overlay, modal } = openModal(`
      <h3>Share Drawing</h3>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:.75rem;color:#888;display:block;margin-bottom:4px;">View-only link</label>
          <div style="display:flex;gap:6px;">
            <input type="text" id="share-view-url" value="${escHtml(viewUrl)}" readonly
              style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:.85rem;background:#f8f8f8;" />
            <button class="modal-btn modal-btn-primary share-copy-btn" data-target="share-view-url">Copy</button>
          </div>
        </div>
        ${CFG.collabEnabled ? `
        <div>
          <label style="font-size:.75rem;color:#888;display:block;margin-bottom:4px;">Collaborate link (with encryption key)</label>
          <div style="display:flex;gap:6px;">
            <input type="text" id="share-collab-url" value="${escHtml(collabUrl)}" readonly
              style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:.85rem;background:#f8f8f8;" />
            <button class="modal-btn modal-btn-primary share-copy-btn" data-target="share-collab-url">Copy</button>
          </div>
        </div>` : ""}
        <div>
          <label style="font-size:.75rem;color:#888;display:block;margin-bottom:4px;">Embed code</label>
          <div style="display:flex;gap:6px;">
            <input type="text" id="share-embed-code" value="${escHtml(embedCode)}" readonly
              style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:.85rem;background:#f8f8f8;font-family:monospace;" />
            <button class="modal-btn modal-btn-primary share-copy-btn" data-target="share-embed-code">Copy</button>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-secondary" id="share-close">Close</button>
      </div>
    `);

    modal.querySelector("#share-close").addEventListener("click", () => closeModal(overlay));
    modal.querySelectorAll(".share-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const input = modal.querySelector("#" + btn.dataset.target);
        if (input) {
          navigator.clipboard.writeText(input.value).then(() => {
            btn.textContent = "Copied!";
            setTimeout(() => btn.textContent = "Copy", 1500);
          }).catch(() => {});
        }
      });
    });
  }

  // ── Mermaid → Draw (Import) ──────────────────────────────────────────────
  function openMermaidImport() {
    const { overlay, modal } = openModal(`
      <h3>Mermaid \u2192 Draw</h3>
      <textarea id="mermaid-input" placeholder="Paste Mermaid syntax here\u2026\ngraph TD\n  A[Start] --> B{Check}\n  B -->|Yes| C[Done]"></textarea>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-secondary" id="mermaid-cancel">Cancel</button>
        <button class="modal-btn modal-btn-primary" id="mermaid-go">Import</button>
      </div>
    `);
    modal.querySelector("#mermaid-cancel").addEventListener("click", () => closeModal(overlay));
    modal.querySelector("#mermaid-go").addEventListener("click", () => {
      const src = modal.querySelector("#mermaid-input").value.trim();
      if (!src) return;
      const elems = parseMermaid(src);
      if (elems.length) {
        snapshot();
        scene.elements.push(...elems);
        zoomToFit();
        render();
      }
      closeModal(overlay);
    });
    modal.querySelector("#mermaid-input").focus();
  }

  function parseMermaid(src) {
    const lines = src.split("\n").map(l => l.trim()).filter(l => l);
    if (!lines.length) return [];
    const first = lines[0].toLowerCase();
    if (first.startsWith("graph")) {
      const dir = first.includes("lr") ? "LR" : "TD";
      return parseMermaidFlowchart(lines.slice(1), dir);
    }
    if (first.startsWith("sequencediagram")) {
      return parseMermaidSequence(lines.slice(1));
    }
    // Try flowchart by default
    return parseMermaidFlowchart(lines, "TD");
  }

  function parseMermaidFlowchart(lines, dir) {
    const NODE_W = 120, NODE_H = 50, HGAP = 40, VGAP = 60;
    const nodes = new Map(); // id → { label, shape }
    const edges = [];
    const nodeColors = ["#a5d8ff", "#b2f2bb", "#ffec99", "#ffc9c9", "#d0bfff"];
    let colorIdx = 0;

    // Parse node def: A[label], A(label), A{label}, A((label))
    function ensureNode(raw) {
      let id = raw, label = raw, shape = "rect";
      const m1 = raw.match(/^(\w+)\[([^\]]*)\]$/);
      const m2 = raw.match(/^(\w+)\(([^)]*)\)$/);
      const m3 = raw.match(/^(\w+)\{([^}]*)\}$/);
      const m4 = raw.match(/^(\w+)\(\(([^)]*)\)\)$/);
      if (m4) { id = m4[1]; label = m4[2]; shape = "ellipse"; }
      else if (m1) { id = m1[1]; label = m1[2]; shape = "rect"; }
      else if (m2) { id = m2[1]; label = m2[2]; shape = "rect"; }
      else if (m3) { id = m3[1]; label = m3[2]; shape = "rect"; }
      if (!nodes.has(id)) {
        nodes.set(id, { id, label, shape, color: nodeColors[colorIdx++ % nodeColors.length] });
      }
      return id;
    }

    // Join all lines and split by semicolons too
    const combined = lines.join("\n").replace(/;/g, "\n").split("\n").map(l => l.trim()).filter(l => l);

    for (const line of combined) {
      // Edge patterns: A -->|label| B, A --> B, A --- B, A -.-> B
      const edgeMatch = line.match(/^(\S+)\s*(-->|---|-\.->)\s*(?:\|([^|]*)\|\s*)?(\S+)$/);
      if (edgeMatch) {
        const fromId = ensureNode(edgeMatch[1]);
        const toId = ensureNode(edgeMatch[4]);
        const edgeLabel = edgeMatch[3] || "";
        const edgeType = edgeMatch[2] === "---" ? "line" : "arrow";
        edges.push({ from: fromId, to: toId, label: edgeLabel, type: edgeType });
        continue;
      }
      // Standalone node def
      if (line.match(/^\w+[\[({]/)) {
        ensureNode(line);
      }
    }

    if (!nodes.size) return [];

    // BFS to assign depth levels
    const adj = new Map();
    for (const [id] of nodes) adj.set(id, []);
    for (const e of edges) {
      if (adj.has(e.from)) adj.get(e.from).push(e.to);
    }

    const levels = new Map();
    const roots = [...nodes.keys()].filter(id => !edges.some(e => e.to === id));
    if (!roots.length) roots.push(nodes.keys().next().value);
    const queue = roots.map(id => ({ id, level: 0 }));
    const visited = new Set();
    while (queue.length) {
      const { id, level } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      levels.set(id, level);
      for (const next of (adj.get(id) || [])) {
        if (!visited.has(next)) queue.push({ id: next, level: level + 1 });
      }
    }
    // Assign unvisited nodes
    for (const [id] of nodes) {
      if (!levels.has(id)) levels.set(id, 0);
    }

    // Group by level
    const byLevel = new Map();
    for (const [id, lvl] of levels) {
      if (!byLevel.has(lvl)) byLevel.set(lvl, []);
      byLevel.get(lvl).push(id);
    }

    // Position nodes
    const positions = new Map();
    const maxLevel = Math.max(...byLevel.keys());
    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const ids = byLevel.get(lvl) || [];
      ids.forEach((id, i) => {
        let x, y;
        if (dir === "LR") {
          x = lvl * (NODE_W + HGAP);
          y = i * (NODE_H + VGAP) - ((ids.length - 1) * (NODE_H + VGAP)) / 2;
        } else {
          x = i * (NODE_W + HGAP) - ((ids.length - 1) * (NODE_W + HGAP)) / 2;
          y = lvl * (NODE_H + VGAP);
        }
        positions.set(id, { x, y });
      });
    }

    // Generate elements
    const elems = [];
    for (const [id, node] of nodes) {
      const pos = positions.get(id);
      const base = {
        id: uid(), strokeColor: "#1e1e2e", fillColor: node.color,
        strokeWidth: 2, strokeStyle: "solid", roughness: 0, roundness: "round", opacity: 100,
      };
      if (node.shape === "ellipse") {
        elems.push({ ...base, type: "ellipse", x: pos.x, y: pos.y, w: NODE_W, h: NODE_H });
      } else {
        elems.push({ ...base, type: "rect", x: pos.x, y: pos.y, w: NODE_W, h: NODE_H });
      }
      // Label
      elems.push({
        id: uid(), type: "text", x: pos.x + NODE_W / 2 - node.label.length * 4,
        y: pos.y + NODE_H / 2 - 8, w: node.label.length * 8, h: 16,
        text: node.label, fontSize: 14, strokeColor: "#1e1e2e", opacity: 100,
      });
    }

    // Edges
    for (const edge of edges) {
      const fp = positions.get(edge.from), tp = positions.get(edge.to);
      if (!fp || !tp) continue;
      const fx = fp.x + NODE_W / 2, fy = fp.y + NODE_H / 2;
      const tx = tp.x + NODE_W / 2, ty = tp.y + NODE_H / 2;
      // Clip to node boundary
      const angle = Math.atan2(ty - fy, tx - fx);
      const sx = fx + Math.cos(angle) * NODE_W / 2;
      const sy = fy + Math.sin(angle) * NODE_H / 2;
      const ex = tx - Math.cos(angle) * NODE_W / 2;
      const ey = ty - Math.sin(angle) * NODE_H / 2;

      elems.push({
        id: uid(), type: edge.type, x: sx, y: sy, x2: ex, y2: ey,
        strokeColor: "#1e1e2e", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100,
      });
      if (edge.label) {
        elems.push({
          id: uid(), type: "text", x: (sx + ex) / 2 - edge.label.length * 3, y: (sy + ey) / 2 - 16,
          w: edge.label.length * 8, h: 14, text: edge.label, fontSize: 12,
          strokeColor: "#888", opacity: 100,
        });
      }
    }

    return elems;
  }

  function parseMermaidSequence(lines) {
    const PART_W = 100, PART_H = 40, HGAP = 60, MSG_VGAP = 55;
    const participants = [];
    const partMap = new Map();
    const messages = [];

    for (const line of lines) {
      const pMatch = line.match(/^participant\s+(\w+)(?:\s+as\s+(.+))?$/i);
      if (pMatch) {
        const id = pMatch[1], name = pMatch[2] || pMatch[1];
        if (!partMap.has(id)) {
          partMap.set(id, { id, name, idx: participants.length });
          participants.push({ id, name });
        }
        continue;
      }
      const mMatch = line.match(/^(\w+)\s*(->>|-->>|->|-->)\s*(\w+)\s*:\s*(.+)$/);
      if (mMatch) {
        const from = mMatch[1], to = mMatch[3], msg = mMatch[4].trim();
        // Auto-create participants
        if (!partMap.has(from)) { partMap.set(from, { id: from, name: from, idx: participants.length }); participants.push({ id: from, name: from }); }
        if (!partMap.has(to)) { partMap.set(to, { id: to, name: to, idx: participants.length }); participants.push({ id: to, name: to }); }
        const dashed = mMatch[2].includes("--");
        messages.push({ from, to, msg, dashed });
      }
    }

    if (!participants.length) return [];

    const elems = [];
    const lifelineHeight = (messages.length + 1) * MSG_VGAP + 40;

    // Participant boxes
    participants.forEach((p, i) => {
      const x = i * (PART_W + HGAP);
      const y = 0;
      elems.push({
        id: uid(), type: "rect", x, y, w: PART_W, h: PART_H,
        strokeColor: "#1e1e2e", fillColor: "#ffec99", strokeWidth: 2,
        strokeStyle: "solid", roughness: 0, roundness: "round", opacity: 100,
      });
      elems.push({
        id: uid(), type: "text", x: x + PART_W / 2 - p.name.length * 4, y: y + 12,
        w: p.name.length * 8, h: 16, text: p.name, fontSize: 14,
        strokeColor: "#1e1e2e", opacity: 100,
      });
      // Lifeline (dashed vertical line)
      elems.push({
        id: uid(), type: "line",
        x: x + PART_W / 2, y: PART_H,
        x2: x + PART_W / 2, y2: PART_H + lifelineHeight,
        strokeColor: "#aaa", strokeWidth: 1, strokeStyle: "dashed", roughness: 0, opacity: 100,
      });
    });

    // Messages
    messages.forEach((m, i) => {
      const fromIdx = partMap.get(m.from).idx;
      const toIdx = partMap.get(m.to).idx;
      const y = PART_H + 30 + i * MSG_VGAP;
      const x1 = fromIdx * (PART_W + HGAP) + PART_W / 2;
      const x2 = toIdx * (PART_W + HGAP) + PART_W / 2;
      elems.push({
        id: uid(), type: "arrow", x: x1, y, x2, y2: y,
        strokeColor: "#1e1e2e", strokeWidth: 1.5,
        strokeStyle: m.dashed ? "dashed" : "solid", roughness: 0, opacity: 100,
      });
      const midX = (x1 + x2) / 2;
      elems.push({
        id: uid(), type: "text", x: midX - m.msg.length * 3, y: y - 18,
        w: m.msg.length * 7, h: 14, text: m.msg, fontSize: 12,
        strokeColor: "#555", opacity: 100,
      });
    });

    return elems;
  }

  // ── Draw → Mermaid (Export) ──────────────────────────────────────────────
  function openMermaidExport() {
    const mermaidSrc = generateMermaid();
    const { overlay, modal } = openModal(`
      <h3>Draw \u2192 Mermaid</h3>
      <textarea id="mermaid-output" readonly>${escHtml(mermaidSrc)}</textarea>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-secondary" id="mermaid-close">Close</button>
        <button class="modal-btn modal-btn-primary" id="mermaid-copy">Copy</button>
      </div>
    `);
    modal.querySelector("#mermaid-close").addEventListener("click", () => closeModal(overlay));
    modal.querySelector("#mermaid-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(mermaidSrc).then(() => {
        modal.querySelector("#mermaid-copy").textContent = "Copied!";
        setTimeout(() => modal.querySelector("#mermaid-copy").textContent = "Copy", 1500);
      });
    });
  }

  function generateMermaid() {
    const nodeEls = scene.elements.filter(e => e.type === "rect" || e.type === "diamond" || e.type === "ellipse");
    const edgeEls = scene.elements.filter(e => e.type === "arrow" || e.type === "line");
    const textEls = scene.elements.filter(e => e.type === "text");

    if (!nodeEls.length) return "graph TD\n  %% No shapes found";

    // Assign IDs: A, B, C...Z, A1, B1...
    function mermaidId(i) {
      const letter = String.fromCharCode(65 + (i % 26));
      const suffix = i >= 26 ? Math.floor(i / 26) : "";
      return letter + suffix;
    }

    const nodeMap = new Map();
    nodeEls.forEach((n, i) => {
      const mid = mermaidId(i);
      // Find overlapping text
      const bb = getBBox(n);
      const label = textEls.find(t => {
        const tb = getBBox(t);
        return tb.x >= bb.x - 20 && tb.x <= bb.x + bb.w + 20 &&
               tb.y >= bb.y - 20 && tb.y <= bb.y + bb.h + 20;
      });
      nodeMap.set(n.id, { mid, label: label ? label.text : mid, type: n.type });
    });

    let out = "graph TD\n";

    // Node declarations
    for (const [, node] of nodeMap) {
      if (node.type === "ellipse") {
        out += `  ${node.mid}((${node.label}))\n`;
      } else {
        out += `  ${node.mid}[${node.label}]\n`;
      }
    }

    // Edges: find closest node to start/end
    const TOL = 200;
    for (const edge of edgeEls) {
      let fromNode = null, toNode = null;
      let minFrom = TOL, minTo = TOL;
      for (const [nid, info] of nodeMap) {
        const n = nodeEls.find(e => e.id === nid);
        if (!n) continue;
        const bb = getBBox(n);
        const ncx = bb.x + bb.w / 2, ncy = bb.y + bb.h / 2;
        const dFrom = Math.hypot(edge.x - ncx, edge.y - ncy);
        const dTo = Math.hypot(edge.x2 - ncx, edge.y2 - ncy);
        if (dFrom < minFrom) { minFrom = dFrom; fromNode = info; }
        if (dTo < minTo) { minTo = dTo; toNode = info; }
      }
      if (fromNode && toNode && fromNode !== toNode) {
        const arrow = edge.type === "arrow" ? "-->" : "---";
        out += `  ${fromNode.mid} ${arrow} ${toNode.mid}\n`;
      }
    }

    return out;
  }

  // ── Collaboration hooks (standalone-app only) ───────────────────────────
  // Expose getters for collab.js
  window._godrawGetViewport = () => ({ x: vp.x, y: vp.y, scale: vp.scale });
  window._godrawGetScene = () => JSON.parse(JSON.stringify(scene));

  // Receive handler for incoming collab updates
  window._godrawCollabReceive = (type, payload) => {
    switch (type) {
      case "element_update":
        if (payload.elements) {
          for (const incoming of payload.elements) {
            const idx = scene.elements.findIndex(e => e.id === incoming.id);
            if (idx >= 0) {
              scene.elements[idx] = incoming;
            } else {
              scene.elements.push(incoming);
            }
          }
          render();
        }
        break;
      case "scene_sync":
        // Full scene sync from another peer — only apply if our scene is empty
        if (payload.elements && scene.elements.length === 0) {
          scene = payload;
          render();
        }
        break;
    }
  };


  // ── Excalidraw conversion ─────────────────────────────────────────────────
  const EX_FONT_TO_GODRAW = { 1: "hand", 2: "sans-serif", 3: "mono", 4: "serif" };
  const GODRAW_FONT_TO_EX = { "hand": 1, "sans-serif": 2, "mono": 3, "serif": 4 };

  function convertExcalidrawElement(exEl, files) {
    if (exEl.isDeleted) return null;
    const base = {
      id: uid(),
      strokeColor: exEl.strokeColor || "#1e1e2e",
      fillColor: exEl.backgroundColor || "transparent",
      strokeWidth: exEl.strokeWidth || 2,
      strokeStyle: exEl.strokeStyle || "solid",
      roughness: exEl.roughness ?? 0,
      roundness: exEl.roundness ? "round" : "sharp",
      opacity: exEl.opacity ?? 100,
      angle: exEl.angle || 0,
    };

    switch (exEl.type) {
      case "rectangle":
        return { ...base, type: "rect", x: exEl.x, y: exEl.y, w: exEl.width, h: exEl.height };
      case "diamond":
        return { ...base, type: "diamond", x: exEl.x, y: exEl.y, w: exEl.width, h: exEl.height };
      case "ellipse":
        return { ...base, type: "ellipse", x: exEl.x, y: exEl.y, w: exEl.width, h: exEl.height };
      case "text":
        return {
          ...base, type: "text", x: exEl.x, y: exEl.y,
          w: exEl.width || 100, h: exEl.height || 24,
          text: exEl.text || exEl.originalText || "",
          fontSize: exEl.fontSize || 16,
          fontFamily: EX_FONT_TO_GODRAW[exEl.fontFamily] || "sans-serif",
          textAlign: exEl.textAlign || "left",
        };
      case "line":
      case "arrow": {
        const pts = exEl.points || [];
        if (pts.length < 2) return null;
        const absPts = pts.map(p => ({ x: exEl.x + p[0], y: exEl.y + p[1] }));
        if (pts.length === 2) {
          return {
            ...base, type: exEl.type === "arrow" ? "arrow" : "line",
            x: absPts[0].x, y: absPts[0].y, x2: absPts[1].x, y2: absPts[1].y,
          };
        }
        return { ...base, type: exEl.type === "arrow" ? "arrow" : "line", pts: absPts };
      }
      case "freedraw": {
        const pts = exEl.points || [];
        if (pts.length < 2) return null;
        return {
          ...base, type: "pencil",
          pts: pts.map(p => ({ x: exEl.x + p[0], y: exEl.y + p[1] })),
        };
      }
      case "image": {
        const el = { ...base, type: "image", x: exEl.x, y: exEl.y, w: exEl.width || 200, h: exEl.height || 150 };
        if (exEl.fileId && files && files[exEl.fileId]) {
          const f = files[exEl.fileId];
          el.src = f.dataURL || (`data:${f.mimeType};base64,${f.data}`);
        }
        return el;
      }
      default:
        return null;
    }
  }

  function convertExcalidrawScene(exData) {
    const exElements = exData.elements || [];
    const files = exData.files || {};
    const converted = [];
    const boundTextMap = new Map(); // containerId → text element

    // First pass: identify bound text elements
    for (const exEl of exElements) {
      if (exEl.type === "text" && exEl.containerId) {
        boundTextMap.set(exEl.containerId, exEl);
      }
    }

    // Second pass: convert elements
    for (const exEl of exElements) {
      if (exEl.isDeleted) continue;
      // Skip standalone bound text — will be merged into container
      if (exEl.type === "text" && exEl.containerId) continue;

      const el = convertExcalidrawElement(exEl, files);
      if (!el) continue;

      // Merge bound text into container
      const boundText = boundTextMap.get(exEl.id);
      if (boundText) {
        el.text = boundText.text || boundText.originalText || "";
        el.fontSize = boundText.fontSize || 16;
        el.fontFamily = EX_FONT_TO_GODRAW[boundText.fontFamily] || "sans-serif";
      }

      converted.push(el);
    }

    return converted;
  }

  function convertToExcalidrawElement(el) {
    const base = {
      id: el.id || uid(),
      type: "rectangle",
      x: el.x || 0,
      y: el.y || 0,
      width: 0,
      height: 0,
      angle: el.angle || 0,
      strokeColor: el.strokeColor || "#1e1e2e",
      backgroundColor: el.fillColor || "transparent",
      fillStyle: "solid",
      strokeWidth: el.strokeWidth || 2,
      strokeStyle: el.strokeStyle || "solid",
      roughness: el.roughness ?? 0,
      opacity: el.opacity ?? 100,
      groupIds: [],
      roundness: el.roundness === "round" ? { type: 3 } : null,
      seed: Math.floor(Math.random() * 2147483647),
      version: 1,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
    };

    switch (el.type) {
      case "rect":
        return { ...base, type: "rectangle", width: el.w || 0, height: el.h || 0 };
      case "diamond":
        return { ...base, type: "diamond", width: el.w || 0, height: el.h || 0 };
      case "ellipse":
        return { ...base, type: "ellipse", width: el.w || 0, height: el.h || 0 };
      case "text":
        return {
          ...base, type: "text",
          width: el.w || 100, height: el.h || 24,
          text: el.text || "", originalText: el.text || "",
          fontSize: el.fontSize || 16,
          fontFamily: GODRAW_FONT_TO_EX[el.fontFamily] || 2,
          textAlign: el.textAlign || "left",
          verticalAlign: "top",
          baseline: (el.fontSize || 16),
          lineHeight: 1.25,
        };
      case "line":
      case "arrow": {
        let points;
        if (el.pts && el.pts.length > 1) {
          const ox = el.pts[0].x, oy = el.pts[0].y;
          points = el.pts.map(p => [p.x - ox, p.y - oy]);
          base.x = ox; base.y = oy;
        } else {
          points = [[0, 0], [(el.x2 || 0) - (el.x || 0), (el.y2 || 0) - (el.y || 0)]];
        }
        return {
          ...base, type: el.type === "arrow" ? "arrow" : "line",
          width: 0, height: 0, points,
          lastCommittedPoint: null, startBinding: null, endBinding: null,
          startArrowhead: null,
          endArrowhead: el.type === "arrow" ? "arrow" : null,
        };
      }
      case "pencil": {
        const pts = el.pts || [];
        if (pts.length < 2) return null;
        const ox = pts[0].x, oy = pts[0].y;
        return {
          ...base, type: "freedraw",
          x: ox, y: oy,
          width: 0, height: 0,
          points: pts.map(p => [p.x - ox, p.y - oy]),
          pressures: pts.map(() => 0.5),
          simulatePressure: true,
          lastCommittedPoint: null,
        };
      }
      case "image":
        return {
          ...base, type: "image",
          width: el.w || 200, height: el.h || 150,
          status: "saved",
        };
      default:
        return null;
    }
  }

  function exportExcalidraw() {
    const elements = scene.elements.map(convertToExcalidrawElement).filter(Boolean);
    const data = {
      type: "excalidraw",
      version: 2,
      source: "go-draw",
      elements,
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (title || "drawing") + ".excalidraw";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Excalidraw import UI ────────────────────────────────────────────────
  function importExcalidrawFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".excalidraw,.json";
    input.onchange = () => {
      if (!input.files || !input.files[0]) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          const elements = convertExcalidrawScene(data);
          if (elements.length) {
            snapshot();
            scene.elements.push(...elements);
            zoomToFit();
            render();
          }
        } catch (err) {
          console.error("go-draw: failed to import excalidraw file", err);
        }
      };
      reader.readAsText(input.files[0]);
    };
    input.click();
  }

  function importExcalidrawLibrary() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".excalidrawlib,.json";
    input.onchange = () => {
      if (!input.files || !input.files[0]) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          showLibraryPicker(data);
        } catch (err) {
          console.error("go-draw: failed to import library", err);
        }
      };
      reader.readAsText(input.files[0]);
    };
    input.click();
  }

  function showLibraryPicker(libData) {
    const items = (libData.libraryItems || libData.library || []);
    if (!items.length) return;

    const { overlay, modal } = openModal(`
      <h3>Library</h3>
      <div class="lib-grid" id="lib-grid"></div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-secondary" id="lib-close">Close</button>
      </div>
    `);
    modal.querySelector("#lib-close").addEventListener("click", () => closeModal(overlay));

    const grid = modal.querySelector("#lib-grid");
    for (const item of items) {
      const elements = item.elements || [];
      if (!elements.length) continue;

      const card = document.createElement("div");
      card.className = "lib-item";

      // Mini canvas preview
      const preview = document.createElement("canvas");
      preview.className = "lib-preview";
      preview.width = 100;
      preview.height = 80;
      card.appendChild(preview);

      const name = document.createElement("div");
      name.className = "lib-name";
      name.textContent = item.name || item.id || "Item";
      card.appendChild(name);

      // Render preview
      const pctx = preview.getContext("2d");
      const converted = elements.map(e => convertExcalidrawElement(e, {})).filter(Boolean);
      if (converted.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of converted) {
          const bb = getBBox(c);
          minX = Math.min(minX, bb.x);
          minY = Math.min(minY, bb.y);
          maxX = Math.max(maxX, bb.x + bb.w);
          maxY = Math.max(maxY, bb.y + bb.h);
        }
        const cw = maxX - minX || 1, ch = maxY - minY || 1;
        const s = Math.min(90 / cw, 70 / ch, 2);
        pctx.translate(50 - (minX + maxX) / 2 * s, 40 - (minY + maxY) / 2 * s);
        pctx.scale(s, s);
        for (const c of converted) drawElement(pctx, c);
      }

      card.addEventListener("click", () => {
        const newEls = elements.map(e => convertExcalidrawElement(e, {})).filter(Boolean);
        if (!newEls.length) return;
        // Center on viewport
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of newEls) {
          const bb = getBBox(c);
          minX = Math.min(minX, bb.x);
          minY = Math.min(minY, bb.y);
          maxX = Math.max(maxX, bb.x + bb.w);
          maxY = Math.max(maxY, bb.y + bb.h);
        }
        const centerWx = (canvas.width / 2 - vp.x) / vp.scale;
        const centerWy = (canvas.height / 2 - vp.y) / vp.scale;
        const offX = centerWx - (minX + maxX) / 2;
        const offY = centerWy - (minY + maxY) / 2;
        for (const c of newEls) {
          c.id = uid();
          moveElement(c, offX, offY);
        }
        snapshot();
        scene.elements.push(...newEls);
        selectedIds = new Set(newEls.map(c => c.id));
        render();
        closeModal(overlay);
      });

      grid.appendChild(card);
    }
  }

  // ── #addLibrary URL hash integration ─────────────────────────────────────
  async function checkAddLibraryHash() {
    const hash = window.location.hash;
    if (!hash.startsWith("#addLibrary=")) return;
    const url = decodeURIComponent(hash.slice("#addLibrary=".length));
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      showLibraryPicker(data);
    } catch (err) {
      console.error("go-draw: failed to fetch library from URL", err);
    }
  }

  // ── Drag and drop ──────────────────────────────────────────────────────
  function setupDragDrop() {
    canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = e.dataTransfer.files;
      if (!files || !files.length) return;
      const file = files[0];
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.type === "excalidraw") {
            // .excalidraw scene file
            const elements = convertExcalidrawScene(data);
            if (elements.length) {
              snapshot();
              scene.elements.push(...elements);
              zoomToFit();
              render();
            }
          } else if (data.libraryItems || data.library) {
            // .excalidrawlib library file
            showLibraryPicker(data);
          }
        } catch (err) {
          console.error("go-draw: failed to parse dropped file", err);
        }
      };
      reader.readAsText(file);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  buildUI();
  applyDarkMode();

  // Center viewport initially
  vp.x = canvas.width / 2;
  vp.y = canvas.height / 2;

  var _zoomParam = getZoomParam();

  // Wrap loadDrawing to apply zoom after scene loads
  var _origLoad = loadDrawing;
  loadDrawing = async function() {
    await _origLoad();
    if (!IS_EDIT) {
      if (_zoomParam === "fit" || _zoomParam === null) {
        zoomToFit();
      } else if (typeof _zoomParam === "number") {
        centerOnContent(_zoomParam);
      }
      render();
    }
  };

  loadDrawing().then(() => {
    if (IS_EDIT) checkAddLibraryHash();
  });

  // Drag and drop support
  if (IS_EDIT) setupDragDrop();

  // Notify parent that canvas is ready
  postToParent("ready", { id: CFG.id, mode: CFG.mode });
})();
