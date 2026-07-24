// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"reflect"
	"testing"
)

func TestJSExitNodesUsesHostConvertibleValues(t *testing.T) {
	online := true
	got := jsExitNodes([]jsExitNode{{
		ID:        "exit-1",
		Name:      "exit.tailnet.ts.net.",
		Addresses: []string{"100.64.0.2", "fd7a:115c:a1e0::2"},
		Online:    &online,
	}})
	want := []any{map[string]any{
		"id":        "exit-1",
		"name":      "exit.tailnet.ts.net.",
		"addresses": []any{"100.64.0.2", "fd7a:115c:a1e0::2"},
		"online":    true,
	}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("jsExitNodes() = %#v, want %#v", got, want)
	}
}
