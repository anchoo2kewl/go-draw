package main

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

// CollabServer manages room-based WebSocket relay for real-time collaboration.
// It relays opaque encrypted messages between peers — the server never sees plaintext.
type CollabServer struct {
	mu    sync.RWMutex
	rooms map[string]*room
}

type room struct {
	mu    sync.RWMutex
	peers map[string]*peer
}

type peer struct {
	id   string
	name string
	ws   *websocket.Conn
	send chan []byte
}

type wsMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
}

func NewCollabServer() *CollabServer {
	cs := &CollabServer{rooms: make(map[string]*room)}
	// Periodic cleanup of empty rooms
	go func() {
		for range time.Tick(5 * time.Minute) {
			cs.cleanup()
		}
	}()
	return cs
}

func (cs *CollabServer) Handler() http.Handler {
	return websocket.Handler(cs.handleWS)
}

func (cs *CollabServer) handleWS(ws *websocket.Conn) {
	// Extract room ID from URL path: /ws/{roomId}
	path := ws.Request().URL.Path
	parts := strings.Split(strings.TrimPrefix(path, "/ws/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		ws.Close()
		return
	}
	roomID := parts[0]

	// Generate peer ID
	peerID := newPeerID()
	name := ws.Request().URL.Query().Get("name")
	if name == "" {
		name = "Anonymous"
	}

	p := &peer{
		id:   peerID,
		name: name,
		ws:   ws,
		send: make(chan []byte, 64),
	}

	r := cs.getOrCreateRoom(roomID)
	r.addPeer(p)
	defer func() {
		r.removePeer(p)
		cs.cleanupRoom(roomID)
	}()

	// Send peer their own ID
	welcome, _ := json.Marshal(map[string]any{
		"type":    "welcome",
		"peerId":  peerID,
		"peers":   r.peerList(),
	})
	p.send <- welcome

	// Broadcast join to others
	joinMsg, _ := json.Marshal(map[string]any{
		"type":   "peer_joined",
		"peerId": peerID,
		"name":   name,
	})
	r.broadcast(joinMsg, peerID)

	// Writer goroutine
	done := make(chan struct{})
	go func() {
		defer close(done)
		for msg := range p.send {
			if err := websocket.Message.Send(ws, string(msg)); err != nil {
				return
			}
		}
	}()

	// Reader loop — relay messages
	for {
		var raw string
		if err := websocket.Message.Receive(ws, &raw); err != nil {
			break
		}

		var msg wsMessage
		if err := json.Unmarshal([]byte(raw), &msg); err != nil {
			continue
		}

		msg.From = peerID

		switch msg.Type {
		case "cursor", "element_update", "scene_sync", "signal":
			// Relay encrypted payload to all other peers (or specific peer)
			relayed, _ := json.Marshal(msg)
			if msg.To != "" {
				r.sendTo(msg.To, relayed)
			} else {
				r.broadcast(relayed, peerID)
			}
		}
	}

	// Broadcast leave
	leaveMsg, _ := json.Marshal(map[string]any{
		"type":   "peer_left",
		"peerId": peerID,
	})
	r.broadcast(leaveMsg, peerID)

	close(p.send)
	<-done
}

func (cs *CollabServer) getOrCreateRoom(id string) *room {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	r, ok := cs.rooms[id]
	if !ok {
		r = &room{peers: make(map[string]*peer)}
		cs.rooms[id] = r
	}
	return r
}

func (cs *CollabServer) cleanupRoom(id string) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	r, ok := cs.rooms[id]
	if !ok {
		return
	}
	r.mu.RLock()
	empty := len(r.peers) == 0
	r.mu.RUnlock()
	if empty {
		delete(cs.rooms, id)
	}
}

func (cs *CollabServer) cleanup() {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	for id, r := range cs.rooms {
		r.mu.RLock()
		empty := len(r.peers) == 0
		r.mu.RUnlock()
		if empty {
			delete(cs.rooms, id)
		}
	}
}

func (r *room) addPeer(p *peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.peers[p.id] = p
}

func (r *room) removePeer(p *peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, p.id)
}

func (r *room) peerList() []map[string]string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]map[string]string, 0, len(r.peers))
	for _, p := range r.peers {
		list = append(list, map[string]string{"id": p.id, "name": p.name})
	}
	return list
}

func (r *room) broadcast(msg []byte, except string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, p := range r.peers {
		if p.id == except {
			continue
		}
		select {
		case p.send <- msg:
		default:
			log.Printf("collab: dropping message for slow peer %s", p.id)
		}
	}
}

func (r *room) sendTo(id string, msg []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.peers[id]
	if !ok {
		return
	}
	select {
	case p.send <- msg:
	default:
	}
}

func newPeerID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b[i] = chars[n.Int64()]
	}
	return string(b)
}
