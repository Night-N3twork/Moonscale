// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

// The wasm package builds a WebAssembly module that provides a subset of
// Tailscale APIs to JavaScript.
//
// When run in the browser, a newIPN(config) function is added to the global JS
// namespace. When called it returns an ipn object with the methods
// run(callbacks), login(), logout(), and ssh(...).
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"golang.org/x/crypto/ssh"
	"tailscale.com/control/controlclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnauth"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/ipn/ipnserver"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/net/tsdial"
	"tailscale.com/safesocket"
	"tailscale.com/tailcfg"
	"tailscale.com/tsd"
	"tailscale.com/types/logid"
	"tailscale.com/types/views"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/netstack"
)

// ControlURL defines the URL to be used for connection to Control.
var ControlURL = ipn.DefaultControlURL

func main() {
	js.Global().Set("newIPN", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 {
			log.Fatal("Usage: newIPN(config)")
			return nil
		}
		return newIPN(args[0])
	}))
	// Keep Go runtime alive, otherwise it will be shut down before newIPN gets
	// called.
	<-make(chan bool)
}

func newIPN(jsConfig js.Value) map[string]any {
	netns.SetEnabled(false)

	var store ipn.StateStore
	if jsStateStorage := jsConfig.Get("stateStorage"); !jsStateStorage.IsUndefined() {
		store = &jsStateStore{jsStateStorage}
	} else {
		store = new(mem.Store)
	}

	controlURL := ControlURL
	if jsControlURL := jsConfig.Get("controlURL"); jsControlURL.Type() == js.TypeString {
		controlURL = jsControlURL.String()
	}

	var authKey string
	if jsAuthKey := jsConfig.Get("authKey"); jsAuthKey.Type() == js.TypeString {
		authKey = jsAuthKey.String()
	}

	var hostname string
	if jsHostname := jsConfig.Get("hostname"); jsHostname.Type() == js.TypeString {
		hostname = jsHostname.String()
	} else {
		hostname = defaultHostname()
	}

	logf := newBrowserLogConfig().Logf

	sys := tsd.NewSystem()
	sys.Set(store)
	dialer := &tsdial.Dialer{Logf: logf}
	dialer.SetBus(sys.Bus.Get())
	sys.Set(dialer)
	eng, err := wgengine.NewUserspaceEngine(logf, wgengine.Config{
		Dialer:        dialer,
		SetSubsystem:  sys.Set,
		ControlKnobs:  sys.ControlKnobs(),
		HealthTracker: sys.HealthTracker.Get(),
		ExtraRootCAs:  sys.ExtraRootCAs,
		Metrics:       sys.UserMetricsRegistry(),
		EventBus:      sys.Bus.Get(),
	})
	if err != nil {
		log.Fatal(err)
	}
	sys.Set(eng)

	ns, err := netstack.Create(logf, sys.Tun.Get(), eng, sys.MagicSock.Get(), dialer, sys.DNSManager.Get(), sys.ProxyMapper())
	if err != nil {
		log.Fatalf("netstack.Create: %v", err)
	}
	sys.Set(ns)
	ns.ProcessLocalIPs = true
	ns.ProcessSubnets = true

	dialer.UseNetstackForIP = func(ip netip.Addr) bool {
		return true
	}
	dialer.NetstackDialTCP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		// Note: don't just return ns.DialContextTCP or we'll return
		// *gonet.TCPConn(nil) instead of a nil interface which trips up
		// callers.
		tcpConn, err := ns.DialContextTCP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return tcpConn, nil
	}
	dialer.NetstackDialUDP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		// Note: don't just return ns.DialContextUDP or we'll return
		// *gonet.UDPConn(nil) instead of a nil interface which trips up
		// callers.
		udpConn, err := ns.DialContextUDP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return udpConn, nil
	}
	sys.NetstackRouter.Set(true)
	sys.Tun.Get().Start()

	var publicLogID logid.PublicID
	srv := ipnserver.New(logf, publicLogID, sys.Bus.Get(), sys.NetMon.Get())
	lb, err := ipnlocal.NewLocalBackend(logf, publicLogID, sys, controlclient.LoginEphemeral)
	if err != nil {
		log.Fatalf("ipnlocal.NewLocalBackend: %v", err)
	}
	if err := ns.Start(lb); err != nil {
		log.Fatalf("failed to start netstack: %v", err)
	}
	srv.SetLocalBackend(lb)

	jsIPN := &jsIPN{
		dialer:     dialer,
		ns:         ns,
		srv:        srv,
		lb:         lb,
		controlURL: controlURL,
		authKey:    authKey,
		hostname:   hostname,
		listeners:  make(map[int]net.Listener),
	}

	return map[string]any{
		"run": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 1 {
				log.Fatal(`Usage: run({
					notifyState(state: int): void,
					notifyNetMap(netMap: object): void,
					notifyBrowseToURL(url: string): void,
					notifyPanicRecover(err: string): void,
				})`)
				return nil
			}
			jsIPN.run(args[0])
			return nil
		}),
		"login": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 0 {
				log.Printf("Usage: login()")
				return nil
			}
			jsIPN.login()
			return nil
		}),
		"logout": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 0 {
				log.Printf("Usage: logout()")
				return nil
			}
			jsIPN.logout()
			return nil
		}),
		"listExitNodes": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 0 {
				log.Printf("Usage: listExitNodes()")
				return nil
			}
			return jsExitNodes(jsIPN.listExitNodes())
		}),
		"setExitNode": js.FuncOf(func(this js.Value, args []js.Value) any {
			return jsIPN.setExitNode(args)
		}),
		"clearExitNode": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 0 {
				return makePromise(func() (any, error) { return nil, fmt.Errorf("clearExitNode expects no arguments") })
			}
			return jsIPN.clearExitNode()
		}),
		"exitNode": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 0 {
				log.Printf("Usage: exitNode()")
				return nil
			}
			return jsIPN.exitNode()
		}),
		"ssh": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 3 {
				log.Printf("Usage: ssh(hostname, userName, termConfig)")
				return nil
			}
			return jsIPN.ssh(
				args[0].String(),
				args[1].String(),
				args[2])
		}),
		"fetch": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 1 {
				log.Printf("Usage: fetch(url)")
				return nil
			}

			url := args[0].String()
			return jsIPN.fetch(url)
		}),
		"dialTcp": js.FuncOf(func(this js.Value, args []js.Value) any {
			return jsIPN.dialTCP(args)
		}),
		"dialUdp": js.FuncOf(func(this js.Value, args []js.Value) any {
			return jsIPN.dialUDP(args)
		}),
		"listenTcp": js.FuncOf(func(this js.Value, args []js.Value) any {
			return jsIPN.listenTCP(args)
		}),
		"listenUdp": js.FuncOf(func(this js.Value, args []js.Value) any {
			return jsIPN.listenUDP(args)
		}),
		"createTailscaleWebSocket": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) < 1 || args[0].Type() != js.TypeString {
				log.Printf("Usage: createTailscaleWebSocket(url[, resolvedIP])")
				return nil
			}
			resolvedIP := ""
			if len(args) >= 2 && args[1].Type() == js.TypeString && args[1].String() != "" {
				resolvedIP = args[1].String()
			}
			return jsIPN.createTailscaleWebSocket(args[0].String(), resolvedIP)
		}),
		"setFunnel": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 2 {
				log.Printf("Usage: setFunnel(port, target)")
				return nil
			}
			return jsIPN.setFunnel(args[0].Int(), args[1].String())
		}),
		"clearFunnel": js.FuncOf(func(this js.Value, args []js.Value) any {
			return jsIPN.clearFunnel()
		}),
		"resolveDNS": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 2 {
				log.Printf("Usage: resolveDNS(host, port)")
				return nil
			}
			return jsIPN.resolveDNS(args[0].String(), args[1].Int())
		}),
	}
}

