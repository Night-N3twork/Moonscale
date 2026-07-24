package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"strings"
	"sync"
	"syscall/js"
	"time"
)

type tsWebSocket struct {
	mu      sync.Mutex
	closed  bool
	conn    net.Conn
	ready   int // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED

	listeners map[string][]js.Value
	obj       js.Value
	br        *bufio.Reader
}

func (i *jsIPN) createTailscaleWebSocket(urlStr string, resolvedIP string) js.Value {
	ws := &tsWebSocket{listeners: make(map[string][]js.Value)}
	obj := map[string]any{
		"readyState":      0,
		"binaryType":      "arraybuffer",
		"send":            js.FuncOf(ws.jsSend),
		"close":           js.FuncOf(ws.jsClose),
		"addEventListener": js.FuncOf(ws.jsAddEventListener),
	}
	ws.obj = js.ValueOf(obj)

	go ws.connect(i, urlStr, resolvedIP)
	return ws.obj
}

func (ws *tsWebSocket) connect(i *jsIPN, rawURL string, resolvedIP string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("tsWebSocket.connect panic: %v", r)
		}
	}()

	u, err := url.Parse(rawURL)
	if err != nil {
		ws.dispatchError(fmt.Sprintf("bad url: %v", err))
		return
	}

	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if u.Scheme == "wss" || u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	path := u.Path
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	if path == "" {
		path = "/"
	}

	dialAddr := host
	if resolvedIP != "" {
		dialAddr = resolvedIP
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("tsWebSocket: dialing %s (host=%s resolved=%s)", net.JoinHostPort(dialAddr, port), host, dialAddr)
	rawConn, err := i.dialer.UserDial(ctx, "tcp", net.JoinHostPort(dialAddr, port))
	if err != nil {
		ws.dispatchError(fmt.Sprintf("dial: %v", err))
		return
	}
	log.Printf("tsWebSocket: dial succeeded")

	var conn net.Conn = rawConn
	if port == "443" {
		log.Printf("tsWebSocket: starting TLS handshake to %s", host)
		tlsConn := tls.Client(rawConn, &tls.Config{ServerName: host, InsecureSkipVerify: true})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			rawConn.Close()
			ws.dispatchError(fmt.Sprintf("tls: %v", err))
			return
		}
		log.Printf("tsWebSocket: TLS handshake succeeded")
		conn = tlsConn
	}

	key := make([]byte, 16)
	rand.Read(key)
	wsKey := base64.StdEncoding.EncodeToString(key)

	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wisp-v2\r\n\r\n",
		path, net.JoinHostPort(host, port), wsKey)

	log.Printf("tsWebSocket: sending upgrade request")
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		ws.dispatchError(fmt.Sprintf("upgrade write: %v", err))
		return
	}

	br := bufio.NewReaderSize(conn, 4096)
	log.Printf("tsWebSocket: reading upgrade response")
	resp, err := httpReadResponse(br)
	log.Printf("tsWebSocket: upgrade response: %s", resp[:min(len(resp), 200)])
	if err != nil {
		conn.Close()
		ws.dispatchError(fmt.Sprintf("upgrade response: %v", err))
		return
	}
	if !strings.Contains(resp, "101") {
		conn.Close()
		ws.dispatchError(fmt.Sprintf("upgrade rejected: %s", resp[:min(len(resp), 120)]))
		return
	}

	ws.mu.Lock()
	ws.conn = conn
	ws.br = br
	ws.ready = 1
	ws.mu.Unlock()

	ws.dispatch("open", nil)
	log.Printf("tsWebSocket: connected to %s via Tailscale netstack", rawURL)

	ws.readLoop()
}

func (ws *tsWebSocket) readLoop() {
	for {
		ws.mu.Lock()
		conn := ws.conn
		br := ws.br
		closed := ws.closed
		ws.mu.Unlock()

		if closed || conn == nil {
			return
		}

		opcode, payload, err := readWSFrame(br)
		if err != nil {
			if err != io.EOF && !strings.Contains(err.Error(), "use of closed") {
				log.Printf("tsWebSocket read error: %v", err)
			}
			ws.closeInternal("read error")
			return
		}

		switch opcode {
		case 0x8: // Close
			return
		case 0x9: // Ping — respond with Pong
			pong := []byte{0x8a, byte(len(payload))}
			pong = append(pong, payload...)
			conn.Write(pong)
		case 0xa: // Pong — ignore
		default: // Data frame (0x1 text, 0x2 binary, 0x0 continuation)
			if payload != nil {
				ws.dispatch("message", payload)
			}
		}
	}
}

func (ws *tsWebSocket) jsSend(this js.Value, args []js.Value) any {
	if len(args) == 0 {
		return nil
	}
	data := args[0]
	var payload []byte
	if data.Type() == js.TypeObject {
		// Could be Uint8Array or ArrayBuffer
		if t := data.Get("constructor"); !t.IsUndefined() {
			if t.Get("name").String() == "Uint8Array" {
				payload = make([]byte, data.Get("length").Int())
				js.CopyBytesToGo(payload, data)
			} else {
				// ArrayBuffer
				payload = make([]byte, data.Get("byteLength").Int())
				js.CopyBytesToGo(payload, js.Global().Get("Uint8Array").New(data))
			}
		} else {
			payload = make([]byte, data.Get("byteLength").Int())
			js.CopyBytesToGo(payload, js.Global().Get("Uint8Array").New(data))
		}
	} else if data.Type() == js.TypeString {
		payload = []byte(data.String())
	} else {
		return nil
	}

	ws.mu.Lock()
	conn := ws.conn
	ws.mu.Unlock()

	if conn == nil {
		return nil
	}

	frame := maskFrame(0x82, payload) // FIN + binary opcode, masked
	conn.Write(frame)
	return nil
}

