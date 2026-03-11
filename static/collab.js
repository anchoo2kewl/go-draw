/*!
 * go-draw collab.js
 * E2E encrypted real-time collaboration via WebSocket.
 * Loaded only when GODRAW_CONFIG.collabEnabled = true (standalone app).
 *
 * Encryption: AES-256-GCM via Web Crypto API.
 * Key is shared via URL fragment (#key=base64url) — never sent to server.
 * Server only relays opaque encrypted blobs.
 */
(function () {
  "use strict";

  const CFG = window.GODRAW_CONFIG || {};
  if (!CFG.collabEnabled) return;

  const CURSOR_THROTTLE_MS = 50;
  const COLORS = [
    "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6",
    "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#06b6d4",
  ];

  // ── State ───────────────────────────────────────────────────────────────
  let ws = null;
  let myPeerId = "";
  let myName = localStorage.getItem("godraw-collab-name") || "Anonymous";
  let cryptoKey = null;
  let peers = new Map(); // id -> { name, color, cursor: {x, y} }
  let lastCursorSend = 0;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  // ── Encryption ─────────────────────────────────────────────────────────
  async function getOrCreateKey() {
    // Key from URL fragment: #key=base64url
    const hash = window.location.hash;
    const match = hash.match(/key=([A-Za-z0-9_-]+)/);
    if (match) {
      const rawKey = base64urlDecode(match[1]);
      return await crypto.subtle.importKey("raw", rawKey, "AES-GCM", true, ["encrypt", "decrypt"]);
    }
    // Generate new key and add to URL
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const exported = await crypto.subtle.exportKey("raw", key);
    const b64 = base64urlEncode(new Uint8Array(exported));
    const newHash = hash ? hash + "&key=" + b64 : "#key=" + b64;
    history.replaceState(null, "", window.location.pathname + window.location.search + newHash);
    return key;
  }

  async function encrypt(plaintext) {
    if (!cryptoKey) return plaintext;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(plaintext));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
    // Prefix IV to ciphertext
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(cipher), iv.length);
    return base64urlEncode(combined);
  }

  async function decrypt(data) {
    if (!cryptoKey || typeof data !== "string") return data;
    try {
      const combined = base64urlDecode(data);
      const iv = combined.slice(0, 12);
      const cipher = combined.slice(12);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, cipher);
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return null;
    }
  }

  function base64urlEncode(bytes) {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── WebSocket ──────────────────────────────────────────────────────────
  async function connect() {
    if (ws && ws.readyState <= 1) return;

    cryptoKey = await getOrCreateKey();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const roomId = CFG.id || "default";
    const url = `${proto}//${window.location.host}/ws/${roomId}?name=${encodeURIComponent(myName)}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = 1000;
      updatePresenceBar();
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "welcome":
          myPeerId = msg.peerId;
          for (const p of msg.peers || []) {
            if (p.id !== myPeerId) {
              peers.set(p.id, { name: p.name, color: peerColor(p.id), cursor: null });
            }
          }
          updatePresenceBar();
          // Send full scene to sync new peers
          sendSceneSync();
          break;

        case "peer_joined":
          if (msg.peerId !== myPeerId) {
            peers.set(msg.peerId, { name: msg.name, color: peerColor(msg.peerId), cursor: null });
            updatePresenceBar();
            // Send scene to the new peer
            sendSceneSync();
          }
          break;

        case "peer_left":
          peers.delete(msg.peerId);
          updatePresenceBar();
          renderCursors();
          break;

        case "cursor": {
          const payload = await decrypt(msg.payload);
          if (payload && peers.has(msg.from)) {
            peers.get(msg.from).cursor = { x: payload.x, y: payload.y };
            renderCursors();
          }
          break;
        }

        case "element_update": {
          const payload = await decrypt(msg.payload);
          if (payload && window._godrawCollabReceive) {
            window._godrawCollabReceive("element_update", payload);
          }
          break;
        }

        case "scene_sync": {
          const payload = await decrypt(msg.payload);
          if (payload && window._godrawCollabReceive) {
            window._godrawCollabReceive("scene_sync", payload);
          }
          break;
        }
      }
    };

    ws.onclose = () => {
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      connect();
    }, reconnectDelay);
  }

  function send(type, payload) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type, payload }));
  }

  async function sendEncrypted(type, data) {
    const encrypted = await encrypt(data);
    send(type, encrypted);
  }

  // ── Public API (called from canvas.js via hooks) ──────────────────────
  async function sendCursorPosition(x, y) {
    const now = Date.now();
    if (now - lastCursorSend < CURSOR_THROTTLE_MS) return;
    lastCursorSend = now;
    await sendEncrypted("cursor", { x, y });
  }

  async function sendElementUpdate(elements) {
    await sendEncrypted("element_update", { elements });
  }

  async function sendSceneSync() {
    if (!window._godrawGetScene) return;
    const scene = window._godrawGetScene();
    if (scene) {
      await sendEncrypted("scene_sync", scene);
    }
  }

  // ── Cursor rendering ──────────────────────────────────────────────────
  function renderCursors() {
    let container = document.getElementById("godraw-cursors");
    if (!container) {
      container = document.createElement("div");
      container.id = "godraw-cursors";
      container.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:50;overflow:hidden;";
      const wrap = document.getElementById("canvas-wrap");
      if (wrap) wrap.appendChild(container);
    }

    // Get viewport from canvas.js global
    const vp = window._godrawGetViewport ? window._godrawGetViewport() : { x: 0, y: 0, scale: 1 };

    container.innerHTML = "";
    for (const [id, p] of peers) {
      if (!p.cursor) continue;
      const sx = p.cursor.x * vp.scale + vp.x;
      const sy = p.cursor.y * vp.scale + vp.y;
      const cursor = document.createElement("div");
      cursor.style.cssText = `position:absolute;left:${sx}px;top:${sy}px;pointer-events:none;transition:left 50ms linear,top 50ms linear;`;
      cursor.innerHTML = `
        <svg width="16" height="20" viewBox="0 0 16 20" fill="${p.color}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))">
          <path d="M0 0L12 10L5.5 10.5L3 18Z"/>
        </svg>
        <span style="position:absolute;left:14px;top:12px;background:${p.color};color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;white-space:nowrap;font-family:sans-serif;">${escHtml(p.name)}</span>
      `;
      container.appendChild(cursor);
    }
  }

  // ── Presence bar ──────────────────────────────────────────────────────
  function updatePresenceBar() {
    let bar = document.getElementById("godraw-presence");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "godraw-presence";
      bar.style.cssText = "position:absolute;top:8px;right:8px;display:flex;gap:4px;z-index:30;align-items:center;";
      const wrap = document.getElementById("canvas-wrap");
      if (wrap) wrap.appendChild(bar);
    }
    bar.innerHTML = "";
    // My pill
    bar.appendChild(makePill("You", peerColor(myPeerId)));
    for (const [, p] of peers) {
      bar.appendChild(makePill(p.name, p.color));
    }
  }

  function makePill(name, color) {
    const pill = document.createElement("div");
    pill.style.cssText = `display:flex;align-items:center;gap:4px;background:${color};color:#fff;padding:3px 8px;border-radius:12px;font-size:11px;font-family:sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.15);`;
    pill.textContent = name;
    return pill;
  }

  function peerColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Expose API ────────────────────────────────────────────────────────
  window.GodrawCollab = {
    connect,
    sendCursorPosition,
    sendElementUpdate,
    sendSceneSync,
    setName(name) {
      myName = name;
      localStorage.setItem("godraw-collab-name", name);
    },
    getPeers() { return peers; },
    isConnected() { return ws && ws.readyState === 1; },
  };

  // Auto-connect if collab is enabled
  connect();
})();