type jsIPN struct {
	dialer     *tsdial.Dialer
	ns         *netstack.Impl
	srv        *ipnserver.Server
	lb         *ipnlocal.LocalBackend
	controlURL string
	authKey    string
	hostname   string
	listeners  map[int]net.Listener // netstack listeners created for non-Funnel serve ports
}

func (i *jsIPN) dialTCP(args []js.Value) any {
	host, port, callbacks, err := networkArgs(args, "onOpen", "onData", "onClose")
	if err != nil {
		return newJSTerminalHandle(callbacks, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	pending := newJSPendingDial(cancel, callbacks)
	go func() {
		conn, err := i.dialer.UserDial(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		callbacks, active := pending.complete()
		if !active {
			if conn != nil {
				conn.Close()
			}
			return
		}
		if err != nil {
			pending.fail(callbacks, err)
			return
		}
		jsConn := newJSTCPConnection(conn, callbacks)
		if !pending.lifecycle.deliver(func() { jsConn.notifyOpen() }) {
			jsConn.close()
			return
		}
		jsConn.startReader()
	}()
	return pending.value
}

func (i *jsIPN) dialUDP(args []js.Value) any {
	host, port, callbacks, err := networkArgs(args, "onOpen", "onData", "onClose")
	if err != nil {
		return newJSTerminalHandle(callbacks, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	pending := newJSPendingDial(cancel, callbacks)
	go func() {
		conn, err := i.dialer.UserDial(ctx, "udp", net.JoinHostPort(host, strconv.Itoa(port)))
		callbacks, active := pending.complete()
		if !active {
			if conn != nil {
				conn.Close()
			}
			return
		}
		if err != nil {
			pending.fail(callbacks, err)
			return
		}
		jsConn := newJSUDPConnection(conn, callbacks)
		if !pending.lifecycle.deliver(func() { callbacks.Call("onOpen", jsConn.value) }) {
			jsConn.close()
			return
		}
		go jsConn.read()
	}()
	return pending.value
}

func (i *jsIPN) listenTCP(args []js.Value) any {
	host, port, callbacks, err := networkArgs(args, "onListening", "onConnection", "onClose")
	if err != nil {
		return newJSTerminalHandle(callbacks, err)
	}
	network, err := listenerNetwork(host, "tcp")
	if err != nil {
		return newJSTerminalHandle(callbacks, err)
	}
	listener, err := i.ns.ListenTCP(network, net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return newJSTerminalHandle(callbacks, err)
	}
	jsListener := newJSListener(listener, callbacks)
	callbacks.Call("onListening", jsListener.value)
	go func() {
		defer jsListener.close()
		for {
			conn, err := listener.Accept()
			if err != nil {
				jsListener.lifecycle.deliver(func() { callbackError(callbacks, err) })
				return
			}
			peerHost, peerPort, err := addressParts(conn.RemoteAddr())
			if err != nil {
				conn.Close()
				jsListener.lifecycle.deliver(func() { callbackError(callbacks, err) })
				continue
			}
			// The application supplies stream callbacks with connection.setCallbacks
			// from onConnection before the read loop starts.
			jsConn := newJSTCPConnection(conn, js.Undefined())
			if !jsListener.lifecycle.deliver(func() {
				callbacks.Call("onConnection", jsConn.value, map[string]any{"host": peerHost, "port": peerPort})
			}) {
				jsConn.close()
				return
			}
		}
	}()
	return jsListener.value
}

func (i *jsIPN) listenUDP(args []js.Value) any {
	host, port, callbacks, err := networkArgs(args, "onListening", "onMessage", "onClose")
	if err != nil {
		return newJSUDPTerminalListener(callbacks, err)
	}
	network, err := listenerNetwork(host, "udp")
	if err != nil {
		return newJSUDPTerminalListener(callbacks, err)
	}
	conn, err := i.ns.ListenPacket(network, net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return newJSUDPTerminalListener(callbacks, err)
	}
	jsListener := newJSUDPListener(conn, callbacks)
	callbacks.Call("onListening", jsListener.value)
	go func() {
		defer jsListener.close()
		buf := make([]byte, 64<<10)
		for {
			n, addr, err := conn.ReadFrom(buf)
			if err != nil {
				jsListener.lifecycle.deliver(func() { callbackError(callbacks, err) })
				return
			}
			host, port, err := addressParts(addr)
			if err != nil {
				jsListener.lifecycle.deliver(func() { callbackError(callbacks, err) })
				continue
			}
			data := append([]byte(nil), buf[:n]...)
			jsListener.lifecycle.deliver(func() {
				callbacks.Call("onMessage", jsBytes(data), map[string]any{"host": host, "port": port}, jsListener.value)
			})
		}
	}()
	return jsListener.value
}

func networkArgs(args []js.Value, callbackNames ...string) (string, int, js.Value, error) {
	callbacks := js.Undefined()
	if len(args) >= 3 {
		callbacks = args[2]
	}
	if len(args) != 3 {
		return "", 0, callbacks, fmt.Errorf("expected host, port, and callbacks")
	}
	if args[0].Type() != js.TypeString || args[0].String() == "" {
		return "", 0, callbacks, fmt.Errorf("host must be a non-empty string")
	}
	if args[1].Type() != js.TypeNumber {
		return "", 0, callbacks, fmt.Errorf("port must be an integer from 1 through 65535")
	}
	if !validatePort(args[1].Float(), func(error) {}) {
		return "", 0, callbacks, fmt.Errorf("port must be an integer from 1 through 65535")
	}
	if callbacks.Type() != js.TypeObject {
		return "", 0, callbacks, fmt.Errorf("callbacks must be an object")
	}
	for _, name := range append([]string{"onError"}, callbackNames...) {
		if callbacks.Get(name).Type() != js.TypeFunction {
			return "", 0, callbacks, fmt.Errorf("callbacks.%s must be a function", name)
		}
	}
	return args[0].String(), args[1].Int(), callbacks, nil
}

func listenerNetwork(host, protocol string) (string, error) {
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return "", fmt.Errorf("listener host must be an IP address: %w", err)
	}
	if addr.Is4() {
		return protocol + "4", nil
	}
	return protocol + "6", nil
}

func callbackError(callbacks js.Value, err error) {
	if callbacks.Type() == js.TypeObject && callbacks.Get("onError").Type() == js.TypeFunction {
		callbacks.Call("onError", err.Error())
	}
}

// newJSTerminalHandle returns a close-safe handle after an operation fails
// before it can create a connection or listener.
func newJSTerminalHandle(callbacks js.Value, err error) js.Value {
	var lifecycle bridgeLifecycle
	lifecycle.open()
	closeFunc := js.FuncOf(func(this js.Value, args []js.Value) any {
		lifecycle.close()
		return nil
	})
	closeRelease := releaseOnce{release: closeFunc.Release}
	value := newJSObject(map[string]any{"close": closeFunc})
	lifecycle.closeWithEvents(func() {
		releaseJSFunc(value, "close", &closeFunc, &closeRelease)
	}, func() {
		callbackError(callbacks, err)
	}, func() {
		if callbacks.Type() == js.TypeObject && callbacks.Get("onClose").Type() == js.TypeFunction {
			callbacks.Call("onClose")
		}
	})
	return value
}

func newJSUDPTerminalListener(callbacks js.Value, err error) js.Value {
	value := newJSTerminalHandle(callbacks, err)
	value.Set("sendTo", noOpJSFunc)
	return value
}

var noOpJSFunc = js.FuncOf(func(this js.Value, args []js.Value) any { return nil })

func newJSObject(properties map[string]any) js.Value {
	value := js.Global().Get("Object").New()
	for name, property := range properties {
		value.Set(name, property)
	}
	return value
}

func releaseJSFunc(value js.Value, name string, fn *js.Func, release *releaseOnce) {
	value.Set(name, noOpJSFunc)
	release.do()
}

func jsBytes(data []byte) js.Value {
	value := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(value, data)
	return value
}

func bytesFromJS(value js.Value) ([]byte, error) {
	if !value.InstanceOf(js.Global().Get("Uint8Array")) {
		return nil, fmt.Errorf("data must be a Uint8Array")
	}
	data := make([]byte, value.Get("byteLength").Int())
	js.CopyBytesToGo(data, value)
	return data, nil
}

func addressParts(addr net.Addr) (string, int, error) {
	addrPort, err := netip.ParseAddrPort(addr.String())
	if err != nil {
		return "", 0, err
	}
	return addrPort.Addr().String(), int(addrPort.Port()), nil
}

type jsPendingDial struct {
	mu           sync.Mutex
	lifecycle    bridgeLifecycle
	cancel       context.CancelFunc
	callbacks    js.Value
	closeFunc    js.Func
	closeRelease releaseOnce
	value        js.Value
}

func newJSPendingDial(cancel context.CancelFunc, callbacks js.Value) *jsPendingDial {
	dial := &jsPendingDial{cancel: cancel, callbacks: callbacks}
	dial.closeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		dial.close()
		return nil
	})
	dial.closeRelease.release = dial.closeFunc.Release
	dial.value = newJSObject(map[string]any{"close": dial.closeFunc})
	return dial
}

func (d *jsPendingDial) complete() (js.Value, bool) {
	var callbacks js.Value
	if !d.lifecycle.openAnd(func() {
		d.mu.Lock()
		callbacks = d.callbacks
		d.callbacks = js.Undefined()
		d.cancel()
		d.mu.Unlock()
	}) {
		return js.Undefined(), false
	}
	releaseJSFunc(d.value, "close", &d.closeFunc, &d.closeRelease)
	return callbacks, true
}

func (d *jsPendingDial) close() {
	var callbacks js.Value
	d.lifecycle.closeWithEvents(func() {
		d.mu.Lock()
		callbacks = d.callbacks
		d.callbacks = js.Undefined()
		d.cancel()
		d.mu.Unlock()
		releaseJSFunc(d.value, "close", &d.closeFunc, &d.closeRelease)
	}, func() { callbackError(callbacks, context.Canceled) }, func() {
		if callbacks.Type() == js.TypeObject && callbacks.Get("onClose").Type() == js.TypeFunction {
			callbacks.Call("onClose")
		}
	})
}

func (d *jsPendingDial) fail(callbacks js.Value, err error) {
	d.lifecycle.closeWithEvents(func() {
		releaseJSFunc(d.value, "close", &d.closeFunc, &d.closeRelease)
	}, func() { callbackError(callbacks, err) }, func() {
		if callbacks.Type() == js.TypeObject && callbacks.Get("onClose").Type() == js.TypeFunction {
			callbacks.Call("onClose")
		}
	})
}

type jsTCPConnection struct {
	mu             sync.Mutex
	conn           net.Conn
	callbacks      js.Value
	openedNotified bool
	lifecycle      bridgeLifecycle
	reader         readerGate
	writeFunc      js.Func
	setFunc        js.Func
	closeFunc      js.Func
	writeRelease   releaseOnce
	setRelease     releaseOnce
	closeRelease   releaseOnce
	value          js.Value
}

func newJSTCPConnection(conn net.Conn, callbacks js.Value) *jsTCPConnection {
	c := &jsTCPConnection{conn: conn, callbacks: callbacks}
	c.lifecycle.open()
	if callbacks.Type() == js.TypeObject {
		c.reader.attachCallbacks()
	}
	c.writeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 {
			callbackError(c.callbackSnapshot(), fmt.Errorf("write expects one Uint8Array"))
			return nil
		}
		data, err := bytesFromJS(args[0])
		if err != nil {
			callbackError(c.callbackSnapshot(), err)
			return nil
		}
		if _, err := c.conn.Write(data); err != nil {
			callbacks := c.callbackSnapshot()
			onError := snapshotCallback(callbacks.Get("onError"))
			c.lifecycle.deliver(func() {
				if onError.Type() == js.TypeFunction {
					onError.Invoke(err.Error())
				}
			})
		}
		return nil
	})
	c.closeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		c.close()
		return nil
	})
	c.setFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeObject {
			callbackError(c.callbackSnapshot(), fmt.Errorf("setCallbacks expects callbacks"))
			return nil
		}
		callbacks := args[0]
		for _, name := range []string{"onOpen", "onData", "onClose", "onError"} {
			if callbacks.Get(name).Type() != js.TypeFunction {
				callbackError(c.callbackSnapshot(), fmt.Errorf("callbacks.%s must be a function", name))
				return nil
			}
		}
		c.mu.Lock()
		c.callbacks = callbacks
		c.mu.Unlock()
		c.notifyOpen()
		if c.reader.setCallbacks() {
			go c.read()
		}
		return nil
	})
	c.writeRelease.release = c.writeFunc.Release
	c.setRelease.release = c.setFunc.Release
	c.closeRelease.release = c.closeFunc.Release
	c.value = newJSObject(map[string]any{
		"write":        c.writeFunc,
		"setCallbacks": c.setFunc,
		"close":        c.closeFunc,
	})
	return c
}