func (ws *tsWebSocket) jsClose(this js.Value, args []js.Value) any {
	ws.closeInternal("closed")
	return nil
}

func (ws *tsWebSocket) jsAddEventListener(this js.Value, args []js.Value) any {
	if len(args) < 2 {
		return nil
	}
	typ := args[0].String()
	fn := args[1]
	ws.mu.Lock()
	ws.listeners[typ] = append(ws.listeners[typ], fn)
	ws.mu.Unlock()
	return nil
}

func (ws *tsWebSocket) closeInternal(reason string) {
	ws.mu.Lock()
	if ws.closed {
		ws.mu.Unlock()
		return
	}
	ws.closed = true
	ws.ready = 3
	if ws.conn != nil {
		ws.conn.Close()
	}
	ws.mu.Unlock()
	ws.dispatch("close", nil)
}

func (ws *tsWebSocket) dispatchError(msg string) {
	log.Printf("tsWebSocket error: %s", msg)
	ws.mu.Lock()
	ws.ready = 3
	ws.mu.Unlock()
	ws.dispatch("error", nil)
	ws.dispatch("close", nil)
}

func (ws *tsWebSocket) dispatch(typ string, data []byte) {
	ws.mu.Lock()
	listeners := ws.listeners[typ]
	if listeners == nil {
		listeners = nil
	}
	ws.mu.Unlock()

	if len(listeners) == 0 {
		return
	}

	var ev js.Value
	if typ == "message" && data != nil {
		arr := js.Global().Get("Uint8Array").New(len(data))
		js.CopyBytesToJS(arr, data)
		ev = js.ValueOf(map[string]any{"data": arr})
	} else if typ == "message" {
		return
	} else {
		ev = js.ValueOf(map[string]any{})
	}

	for _, fn := range listeners {
		fn.Invoke(ev)
	}
}

// HTTP response reader - reads until \r\n\r\n
func httpReadResponse(br *bufio.Reader) (string, error) {
	var b strings.Builder
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return b.String(), err
		}
		b.WriteString(line)
		if strings.HasSuffix(b.String(), "\r\n\r\n") || strings.HasSuffix(b.String(), "\n\n") {
			break
		}
	}
	// Consume any remaining buffered data past the headers
	// (this would be the first WebSocket frame)
	return b.String(), nil
}

// readWSFrame reads one WebSocket frame from the reader.
// Returns opcode, payload, and error.
func readWSFrame(r io.Reader) (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(r, header); err != nil {
		return 0, nil, err
	}

	masked := (header[1] & 0x80) != 0
	length := int64(header[1] & 0x7f)

	if length == 126 {
		ext := make([]byte, 2)
		if _, err := io.ReadFull(r, ext); err != nil {
			return 0, nil, err
		}
		length = int64(ext[0])<<8 | int64(ext[1])
	} else if length == 127 {
		ext := make([]byte, 8)
		if _, err := io.ReadFull(r, ext); err != nil {
			return 0, nil, err
		}
		length = 0
		for i := 0; i < 8; i++ {
			length = length<<8 | int64(ext[i])
		}
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(r, maskKey[:]); err != nil {
			return 0, nil, err
		}
	}

	opcode := header[0] & 0x0f

	// Handle control frames
	switch opcode {
	case 0x8: // Close — just discard payload
		if length > 0 {
			io.CopyN(io.Discard, r, length)
		}
		return opcode, nil, nil
	case 0x9: // Ping — read payload so we can echo it back in Pong
		if length > 0 {
			p := make([]byte, length)
			if _, err := io.ReadFull(r, p); err != nil {
				return 0, nil, err
			}
			return opcode, p, nil
		}
		return opcode, []byte{}, nil
	case 0xa: // Pong — discard payload
		if length > 0 {
			io.CopyN(io.Discard, r, length)
		}
		return opcode, nil, nil
	}

	// Data frame (text=0x1, binary=0x2, continuation=0x0)
	if length == 0 {
		return opcode, []byte{}, nil
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}

	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}

	return opcode, payload, nil
}

// maskFrame creates a masked WebSocket frame for client-to-server messages
func maskFrame(opcode byte, payload []byte) []byte {
	mask := make([]byte, 4)
	rand.Read(mask)

	var header []byte
	length := len(payload)
	if length < 126 {
		header = make([]byte, 6)
		header[0] = opcode
		header[1] = byte(0x80 | length) // masked | length
		copy(header[2:], mask)
	} else if length < 65536 {
		header = make([]byte, 8)
		header[0] = opcode
		header[1] = 0x80 | 126
		header[2] = byte(length >> 8)
		header[3] = byte(length)
		copy(header[4:], mask)
	} else {
		header = make([]byte, 14)
		header[0] = opcode
		header[1] = 0x80 | 127
		for i := 0; i < 8; i++ {
			header[2+i] = byte(length >> (8 * (7 - i)))
		}
		copy(header[10:], mask)
	}

	frame := make([]byte, len(header)+length)
	copy(frame, header)
	for i, b := range payload {
		frame[len(header)+i] = b ^ mask[i%4]
	}
	return frame
}
