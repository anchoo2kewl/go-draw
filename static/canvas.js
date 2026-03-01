/*!
 * go-draw canvas.js
 * Pure vanilla JS canvas drawing engine.
 * Supports: select, rectangle, ellipse, line, arrow, pencil, text
 * Edit mode: full toolbar + save
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
  let textInput = null;

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  let undoStack = [];
  let redoStack = [];
  const UNDO_LIMIT = 60;

  let autoSaveTimer = null;
  function snapshot() {
    undoStack.push(JSON.stringify(scene.elements));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    // Auto-save after 2s of inactivity
    if (IS_EDIT) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(saveDrawing, 2000);
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
    { id: "select",    icon: "\u2B21", title: "Select (V / 1)" },
    { id: "rect",      icon: "\u25AD", title: "Rectangle (R / 2)" },
    { id: "ellipse",   icon: "\u25EF", title: "Ellipse (E / 3)" },
    { id: "line",      icon: "\u2571", title: "Line (L / 4)" },
    { id: "arrow",     icon: "\u2192", title: "Arrow (A / 5)" },
    { id: "pencil",    icon: "\u270F", title: "Pencil (P / 6)" },
    { id: "text",      icon: "T", title: "Text (T / 7)" },
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
          <button id="btn-delete" title="Delete selected (Del)">\uD83D\uDDD1</button>
          <button id="btn-save" title="Save (Ctrl+S)">\uD83D\uDCBE Save</button>
          <span id="save-status"></span>
        </div>
      `;
      app.appendChild(topbar);

      toolbar = topbar.querySelector("#toolbar");
      TOOLS.forEach(t => {
        const b = el("button", { class: "tool-btn" + (t.id === activeTool ? " active" : ""), title: t.title, dataset: { tool: t.id } });
        b.textContent = t.icon;
        toolbar.appendChild(b);
      });

      // Color + stroke controls
      const props = el("div", { id: "props" });
      props.innerHTML = `
        <label title="Stroke color"><span>Stroke</span><input type="color" id="stroke-color" value="${strokeColor}"></label>
        <label title="Fill color"><span>Fill</span><input type="color" id="fill-color" value="#ffffff"></label>
        <label class="fill-none-wrap" title="No fill"><input type="checkbox" id="fill-none" checked> No fill</label>
        <label title="Stroke width"><span>Width</span>
          <select id="stroke-width">
            <option value="1">1</option>
            <option value="2" selected>2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="6">6</option>
          </select>
        </label>
        <label title="Font size"><span>Font</span>
          <select id="font-size">
            <option value="12">12</option>
            <option value="16" selected>16</option>
            <option value="20">20</option>
            <option value="28">28</option>
            <option value="36">36</option>
          </select>
        </label>
      `;
      app.appendChild(props);

      // Wire prop controls
      topbar.querySelector("#btn-undo").addEventListener("click", undo);
      topbar.querySelector("#btn-redo").addEventListener("click", redo);
      topbar.querySelector("#btn-delete").addEventListener("click", deleteSelected);
      topbar.querySelector("#btn-save").addEventListener("click", saveDrawing);
      topbar.querySelector("#title-input").addEventListener("input", e => { title = e.target.value; });
      toolbar.addEventListener("click", e => {
        const btn = e.target.closest(".tool-btn");
        if (!btn) return;
        setTool(btn.dataset.tool);
      });
      props.querySelector("#stroke-color").addEventListener("input", e => strokeColor = e.target.value);
      props.querySelector("#fill-none").addEventListener("change", e => {
        fillColor = e.target.checked ? "transparent" : props.querySelector("#fill-color").value;
        props.querySelector("#fill-color").disabled = e.target.checked;
      });
      props.querySelector("#fill-color").addEventListener("input", e => {
        if (!props.querySelector("#fill-none").checked) fillColor = e.target.value;
      });
      props.querySelector("#stroke-width").addEventListener("change", e => strokeWidth = parseInt(e.target.value));
      props.querySelector("#font-size").addEventListener("change", e => fontSize = parseInt(e.target.value));
    }

    // ── Canvas ──────────────────────────────────────────────────────────────
    const wrap = el("div", { id: "canvas-wrap" });
    canvas = el("canvas", { id: "canvas" });
    wrap.appendChild(canvas);
    app.appendChild(wrap);
    ctx = canvas.getContext("2d");

    // ── Floating action bar (fullscreen + new canvas) ───────────────────────
    buildFloatingBar(wrap);

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

  // ── Floating action bar ─────────────────────────────────────────────────
  function buildFloatingBar(wrap) {
    const bar = el("div", { id: "godraw-fab" });

    // Fullscreen toggle
    const fsBtn = el("button", { id: "btn-fullscreen", title: "Toggle fullscreen (F11)" });
    fsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4A1.5 1.5 0 0 1 1.5 0h4a.5.5 0 0 1 0 1h-4zM10 .5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 16 1.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zM.5 10a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 0 14.5v-4a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5z"/></svg>';
    fsBtn.addEventListener("click", toggleFullscreen);
    bar.appendChild(fsBtn);

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
      .tool-btn { background:none; border:none; border-radius:6px; padding:5px 10px; font-size:1rem; cursor:pointer; color:#555; transition:background .15s; }
      .tool-btn:hover { background:#e4e4e7; }
      .tool-btn.active { background:#1e1e2e; color:#fff; }
      #topbar button { background:#f4f4f5; border:none; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:.85rem; }
      #topbar button:hover { background:#e4e4e7; }
      #btn-save { background:#1e1e2e; color:#fff; font-weight:600; }
      #btn-save:hover { background:#333; }
      #save-status { font-size:.75rem; color:#888; }
      #props { display:flex; align-items:center; gap:12px; padding:5px 14px; background:#fafafa; border-bottom:1px solid #ececec; flex-shrink:0; }
      #props label { display:flex; align-items:center; gap:5px; font-size:.78rem; color:#555; }
      #props input[type=color] { width:28px; height:22px; padding:0; border:1px solid #ccc; border-radius:4px; cursor:pointer; }
      #props select { font-size:.78rem; border:1px solid #ccc; border-radius:4px; padding:2px 4px; }
      #canvas-wrap { flex:1; position:relative; overflow:hidden; background:#f4f4f5; }
      #canvas { display:block; cursor:crosshair; }
      .fill-none-wrap { gap:3px !important; }
      /* Floating action bar */
      #godraw-fab { position:absolute; bottom:12px; right:12px; display:flex; gap:6px; z-index:20; }
      #godraw-fab button { width:36px; height:36px; border:none; border-radius:8px; background:rgba(255,255,255,0.92); color:#333; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.15); transition:background .15s, box-shadow .15s; }
      #godraw-fab button:hover { background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.2); }
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

  // ── Rendering ─────────────────────────────────────────────────────────────
  const GRID_SIZE = 20;

  function render() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#f8f8f8";
    ctx.fillRect(0, 0, W, H);

    // Dot grid
    const gs = GRID_SIZE * vp.scale;
    const offX = ((vp.x % gs) + gs) % gs;
    const offY = ((vp.y % gs) + gs) % gs;
    ctx.fillStyle = "#d4d4d8";
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
      drawElement(ctx, el, false);
    }

    // Current element (being drawn)
    if (currentEl) drawElement(ctx, currentEl, false);

    // Selection handles
    if (IS_EDIT) {
      for (const el of scene.elements) {
        if (selectedIds.has(el.id)) drawSelection(ctx, el);
      }
    }

    ctx.restore();
  }

  function applyStyle(ctx, el) {
    ctx.strokeStyle = el.strokeColor || "#1e1e2e";
    ctx.fillStyle = el.fillColor || "transparent";
    ctx.lineWidth = el.strokeWidth || 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
  }

  function drawElement(ctx, el, sel) {
    applyStyle(ctx, el);
    ctx.save();
    switch (el.type) {
      case "rect":     drawRect(ctx, el); break;
      case "ellipse":  drawEllipse(ctx, el); break;
      case "line":     drawLine(ctx, el); break;
      case "arrow":    drawArrow(ctx, el); break;
      case "pencil":   drawPencil(ctx, el); break;
      case "text":     drawText(ctx, el); break;
    }
    ctx.restore();
  }

  function drawRect(ctx, el) {
    const { x, y, w, h } = el;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    if (el.fillColor && el.fillColor !== "transparent") {
      ctx.fillStyle = el.fillColor;
      ctx.fill();
    }
    ctx.stroke();
  }

  function drawEllipse(ctx, el) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
    if (el.fillColor && el.fillColor !== "transparent") {
      ctx.fillStyle = el.fillColor;
      ctx.fill();
    }
    ctx.stroke();
  }

  function drawLine(ctx, el) {
    ctx.beginPath();
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x2, el.y2);
    ctx.stroke();
  }

  function drawArrow(ctx, el) {
    const dx = el.x2 - el.x, dy = el.y2 - el.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    const hw = 10, hl = 18;
    ctx.beginPath();
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x2, el.y2);
    ctx.stroke();
    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(el.x2, el.y2);
    ctx.lineTo(el.x2 - hl * ux + hw * uy, el.y2 - hl * uy - hw * ux);
    ctx.lineTo(el.x2 - hl * ux - hw * uy, el.y2 - hl * uy + hw * ux);
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
    ctx.font = `${el.fontSize || 16}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = el.strokeColor || "#1e1e2e";
    ctx.textBaseline = "top";
    const lines = (el.text || "").split("\n");
    lines.forEach((line, i) => ctx.fillText(line, el.x, el.y + i * (el.fontSize || 16) * 1.3));
  }

  function drawSelection(ctx, el) {
    const bb = getBBox(el);
    const pad = 6;
    ctx.save();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5 / vp.scale;
    ctx.setLineDash([4 / vp.scale, 3 / vp.scale]);
    ctx.strokeRect(bb.x - pad, bb.y - pad, bb.w + pad * 2, bb.h + pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
    // Corner handles
    const corners = [
      [bb.x - pad, bb.y - pad],
      [bb.x + bb.w + pad, bb.y - pad],
      [bb.x - pad, bb.y + bb.h + pad],
      [bb.x + bb.w + pad, bb.y + bb.h + pad],
    ];
    corners.forEach(([cx, cy]) => {
      ctx.beginPath();
      ctx.arc(cx, cy, 4 / vp.scale, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / vp.scale;
      ctx.stroke();
    });
  }

  function getBBox(el) {
    switch (el.type) {
      case "rect":
      case "ellipse":
      case "text":
        return { x: el.x, y: el.y, w: el.w || 0, h: el.h || 0 };
      case "line":
      case "arrow": {
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

  // ── Hit testing ───────────────────────────────────────────────────────────
  function hitTest(el, wx, wy) {
    const pad = 8;
    switch (el.type) {
      case "rect":
      case "ellipse":
      case "text": {
        const x0 = Math.min(el.x, el.x + el.w), y0 = Math.min(el.y, el.y + el.h);
        const x1 = x0 + Math.abs(el.w), y1 = y0 + Math.abs(el.h);
        return wx >= x0 - pad && wx <= x1 + pad && wy >= y0 - pad && wy <= y1 + pad;
      }
      case "line":
      case "arrow":
        return distToSegment(wx, wy, el.x, el.y, el.x2, el.y2) < pad + el.strokeWidth;
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

    if (activeTool === "select") {
      // Hit test in reverse (topmost first)
      const hit = [...scene.elements].reverse().find(el => hitTest(el, wx, wy));
      if (hit) {
        if (!selectedIds.has(hit.id)) {
          selectedIds = new Set([hit.id]);
        }
        isDragging = true;
        const bb = getBBox(hit);
        dragOffset = { x: wx - bb.x, y: wy - bb.y };
      } else {
        selectedIds.clear();
      }
      render();
      return;
    }

    if (activeTool === "text") {
      commitTextInput();
      startTextInput(wx, wy);
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

    if (!drawing) return;
    updateElement(currentEl, wx, wy);
    if (activeTool === "pencil") {
      pencilPoints.push({ x: wx, y: wy });
      currentEl.pts = [...pencilPoints];
    }
    render();
  }

  function onMouseUp(e) {
    if (panning) { panning = false; canvas.style.cursor = IS_EDIT ? "crosshair" : "grab"; return; }
    if (isDragging) { isDragging = false; snapshot(); return; }
    if (!drawing) return;
    drawing = false;
    if (currentEl) {
      const bb = getBBox(currentEl);
      const tooSmall = bb.w < 3 && bb.h < 3 && currentEl.type !== "pencil";
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
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "z") { e.preventDefault(); undo(); }
    if (mod && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
    if (mod && e.key === "s") { e.preventDefault(); saveDrawing(); }
    if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
    if (e.key === "v" || e.key === "V" || e.key === "1") setTool("select");
    if (e.key === "r" || e.key === "R" || e.key === "2") setTool("rect");
    if (e.key === "e" || e.key === "E" || e.key === "3") setTool("ellipse");
    if (e.key === "l" || e.key === "L" || e.key === "4") setTool("line");
    if (e.key === "a" || e.key === "A" || e.key === "5") setTool("arrow");
    if (e.key === "p" || e.key === "P" || e.key === "6") setTool("pencil");
    if (e.key === "t" || e.key === "T" || e.key === "7") setTool("text");
    if (e.key === "Escape") { commitTextInput(); selectedIds.clear(); render(); }
    if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
  }

  window.addEventListener("keyup", e => {
    if (e.code === "Space") { spaceDown = false; canvas.style.cursor = IS_EDIT ? "crosshair" : "grab"; }
  });

  function onViewKeyDown(e) {
    if (e.code === "Space" && !e.repeat) { spaceDown = true; canvas.style.cursor = "grab"; }
    if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
  }

  function onDblClick(e) {
    if (!IS_EDIT) return;
    const { cx, cy } = getMousePos(e);
    const { x: wx, y: wy } = canvasToWorld(cx, cy);
    const hit = [...scene.elements].reverse().find(el => hitTest(el, wx, wy));
    if (hit && hit.type === "text") {
      selectedIds = new Set([hit.id]);
      commitTextInput();
      startTextInputOnElement(hit);
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
    canvas.style.cursor = t === "select" ? "default" : "crosshair";
    render();
  }

  function makeElement(wx, wy) {
    const base = {
      id: uid(),
      type: activeTool,
      strokeColor,
      fillColor,
      strokeWidth,
    };
    switch (activeTool) {
      case "rect":
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
      case "ellipse":
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
      case "rect": case "ellipse": case "text":
        el.x += dx; el.y += dy; break;
      case "line": case "arrow":
        el.x += dx; el.y += dy; el.x2 += dx; el.y2 += dy; break;
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
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      color:${strokeColor}; background:transparent;
      border:1.5px dashed #3b82f6; outline:none; resize:none;
      padding:2px 4px; border-radius:3px;
      line-height:1.3;
    `;
    textInput.dataset.wx = wx;
    textInput.dataset.wy = wy;
    textInput.dataset.fs = fontSize;
    wrap.appendChild(textInput);
    textInput.focus();

    textInput.addEventListener("keydown", e => {
      if (e.key === "Escape") { commitTextInput(); }
    });
    textInput.addEventListener("blur", () => commitTextInput());
    textInput.addEventListener("input", () => render());
  }

  function startTextInputOnElement(el) {
    // Edit existing text element
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
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      color:${el.strokeColor || strokeColor}; background:transparent;
      border:1.5px dashed #3b82f6; outline:none; resize:none;
      padding:2px 4px; border-radius:3px; line-height:1.3;
    `;
    textInput.dataset.wx = el.x;
    textInput.dataset.wy = el.y;
    textInput.dataset.fs = el.fontSize || fontSize;
    wrap.appendChild(textInput);
    textInput.focus();
    textInput.addEventListener("keydown", e => { if (e.key === "Escape") commitTextInput(); });
    textInput.addEventListener("blur", () => commitTextInput());
  }

  function commitTextInput() {
    if (!textInput) return;
    const text = textInput.value.trim();
    const wx = parseFloat(textInput.dataset.wx);
    const wy = parseFloat(textInput.dataset.wy);
    const fs = parseInt(textInput.dataset.fs);
    textInput.remove();
    textInput = null;
    if (!text) return;
    snapshot();
    // Measure width (rough)
    ctx.font = `${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const lines = text.split("\n");
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    scene.elements.push({
      id: uid(), type: "text",
      x: wx, y: wy,
      w: maxW, h: lines.length * fs * 1.3,
      text, fontSize: fs,
      strokeColor,
    });
    render();
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function saveDrawing() {
    const status = document.getElementById("save-status");
    if (status) status.textContent = "Saving\u2026";
    try {
      const res = await fetch(`${CFG.basePath}/${CFG.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, scene }),
      });
      if (!res.ok) throw new Error(await res.text());
      if (status) { status.textContent = "Saved \u2713"; setTimeout(() => { status.textContent = ""; }, 2000); }
    } catch (err) {
      if (status) status.textContent = "Error: " + err.message;
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  async function loadDrawing() {
    try {
      const res = await fetch(`${CFG.basePath}/${CFG.id}/data`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
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

  // ── Init ──────────────────────────────────────────────────────────────────
  buildUI();

  // Center viewport initially
  vp.x = canvas.width / 2;
  vp.y = canvas.height / 2;

  loadDrawing();

  // Notify parent that canvas is ready
  postToParent("ready", { id: CFG.id, mode: CFG.mode });
})();