func (c *jsTCPConnection) read() {
	buf := make([]byte, 32<<10)
	for {
		n, err := c.conn.Read(buf)
		if n > 0 {
			data := append([]byte(nil), buf[:n]...)
			callbacks := c.callbackSnapshot()
			onData := snapshotCallback(callbacks.Get("onData"))
			c.lifecycle.deliver(func() {
				if onData.Type() == js.TypeFunction {
					onData.Invoke(jsBytes(data))
				}
			})
		}
		if err != nil {
			c.closeWithMessage(err.Error())
			return
		}
	}
}

func (c *jsTCPConnection) close() {
	c.closeWithMessage("")
}

func (c *jsTCPConnection) closeWithMessage(message string) {
	var callbacks js.Value
	c.lifecycle.closeWith(func() {
		c.reader.close()
		c.mu.Lock()
		callbacks = c.callbacks
		c.callbacks = js.Undefined()
		c.mu.Unlock()
		_ = c.conn.Close()
		releaseJSFunc(c.value, "write", &c.writeFunc, &c.writeRelease)
		releaseJSFunc(c.value, "setCallbacks", &c.setFunc, &c.setRelease)
		releaseJSFunc(c.value, "close", &c.closeFunc, &c.closeRelease)
	}, func() {
		if callbacks.Type() == js.TypeObject && callbacks.Get("onClose").Type() == js.TypeFunction {
			if message == "" {
				callbacks.Call("onClose")
			} else {
				callbacks.Call("onClose", message)
			}
		}
	})
}

