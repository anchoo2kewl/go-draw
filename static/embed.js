/*!
 * go-draw embed.js
 * Lightweight host-page widget for embedding go-draw canvases.
 * Wraps iframes in a resizable container with drag-to-resize handles
 * that work in both normal and fullscreen modes.
 *
 * Usage:
 *   <div class="godraw-embed"
 *        data-src="/draw/my-id"
 *        data-width="100%"
 *        data-height="520px"
 *        data-base-path="/draw">
 *   </div>
 *   <script src="/draw/static/embed.js"></script>
 *
 * Or programmatic:
 *   GoDraw.embed(element, { src: "/draw/my-id/edit", width: "100%", height: "520px", basePath: "/draw" });
 *   GoDraw.newCanvas({ basePath: "/draw" }).then(data => { ... });
 */
(function () {
  "use strict";

  const MIN_HEIGHT = 200;
  const MIN_WIDTH = 260;
  // Mobile viewports get a shorter default embed height so the drawing fits
  // neatly inline with the text instead of dwarfing surrounding paragraphs.
  const isMobileViewport = typeof window !== "undefined" && window.innerWidth <= 640;

  function initEmbed(container) {
    const src = container.dataset.src;
    const width = container.dataset.width || "100%";
    const defaultHeight = isMobileViewport ? "260px" : "520px";
    const height = container.dataset.height || defaultHeight;
    const effectiveMinW = isMobileViewport ? 0 : MIN_WIDTH;

    // Build wrapper
    container.style.cssText = `position:relative;width:${width};height:${height};min-height:${MIN_HEIGHT}px;min-width:${effectiveMinW}px;`;
    container.classList.add("godraw-embed-initialized");

    // Iframe
    const iframe = document.createElement("iframe");
    const hostDark = document.documentElement.classList.contains("dark");
    iframe.src = src + (hostDark ? (src.includes("?") ? "&" : "?") + "theme=dark" : "");
    iframe.style.cssText = "width:100%;height:100%;border:none;border-radius:8px;display:block;";
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("loading", "lazy");
    iframe.addEventListener("load", () => {
      const dark = document.documentElement.classList.contains("dark");
      iframe.contentWindow.postMessage({ source: "go-draw-host", type: "set-dark-mode", dark }, "*");
    });
    container.appendChild(iframe);

    // ── Hover-to-interact overlay ─────────────────────────────────────
    // Blocks pointer events on the iframe until the user hovers for 3s,
    // preventing accidental scroll-trap when scrolling past the embed.
    const INTERACT_DELAY = 3; // seconds
    const interactOverlay = document.createElement("div");
    interactOverlay.className = "godraw-interact-overlay";
    interactOverlay.innerHTML =
      '<span class="godraw-interact-hint">' +
        '<svg class="godraw-interact-spinner" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>' +
        '<span class="godraw-interact-text">Hover for ' + INTERACT_DELAY + 's to interact</span>' +
      '</span>';
    container.appendChild(interactOverlay);

    let hoverTimer = null;
    let countdownInterval = null;

    interactOverlay.addEventListener("mouseenter", () => {
      const hint = interactOverlay.querySelector(".godraw-interact-hint");
      const textEl = interactOverlay.querySelector(".godraw-interact-text");
      const spinner = interactOverlay.querySelector(".godraw-interact-spinner");
      hint.classList.add("godraw-interact-counting");
      // Animate the spinner circle over INTERACT_DELAY seconds
      const circle = spinner.querySelector("circle");
      circle.style.transition = "stroke-dashoffset " + INTERACT_DELAY + "s linear";
      // Force reflow before starting animation
      void circle.offsetWidth;
      circle.style.strokeDashoffset = "0";

      let remaining = INTERACT_DELAY;
      textEl.textContent = "Hover for " + remaining + "s to interact";
      countdownInterval = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          textEl.textContent = "Hover for " + remaining + "s to interact";
        } else {
          textEl.textContent = "Interactive";
        }
      }, 1000);

      hoverTimer = setTimeout(() => {
        interactOverlay.classList.add("godraw-interact-active");
        clearInterval(countdownInterval);
        countdownInterval = null;
      }, INTERACT_DELAY * 1000);
    });

    interactOverlay.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      clearInterval(countdownInterval);
      hoverTimer = null;
      countdownInterval = null;
      interactOverlay.classList.remove("godraw-interact-active");
      const hint = interactOverlay.querySelector(".godraw-interact-hint");
      const textEl = interactOverlay.querySelector(".godraw-interact-text");
      const circle = interactOverlay.querySelector(".godraw-interact-spinner circle");
      hint.classList.remove("godraw-interact-counting");
      textEl.textContent = "Hover for " + INTERACT_DELAY + "s to interact";
      circle.style.transition = "none";
      circle.style.strokeDashoffset = "50.26";
    });

    // ── Drag handle (bottom-right corner) ──────────────────────────────
    const handle = document.createElement("div");
    handle.className = "godraw-resize-handle";
    handle.title = "Drag to resize";
    container.appendChild(handle);

    // ── Right edge handle ──────────────────────────────────────────────
    const rightHandle = document.createElement("div");
    rightHandle.className = "godraw-resize-right";
    rightHandle.title = "Drag to resize width";
    container.appendChild(rightHandle);

    // ── Bottom edge handle ─────────────────────────────────────────────
    const bottomHandle = document.createElement("div");
    bottomHandle.className = "godraw-resize-bottom";
    bottomHandle.title = "Drag to resize height";
    container.appendChild(bottomHandle);

    // Resize logic
    setupResize(container, iframe, handle, "both");
    setupResize(container, iframe, rightHandle, "horizontal");
    setupResize(container, iframe, bottomHandle, "vertical");

    // Listen for postMessage from iframe
    window.addEventListener("message", e => {
      if (!e.data || e.data.source !== "go-draw") return;
      if (e.data.type === "new-canvas") {
        container.dispatchEvent(new CustomEvent("godraw:new-canvas", {
          bubbles: true,
          detail: { id: e.data.id, edit_url: e.data.edit_url, view_url: e.data.view_url },
        }));
      }
      if (e.data.type === "fullscreen") {
        container.dispatchEvent(new CustomEvent("godraw:fullscreen", {
          bubbles: true,
          detail: { active: e.data.active },
        }));
      }
      if (e.data.type === "ready") {
        container.dispatchEvent(new CustomEvent("godraw:ready", {
          bubbles: true,
          detail: { id: e.data.id, mode: e.data.mode },
        }));
      }
    });

    return { iframe, container };
  }

  function setupResize(container, iframe, handle, direction) {
    let startX, startY, startW, startH;
    let overlay; // prevents iframe from stealing mouse events during drag

    function onMouseDown(e) {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startW = container.offsetWidth;
      startH = container.offsetHeight;

      // Create overlay to capture mouse events over iframe
      overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;cursor:" + getCursor(direction) + ";";
      document.body.appendChild(overlay);

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }

    function onMouseMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (direction === "both" || direction === "horizontal") {
        container.style.width = Math.max(MIN_WIDTH, startW + dx) + "px";
      }
      if (direction === "both" || direction === "vertical") {
        container.style.height = Math.max(MIN_HEIGHT, startH + dy) + "px";
      }
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (overlay) { overlay.remove(); overlay = null; }
    }

    handle.addEventListener("mousedown", onMouseDown);

    // Touch support
    handle.addEventListener("touchstart", e => {
      e.preventDefault();
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startW = container.offsetWidth;
      startH = container.offsetHeight;

      function onTouchMove(e2) {
        const t2 = e2.touches[0];
        const dx = t2.clientX - startX;
        const dy = t2.clientY - startY;
        if (direction === "both" || direction === "horizontal") {
          container.style.width = Math.max(MIN_WIDTH, startW + dx) + "px";
        }
        if (direction === "both" || direction === "vertical") {
          container.style.height = Math.max(MIN_HEIGHT, startH + dy) + "px";
        }
      }
      function onTouchEnd() {
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
      }
      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
    }, { passive: false });
  }

  function getCursor(direction) {
    if (direction === "horizontal") return "ew-resize";
    if (direction === "vertical") return "ns-resize";
    return "nwse-resize";
  }

  // ── Inject styles ─────────────────────────────────────────────────────
  function injectEmbedStyles() {
    if (document.getElementById("godraw-embed-styles")) return;
    const s = document.createElement("style");
    s.id = "godraw-embed-styles";
    s.textContent = `
      .godraw-embed { position:relative; border:1px solid #e0e0e0; border-radius:8px; overflow:visible; background:#f4f4f5; }
      .godraw-resize-handle {
        position:absolute; bottom:-4px; right:-4px; width:16px; height:16px;
        cursor:nwse-resize; z-index:10; border-radius:0 0 8px 0;
        background:linear-gradient(135deg, transparent 50%, #ccc 50%);
        opacity:0.6; transition:opacity .15s;
      }
      .godraw-resize-handle:hover { opacity:1; }
      .godraw-resize-right {
        position:absolute; top:8px; right:-4px; width:8px; bottom:20px;
        cursor:ew-resize; z-index:10;
      }
      .godraw-resize-right:hover { background:rgba(59,130,246,0.15); border-radius:4px; }
      .godraw-resize-bottom {
        position:absolute; left:8px; bottom:-4px; height:8px; right:20px;
        cursor:ns-resize; z-index:10;
      }
      .godraw-resize-bottom:hover { background:rgba(59,130,246,0.15); border-radius:4px; }
      .godraw-interact-overlay {
        position:absolute; top:0; left:0; right:0; bottom:0;
        z-index:5; cursor:default; border-radius:8px;
        display:flex; align-items:flex-start; justify-content:center;
        padding-top:12px;
      }
      .godraw-interact-overlay.godraw-interact-active { pointer-events:none; }
      .godraw-interact-overlay.godraw-interact-active .godraw-interact-hint { opacity:0; }
      .godraw-interact-hint {
        display:inline-flex; align-items:center; gap:6px;
        padding:6px 14px; border-radius:20px; font-size:13px; font-weight:500;
        color:#d1d5db; background:rgba(55,65,81,0.9); border:none;
        pointer-events:none; opacity:0; transition:opacity .25s;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        backdrop-filter:blur(4px);
      }
      .godraw-interact-overlay:hover .godraw-interact-hint { opacity:1; }
      .godraw-interact-spinner {
        width:16px; height:16px; flex-shrink:0;
      }
      .godraw-interact-spinner circle {
        fill:none; stroke:#9ca3af; stroke-width:2;
        stroke-dasharray:50.26; stroke-dashoffset:50.26;
        transform:rotate(-90deg); transform-origin:center;
      }
      .godraw-interact-counting .godraw-interact-spinner circle { stroke:#60a5fa; }
      .dark .godraw-embed { border-color:#333; background:#1a1a2e; }
      .dark .godraw-resize-handle { background:linear-gradient(135deg, transparent 50%, #555 50%); }
    `;
    document.head.appendChild(s);
  }

  // ── Auto-init all .godraw-embed elements ──────────────────────────────
  injectEmbedStyles();
  document.querySelectorAll(".godraw-embed:not(.godraw-embed-initialized)").forEach(initEmbed);

  // ── Observe for dynamically added embeds ──────────────────────────────
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains("godraw-embed") && !node.classList.contains("godraw-embed-initialized")) {
            initEmbed(node);
          }
          // Also check children
          if (node.querySelectorAll) {
            node.querySelectorAll(".godraw-embed:not(.godraw-embed-initialized)").forEach(initEmbed);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── Watch host theme changes and relay to all embedded iframes ────────
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      const dark = document.documentElement.classList.contains("dark");
      document.querySelectorAll(".godraw-embed-initialized iframe").forEach(f => {
        f.contentWindow.postMessage({ source: "go-draw-host", type: "set-dark-mode", dark }, "*");
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }

  // ── Public API ────────────────────────────────────────────────────────
  window.GoDraw = {
    /** Embed a drawing into a container element */
    embed: function (container, opts) {
      container.dataset.src = opts.src;
      if (opts.width) container.dataset.width = opts.width;
      if (opts.height) container.dataset.height = opts.height;
      if (opts.basePath) container.dataset.basePath = opts.basePath;
      container.classList.add("godraw-embed");
      return initEmbed(container);
    },

    /** Create a new canvas and return { id, edit_url, view_url } */
    newCanvas: async function (opts) {
      const basePath = (opts && opts.basePath) || "/draw";
      const res = await fetch(basePath + "/api/new", { method: "POST" });
      if (!res.ok) throw new Error("Failed to create canvas: HTTP " + res.status);
      return res.json();
    },
  };
})();
