// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"fmt"
	"math"
	"net/netip"
	"sync"
)

func validatePort(port float64, report func(error)) bool {
	if math.Trunc(port) == port && port >= 1 && port <= 65535 {
		return true
	}
	report(fmt.Errorf("port must be an integer from 1 through 65535"))
	return false
}

func udpAddrPort(host string, port int) (netip.AddrPort, error) {
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("UDP host must be an IP address: %w", err)
	}
	if port < 1 || port > 65535 {
		return netip.AddrPort{}, fmt.Errorf("port must be an integer from 1 through 65535")
	}
	return netip.AddrPortFrom(addr, uint16(port)), nil
}

// bridgeLifecycle coordinates the transition from a pending dial to an open
// connection and prevents callbacks after the associated handle is closed.
type bridgeLifecycle struct {
	mu      sync.Mutex
	closed  bool
	opened  bool
	running bool
	queue   []func()
}

func (l *bridgeLifecycle) open() bool {
	return l.openAnd(nil)
}

func (l *bridgeLifecycle) openAnd(fn func()) bool {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return false
	}
	l.opened = true
	l.mu.Unlock()
	if fn != nil {
		fn()
	}
	return true
}

// close reports whether this is the first close and whether it cancelled a
// dial that had not opened yet.
func (l *bridgeLifecycle) close() (first, pending bool) {
	return l.closeWith(nil, nil)
}

func (l *bridgeLifecycle) closeAnd(fn func()) (first, pending bool) {
	return l.closeWith(nil, fn)
}

// closeWith stops new delivery, runs cleanup immediately, and queues the close
// callback after all callbacks admitted before close. It never waits for an
// active callback, so callbacks may synchronously close their own handle.
func (l *bridgeLifecycle) closeWith(cleanup, callback func()) (first, pending bool) {
	if callback == nil {
		return l.closeWithEvents(cleanup)
	}
	return l.closeWithEvents(cleanup, callback)
}

// closeWithEvents serializes terminal events after work admitted before close.
func (l *bridgeLifecycle) closeWithEvents(cleanup func(), events ...func()) (first, pending bool) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return false, false
	}
	l.closed = true
	pending = !l.opened
	l.mu.Unlock()
	if cleanup != nil {
		cleanup()
	}
	if len(events) == 0 {
		return true, pending
	}
	l.mu.Lock()
	l.queue = append(l.queue, events...)
	run := !l.running
	if run {
		l.running = true
	}
	l.mu.Unlock()
	if run {
		l.drain()
	}
	return true, pending
}

func snapshotCallback[T any](callback T) T { return callback }

// callbackQueue keeps callback replacement and callback delivery in one
// lifecycle queue. Its callback is accessed only by queued events.
type callbackQueue[T any] struct {
	callback T
}

func (q *callbackQueue[T]) set(lifecycle *bridgeLifecycle, callback T) bool {
	return lifecycle.deliver(func() { q.callback = callback })
}

func (q *callbackQueue[T]) admit(lifecycle *bridgeLifecycle, makeEvent func(T) func()) bool {
	return lifecycle.deliver(func() { makeEvent(snapshotCallback(q.callback))() })
}

type releaseOnce struct {
	once    sync.Once
	release func()
}

func (r *releaseOnce) do() {
	r.once.Do(func() {
		if r.release != nil {
			r.release()
		}
	})
}

// closePending invokes fn only when closing before an open transition.
func (l *bridgeLifecycle) closePending(fn func()) (first, pending bool) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return false, false
	}
	l.closed = true
	pending = !l.opened
	l.queue = nil
	l.mu.Unlock()
	if pending && fn != nil {
		fn()
	}
	return true, pending
}

// deliver invokes fn only while the handle remains open. The callback runs
// without lifecycle locks so it may synchronously close its own handle.
func (l *bridgeLifecycle) deliver(fn func()) bool {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return false
	}
	l.queue = append(l.queue, fn)
	run := !l.running
	if run {
		l.running = true
	}
	l.mu.Unlock()
	if run {
		l.drain()
	}
	return true
}

// deliverError gives dial failures the same close-aware serial delivery as
// normal connection callbacks.
func (l *bridgeLifecycle) deliverError(fn func()) bool {
	return l.deliver(fn)
}

func (l *bridgeLifecycle) drain() {
	for {
		l.mu.Lock()
		if len(l.queue) == 0 {
			l.running = false
			l.mu.Unlock()
			return
		}
		fn := l.queue[0]
		l.queue = l.queue[1:]
		l.mu.Unlock()
		fn()
	}
}

func (l *bridgeLifecycle) allowsDelivery() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.closed
}

func (l *bridgeLifecycle) isClosed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}

// readerGate makes accepted connections inert until their callbacks are
// attached, while letting close win before a reader is started.
type readerGate struct {
	mu        sync.Mutex
	callbacks bool
	started   bool
	closed    bool
}

func (g *readerGate) startIfReady() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || !g.callbacks || g.started {
		return false
	}
	g.started = true
	return true
}

func (g *readerGate) setCallbacks() bool {
	g.attachCallbacks()
	return g.startIfReady()
}

func (g *readerGate) attachCallbacks() {
	g.mu.Lock()
	g.callbacks = true
	g.mu.Unlock()
}

func (g *readerGate) close() {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
}