func (c *jsTCPConnection) callbackSnapshot() js.Value {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.callbacks
}

func (c *jsTCPConnection) notifyOpen() {
	c.mu.Lock()
	if c.openedNotified {
		c.mu.Unlock()
		return
	}
	c.openedNotified = true
	callbacks := c.callbacks
	c.mu.Unlock()
	c.lifecycle.deliver(func() { callbacks.Call("onOpen", c.value) })
}

func (c *jsTCPConnection) startReader() {
	if c.reader.startIfReady() {
		go c.read()
	}
}

type jsUDPConnection struct {
	conn          net.Conn
	packet        net.PacketConn
	callbacks     callbackQueue[js.Value]
	lifecycle     bridgeLifecycle
	sendFunc      js.Func
	sendToFunc    js.Func
	writeFunc     js.Func
	setFunc       js.Func
	closeFunc     js.Func
	sendRelease   releaseOnce
	sendToRelease releaseOnce
	writeRelease  releaseOnce
	setRelease    releaseOnce
	closeRelease  releaseOnce
	value         js.Value
}

func newJSUDPConnection(conn net.Conn, callbacks js.Value) *jsUDPConnection {
	c := &jsUDPConnection{conn: conn}
	c.callbacks.callback = callbacks
	c.packet, _ = conn.(net.PacketConn)
	c.lifecycle.open()
	c.sendFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		c.send(args)
		return nil
	})
	c.sendToFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		c.sendTo(args)
		return nil
	})
	c.writeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		c.send(args)
		return nil
	})
	c.setFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeObject {
			c.reportError(fmt.Errorf("setCallbacks expects callbacks"))
			return nil
		}
		for _, name := range []string{"onOpen", "onData", "onClose", "onError"} {
			if args[0].Get(name).Type() != js.TypeFunction {
				c.reportError(fmt.Errorf("callbacks.%s must be a function", name))
				return nil
			}
		}
		c.callbacks.set(&c.lifecycle, args[0])
		return nil
	})
	c.closeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		c.close()
		return nil
	})
	c.sendRelease.release = c.sendFunc.Release
	c.sendToRelease.release = c.sendToFunc.Release
	c.writeRelease.release = c.writeFunc.Release
	c.setRelease.release = c.setFunc.Release
	c.closeRelease.release = c.closeFunc.Release
	c.value = newJSObject(map[string]any{
		"send":         c.sendFunc,
		"sendTo":       c.sendToFunc,
		"write":        c.writeFunc,
		"setCallbacks": c.setFunc,
		"close":        c.closeFunc,
	})
	return c
}

func (c *jsUDPConnection) send(args []js.Value) {
	if len(args) != 1 {
		c.reportError(fmt.Errorf("send expects one Uint8Array"))
		return
	}
	data, err := bytesFromJS(args[0])
	if err != nil {
		c.reportError(err)
		return
	}
	if _, err := c.conn.Write(data); err != nil {
		c.reportError(err)
	}
}

func (c *jsUDPConnection) read() {
	defer c.close()
	buf := make([]byte, 64<<10)
	for {
		n, err := c.conn.Read(buf)
		if n > 0 {
			data := append([]byte(nil), buf[:n]...)
			c.callbacks.admit(&c.lifecycle, func(callbacks js.Value) func() {
				onData := snapshotCallback(callbacks.Get("onData"))
				return func() {
					if onData.Type() == js.TypeFunction {
						onData.Invoke(jsBytes(data))
					}
				}
			})
		}
		if err != nil {
			c.reportError(err)
			return
		}
	}
}

func (c *jsUDPConnection) close() {
	c.lifecycle.closeWith(func() {
		_ = c.conn.Close()
		releaseJSFunc(c.value, "send", &c.sendFunc, &c.sendRelease)
		releaseJSFunc(c.value, "sendTo", &c.sendToFunc, &c.sendToRelease)
		releaseJSFunc(c.value, "write", &c.writeFunc, &c.writeRelease)
		releaseJSFunc(c.value, "setCallbacks", &c.setFunc, &c.setRelease)
		releaseJSFunc(c.value, "close", &c.closeFunc, &c.closeRelease)
	}, func() {
		callbacks := c.callbacks.callback
		c.callbacks.callback = js.Undefined()
		if callbacks.Type() == js.TypeObject && callbacks.Get("onClose").Type() == js.TypeFunction {
			callbacks.Call("onClose")
		}
	})
}

func (c *jsUDPConnection) reportError(err error) {
	c.callbacks.admit(&c.lifecycle, func(callbacks js.Value) func() {
		onError := snapshotCallback(callbacks.Get("onError"))
		return func() {
			if onError.Type() == js.TypeFunction {
				onError.Invoke(err.Error())
			}
		}
	})
}

func (c *jsUDPConnection) sendTo(args []js.Value) {
	if len(args) != 3 {
		c.reportError(fmt.Errorf("sendTo expects a Uint8Array, host, and port"))
		return
	}
	data, err := bytesFromJS(args[0])
	if err != nil {
		c.reportError(err)
		return
	}
	if args[1].Type() != js.TypeString {
		c.reportError(fmt.Errorf("UDP host must be an IP address"))
		return
	}
	if args[2].Type() != js.TypeNumber || !validatePort(args[2].Float(), c.reportError) {
		return
	}
	addr, err := udpAddrPort(args[1].String(), args[2].Int())
	if err != nil {
		c.reportError(err)
		return
	}
	if c.packet == nil {
		c.reportError(fmt.Errorf("sendTo is not supported by this UDP connection"))
		return
	}
	if _, err := c.packet.WriteTo(data, net.UDPAddrFromAddrPort(addr)); err != nil {
		c.reportError(err)
	}
}

type jsListener struct {
	closer       io.Closer
	callbacks    js.Value
	lifecycle    bridgeLifecycle
	closeFunc    js.Func
	closeRelease releaseOnce
	value        js.Value
}

func newJSListener(closer io.Closer, callbacks js.Value) *jsListener {
	l := &jsListener{closer: closer, callbacks: callbacks}
	l.lifecycle.open()
	l.closeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		l.close()
		return nil
	})
	l.closeRelease.release = l.closeFunc.Release
	l.value = newJSObject(map[string]any{
		"close": l.closeFunc,
	})
	return l
}

func (l *jsListener) close() {
	l.lifecycle.closeWith(func() { _ = l.closer.Close() }, func() {
		releaseJSFunc(l.value, "close", &l.closeFunc, &l.closeRelease)
		if l.callbacks.Type() == js.TypeObject && l.callbacks.Get("onClose").Type() == js.TypeFunction {
			l.callbacks.Call("onClose")
		}
	})
}

type jsUDPListener struct {
	*jsListener
	conn          net.PacketConn
	sendToFunc    js.Func
	sendToRelease releaseOnce
}

func newJSUDPListener(conn net.PacketConn, callbacks js.Value) *jsUDPListener {
	l := &jsUDPListener{jsListener: newJSListener(conn, callbacks), conn: conn}
	// Replace the base close method so UDP-specific methods are also released.
	l.closeRelease.do()
	l.closeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		l.close()
		return nil
	})
	l.closeRelease = releaseOnce{release: l.closeFunc.Release}
	l.value.Set("close", l.closeFunc)
	l.sendToFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		l.sendTo(args)
		return nil
	})
	l.sendToRelease.release = l.sendToFunc.Release
	l.value.Set("sendTo", l.sendToFunc)
	return l
}

func (l *jsUDPListener) sendTo(args []js.Value) {
	if !l.lifecycle.allowsDelivery() {
		return
	}
	if len(args) != 3 {
		l.reportError(fmt.Errorf("sendTo expects a Uint8Array, host, and port"))
		return
	}
	data, err := bytesFromJS(args[0])
	if err != nil {
		l.reportError(err)
		return
	}
	if args[1].Type() != js.TypeString {
		l.reportError(fmt.Errorf("UDP host must be an IP address"))
		return
	}
	if args[2].Type() != js.TypeNumber || !validatePort(args[2].Float(), l.reportError) {
		return
	}
	addr, err := udpAddrPort(args[1].String(), args[2].Int())
	if err != nil {
		l.reportError(err)
		return
	}
	if _, err := l.conn.WriteTo(data, net.UDPAddrFromAddrPort(addr)); err != nil {
		l.reportError(err)
	}
}

func (l *jsUDPListener) close() {
	l.lifecycle.closeWith(func() {
		_ = l.closer.Close()
		releaseJSFunc(l.value, "sendTo", &l.sendToFunc, &l.sendToRelease)
		releaseJSFunc(l.value, "close", &l.closeFunc, &l.closeRelease)
	}, func() {
		if l.callbacks.Type() == js.TypeObject && l.callbacks.Get("onClose").Type() == js.TypeFunction {
			l.callbacks.Call("onClose")
		}
	})
}

func (l *jsUDPListener) reportError(err error) {
	onError := snapshotCallback(l.callbacks.Get("onError"))
	l.lifecycle.deliverError(func() {
		if onError.Type() == js.TypeFunction {
			onError.Invoke(err.Error())
		}
	})
}

var jsIPNState = map[ipn.State]string{
	ipn.NoState:          "NoState",
	ipn.InUseOtherUser:   "InUseOtherUser",
	ipn.NeedsLogin:       "NeedsLogin",
	ipn.NeedsMachineAuth: "NeedsMachineAuth",
	ipn.Stopped:          "Stopped",
	ipn.Starting:         "Starting",
	ipn.Running:          "Running",
}

var jsMachineStatus = map[tailcfg.MachineStatus]string{
	tailcfg.MachineUnknown:      "MachineUnknown",
	tailcfg.MachineUnauthorized: "MachineUnauthorized",
	tailcfg.MachineAuthorized:   "MachineAuthorized",
	tailcfg.MachineInvalid:      "MachineInvalid",
}

func (i *jsIPN) run(jsCallbacks js.Value) {
	lastState := ipn.NoState
	notifyState := func(state ipn.State) {
		jsCallbacks.Call("notifyState", jsIPNState[state])
	}
	notifyRunning := func() {
		jsCallbacks.Call("notifyRunning")
	}
	notifyState(ipn.NoState)

	i.lb.SetNotifyCallback(func(n ipn.Notify) {
		// Panics in the notify callback are likely due to be due to bugs in
		// this bridging module (as opposed to actual bugs in Tailscale) and
		// thus may be recoverable. Let the UI know, and allow the user to
		// choose if they want to reload the page.
		defer func() {
			if r := recover(); r != nil {
				fmt.Println("Panic recovered:", r)
				jsCallbacks.Call("notifyPanicRecover", fmt.Sprint(r))
			}
		}()
		log.Printf("NOTIFY: %+v", n)
		log.Printf("NOTIFY_STATE: n.State=%+v (type=%T), hasSelfChange=%v, hasBrowseToURL=%v", n.State, n.State, n.SelfChange != nil, n.BrowseToURL != nil)
		if n.State != nil {
			stateStr := jsIPNState[*n.State]
			log.Printf("NOTIFY_STATE_SET: state=%v, str=%q, lastState=%v", *n.State, stateStr, lastState)
			lastState = *n.State
			notifyState(lastState)
			if lastState == ipn.Running {
				log.Printf("NOTIFY_RUNNING: calling notifyRunning")
				notifyRunning()
			}
		} else {
			log.Printf("NOTIFY_STATE_NIL: lastState=%v, will NOT notify JS of state change", lastState)
		}
		if n.SelfChange != nil {
			// Self changed: rebuild the JS-side NetMap snapshot. Peers
			// don't ride on the bus anymore, so fetch them on demand
			// from LocalBackend.
			nm := i.lb.NetMapWithPeers()
			if nm != nil {
				jsNetMap := jsNetMap{
					Self: jsNetMapSelfNode{
						jsNetMapNode: jsNetMapNode{
							Name:       nm.SelfName(),
							Addresses:  mapSliceView(nm.GetAddresses(), func(a netip.Prefix) string { return a.Addr().String() }),
							NodeKey:    nm.NodeKey.String(),
							MachineKey: nm.MachineKey.String(),
						},
						MachineStatus: jsMachineStatus[nm.GetMachineStatus()],
					},
					Peers: mapSlice(nm.Peers, func(p tailcfg.NodeView) jsNetMapPeerNode {
						name := p.Name()
						if name == "" {
							// In practice this should only happen for Hello.
							name = p.Hostinfo().Hostname()
						}
						addrs := make([]string, p.Addresses().Len())
						for i, ap := range p.Addresses().All() {
							addrs[i] = ap.Addr().String()
						}
						return jsNetMapPeerNode{
							jsNetMapNode: jsNetMapNode{
								Name:       name,
								Addresses:  addrs,
								MachineKey: p.Machine().String(),
								NodeKey:    p.Key().String(),
							},
							Online:              p.Online().Clone(),
							TailscaleSSHEnabled: p.Hostinfo().TailscaleSSHEnabled(),
						}
					}),
					LockedOut: nm.TKAEnabled && nm.SelfNode.KeySignature().Len() == 0,
				}
				if jsonNetMap, err := json.Marshal(jsNetMap); err == nil {
					jsCallbacks.Call("notifyNetMap", string(jsonNetMap))
				} else {
					log.Printf("Could not generate JSON netmap: %v", err)
				}
			}
		}
		if n.BrowseToURL != nil {
			jsCallbacks.Call("notifyBrowseToURL", *n.BrowseToURL)
		}
	})

	go func() {
		err := i.lb.Start(ipn.Options{
			UpdatePrefs: &ipn.Prefs{
				ControlURL:  i.controlURL,
				RouteAll:    false,
				WantRunning: true,
				Hostname:    i.hostname,
			},
			AuthKey: i.authKey,
		})
		if err != nil {
			log.Printf("Start error: %v", err)
		}
	}()

	go func() {
		ln, err := safesocket.Listen("")
		if err != nil {
			log.Fatalf("safesocket.Listen: %v", err)
		}

		err = i.srv.Run(context.Background(), ln)
		log.Fatalf("ipnserver.Run exited: %v", err)
	}()
}

func (i *jsIPN) login() {
	go i.lb.StartLoginInteractive(context.Background())
}

func (i *jsIPN) logout() {
	if i.lb.State() == ipn.NoState {
		log.Printf("Backend not running")
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		i.lb.Logout(ctx, ipnauth.Self)
	}()
}

func (i *jsIPN) listExitNodes() []jsExitNode {
	nm := i.lb.NetMapWithPeers()
	if nm == nil {
		return nil
	}
	return exitNodesForPeers(nm.Peers)
}

func (i *jsIPN) setExitNode(args []js.Value) js.Value {
	if len(args) < 1 || len(args) > 2 || args[0].Type() != js.TypeString || args[0].String() == "" {
		return makePromise(func() (any, error) { return nil, fmt.Errorf("setExitNode expects a non-empty stable node ID") })
	}
	var allowLANAccess *bool
	if len(args) == 2 && args[1].Type() == js.TypeObject && !args[1].IsNull() {
		if !args[1].Get("allowLANAccess").IsUndefined() && args[1].Get("allowLANAccess").Type() != js.TypeBoolean {
			return makePromise(func() (any, error) { return nil, fmt.Errorf("setExitNode options.allowLANAccess must be a boolean") })
		}
		if value := args[1].Get("allowLANAccess"); value.Type() == js.TypeBoolean {
			value := value.Bool()
			allowLANAccess = &value
		}
	}
	id := tailcfg.StableNodeID(args[0].String())
	return makePromise(func() (any, error) {
		exitNodes := i.listExitNodes()
		log.Printf("setExitNode: looking for id=%q in %d exit nodes", string(id), len(exitNodes))
		for _, exitNode := range exitNodes {
			if exitNode.ID == string(id) {
				log.Printf("setExitNode: found node %q, calling EditPrefs", exitNode.Name)
				_, err := i.lb.EditPrefs(exitNodePrefs(id, allowLANAccess))
				if err != nil {
					log.Printf("setExitNode: EditPrefs error: %v", err)
				}
				return nil, err
			}
		}
		log.Printf("setExitNode: exit node %q not found in listExitNodes", string(id))
		for _, en := range exitNodes {
			log.Printf("setExitNode: available: id=%q name=%q", en.ID, en.Name)
		}
		return nil, fmt.Errorf("exit node %q is not eligible", id)
	})
}

func (i *jsIPN) clearExitNode() js.Value {
	return makePromise(func() (any, error) {
		_, err := i.lb.EditPrefs(clearExitNodePrefs())
		return nil, err
	})
}

func (i *jsIPN) exitNode() map[string]any {
	prefs := i.lb.Prefs()
	return map[string]any{
		"id":             string(prefs.ExitNodeID()),
		"routeAll":       prefs.RouteAll(),
		"allowLANAccess": prefs.ExitNodeAllowLANAccess(),
	}
}

func (i *jsIPN) setFunnel(port int, target string) js.Value {
	return makePromise(func() (any, error) {
		host, portStr, err := net.SplitHostPort(target)
		if err != nil {
			return nil, fmt.Errorf("invalid target %q: %w", target, err)
		}

		nm := i.lb.NetMapWithPeers()
		if nm == nil {
			return nil, fmt.Errorf("no netmap available")
		}

		// Resolve loopback to the node's own Tailscale IP so dials route
		// through netstack (not the OS dialer) to reach bridge listeners.
		if host == "127.0.0.1" || host == "localhost" {
			for _, pfx := range nm.GetAddresses().All() {
				if pfx.IsSingleIP() && pfx.Addr().Is4() {
					host = pfx.Addr().String()
					break
				}
			}
			resolvedTarget := net.JoinHostPort(host, portStr)
			log.Printf("setFunnel: resolved loopback -> %s", resolvedTarget)
			target = resolvedTarget
		}

		resolvedTarget := target
		if net.ParseIP(host) == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			conn, err := i.dialer.UserDial(ctx, "tcp", net.JoinHostPort(host, portStr))
			if err != nil {
				return nil, fmt.Errorf("cannot resolve %q: %w", host, err)
			}
			resolvedIP := conn.RemoteAddr().(*net.TCPAddr).IP.String()
			conn.Close()
			resolvedTarget = net.JoinHostPort(resolvedIP, portStr)
			log.Printf("setFunnel: resolved %q -> %s", target, resolvedTarget)
		}

		hostname := strings.TrimSuffix(nm.SelfName(), ".")

		// Funnel only works on 443/8443 via the serve proxy.
		// For all other ports, register a netstack listener directly
		// (avoids the serve proxy's SystemDial which can't reach netstack).
		if port == 443 || port == 8443 {
			config := &ipn.ServeConfig{
				TCP: map[uint16]*ipn.TCPPortHandler{
					uint16(port): {
						TCPForward: resolvedTarget,
					},
				},
				AllowFunnel: map[ipn.HostPort]bool{
					ipn.HostPort(fmt.Sprintf("%s:%d", hostname, port)): true,
				},
			}
			if err := i.lb.SetServeConfig(config, ""); err != nil {
				return nil, err
			}
			log.Printf("Funnel enabled: %s -> %s", hostname, resolvedTarget)
			return nil, nil
		}

		// Non-Funnel port: register a netstack TCP listener that pipes
		// incoming connections to the target via UserDial (through netstack).
		if existing, ok := i.listeners[port]; ok {
			existing.Close()
		}
		listener, err := i.ns.ListenTCP("tcp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
		if err != nil {
			return nil, fmt.Errorf("listen on port %d: %w", port, err)
		}
		i.listeners[port] = listener
		log.Printf("Serve enabled: port %d -> %s (via netstack listener)", port, resolvedTarget)

		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				go func(incoming net.Conn) {
					defer incoming.Close()
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					outgoing, err := i.dialer.UserDial(ctx, "tcp", resolvedTarget)
					if err != nil {
						log.Printf("pipe %d: dial target %s: %v", port, resolvedTarget, err)
						return
					}
					defer outgoing.Close()
					pipeConns(incoming, outgoing)
				}(conn)
			}
		}()
		return nil, nil
	})
}

func (i *jsIPN) clearFunnel() js.Value {
	return makePromise(func() (any, error) {
		// Close any netstack listeners for non-Funnel serve ports.
		for port, l := range i.listeners {
			l.Close()
			delete(i.listeners, port)
			log.Printf("Serve disabled: port %d", port)
		}
		if err := i.lb.SetServeConfig(&ipn.ServeConfig{}, ""); err != nil {
			return nil, err
		}
		log.Printf("Funnel disabled")
		return nil, nil
	})
}

func pipeConns(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { io.Copy(a, b); a.Close(); b.Close(); wg.Done() }()
	go func() { io.Copy(b, a); b.Close(); a.Close(); wg.Done() }()
	wg.Wait()
}

func (i *jsIPN) resolveDNS(host string, port int) js.Value {
	return makePromise(func() (any, error) {
		if net.ParseIP(host) != nil {
			return host, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		conn, err := i.dialer.UserDial(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			return nil, fmt.Errorf("cannot resolve %q: %w", host, err)
		}
		defer conn.Close()
		resolvedIP := conn.RemoteAddr().(*net.TCPAddr).IP.String()
		log.Printf("resolveDNS: %q -> %s", host, resolvedIP)
		return resolvedIP, nil
	})
}

func (i *jsIPN) ssh(host, username string, termConfig js.Value) map[string]any {
	jsSSHSession := &jsSSHSession{
		jsIPN:      i,
		host:       host,
		username:   username,
		termConfig: termConfig,
	}

	go jsSSHSession.Run()

	return map[string]any{
		"close": js.FuncOf(func(this js.Value, args []js.Value) any {
			return jsSSHSession.Close() != nil
		}),
		"resize": js.FuncOf(func(this js.Value, args []js.Value) any {
			rows := args[0].Int()
			cols := args[1].Int()
			return jsSSHSession.Resize(rows, cols) != nil
		}),
	}
}

type jsSSHSession struct {
	jsIPN      *jsIPN
	host       string
	username   string
	termConfig js.Value
	session    *ssh.Session

	pendingResizeRows int
	pendingResizeCols int
}

func (s *jsSSHSession) Run() {
	writeFn := s.termConfig.Get("writeFn")
	writeErrorFn := s.termConfig.Get("writeErrorFn")
	setReadFn := s.termConfig.Get("setReadFn")
	rows := s.termConfig.Get("rows").Int()
	cols := s.termConfig.Get("cols").Int()
	timeoutSeconds := 5.0
	if jsTimeoutSeconds := s.termConfig.Get("timeoutSeconds"); jsTimeoutSeconds.Type() == js.TypeNumber {
		timeoutSeconds = jsTimeoutSeconds.Float()
	}
	onConnectionProgress := s.termConfig.Get("onConnectionProgress")
	onConnected := s.termConfig.Get("onConnected")
	onDone := s.termConfig.Get("onDone")
	defer onDone.Invoke()

	writeError := func(label string, err error) {
		writeErrorFn.Invoke(fmt.Sprintf("%s Error: %v\r\n", label, err))
	}
	reportProgress := func(message string) {
		onConnectionProgress.Invoke(message)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds*float64(time.Second)))
	defer cancel()
	reportProgress(fmt.Sprintf("Connecting to %s…", strings.Split(s.host, ".")[0]))
	c, err := s.jsIPN.dialer.UserDial(ctx, "tcp", net.JoinHostPort(s.host, "22"))
	if err != nil {
		writeError("Dial", err)
		return
	}
	defer c.Close()

	config := &ssh.ClientConfig{
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			// Host keys are not used with Tailscale SSH, but we can use this
			// callback to know that the connection has been established.
			reportProgress("SSH connection established…")
			return nil
		},
		User: s.username,
	}

	reportProgress("Starting SSH client…")
	sshConn, _, _, err := ssh.NewClientConn(c, s.host, config)
	if err != nil {
		writeError("SSH Connection", err)
		return
	}
	defer sshConn.Close()

	sshClient := ssh.NewClient(sshConn, nil, nil)
	defer sshClient.Close()

	session, err := sshClient.NewSession()
	if err != nil {
		writeError("SSH Session", err)
		return
	}
	s.session = session
	defer session.Close()

	stdin, err := session.StdinPipe()
	if err != nil {
		writeError("SSH Stdin", err)
		return
	}

	session.Stdout = termWriter{writeFn}
	session.Stderr = termWriter{writeFn}

	setReadFn.Invoke(js.FuncOf(func(this js.Value, args []js.Value) any {
		input := args[0].String()
		_, err := stdin.Write([]byte(input))
		if err != nil {
			writeError("Write Input", err)
		}
		return nil
	}))

	// We might have gotten a resize notification since we started opening the
	// session, pick up the latest size.
	if s.pendingResizeRows != 0 {
		rows = s.pendingResizeRows
	}
	if s.pendingResizeCols != 0 {
		cols = s.pendingResizeCols
	}
	err = session.RequestPty("xterm", rows, cols, ssh.TerminalModes{})
	if err != nil {
		writeError("Pseudo Terminal", err)
		return
	}

	err = session.Shell()
	if err != nil {
		writeError("Shell", err)
		return
	}

	onConnected.Invoke()
	err = session.Wait()
	if err != nil {
		writeError("Wait", err)
		return
	}
}

func (s *jsSSHSession) Close() error {
	if s.session == nil {
		// We never had a chance to open the session, ignore the close request.
		return nil
	}
	return s.session.Close()
}

func (s *jsSSHSession) Resize(rows, cols int) error {
	if s.session == nil {
		s.pendingResizeRows = rows
		s.pendingResizeCols = cols
		return nil
	}
	return s.session.WindowChange(rows, cols)
}

func (i *jsIPN) fetch(url string) js.Value {
	return makePromise(func() (any, error) {
		c := &http.Client{
			Transport: &http.Transport{
				DialContext: i.dialer.UserDial,
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		}
		res, err := c.Get(url)
		if err != nil {
			return nil, err
		}

		return map[string]any{
			"status":     res.StatusCode,
			"statusText": res.Status,
			"text": js.FuncOf(func(this js.Value, args []js.Value) any {
				return makePromise(func() (any, error) {
					defer res.Body.Close()
					buf := new(bytes.Buffer)
					if _, err := buf.ReadFrom(res.Body); err != nil {
						return nil, err
					}
					return buf.String(), nil
				})
			}),
			// TODO: populate a more complete JS Response object
		}, nil
	})
}

type termWriter struct {
	f js.Value
}

func (w termWriter) Write(p []byte) (n int, err error) {
	r := bytes.Replace(p, []byte("\n"), []byte("\n\r"), -1)
	w.f.Invoke(string(r))
	return len(p), nil
}

type jsNetMap struct {
	Self      jsNetMapSelfNode   `json:"self"`
	Peers     []jsNetMapPeerNode `json:"peers"`
	LockedOut bool               `json:"lockedOut"`
}

type jsNetMapNode struct {
	Name       string   `json:"name"`
	Addresses  []string `json:"addresses"`
	MachineKey string   `json:"machineKey"`
	NodeKey    string   `json:"nodeKey"`
}

type jsNetMapSelfNode struct {
	jsNetMapNode
	MachineStatus string `json:"machineStatus"`
}

type jsNetMapPeerNode struct {
	jsNetMapNode
	Online              *bool `json:"online,omitempty"`
	TailscaleSSHEnabled bool  `json:"tailscaleSSHEnabled"`
}

type jsStateStore struct {
	jsStateStorage js.Value
}

func (s *jsStateStore) ReadState(id ipn.StateKey) ([]byte, error) {
	jsValue := s.jsStateStorage.Call("getState", string(id))
	if jsValue.String() == "" {
		return nil, ipn.ErrStateNotExist
	}
	return hex.DecodeString(jsValue.String())
}

func (s *jsStateStore) WriteState(id ipn.StateKey, bs []byte) error {
	s.jsStateStorage.Call("setState", string(id), hex.EncodeToString(bs))
	return nil
}

func mapSlice[T any, M any](a []T, f func(T) M) []M {
	n := make([]M, len(a))
	for i, e := range a {
		n[i] = f(e)
	}
	return n
}

func mapSliceView[T any, M any](a views.Slice[T], f func(T) M) []M {
	n := make([]M, a.Len())
	for i, v := range a.All() {
		n[i] = f(v)
	}
	return n
}

// makePromise handles the boilerplate of wrapping goroutines with JS promises.
// f is run on a goroutine and its return value is used to resolve the promise
// (or reject it if an error is returned).
func makePromise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve := args[0]
		reject := args[1]
		go func() {
			if res, err := f(); err == nil {
				resolve.Invoke(res)
			} else {
				reject.Invoke(err.Error())
			}
		}()
		return nil
	})

	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.New(handler)
}
