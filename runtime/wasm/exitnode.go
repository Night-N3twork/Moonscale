// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"fmt"
	"math/rand/v2"
	"strings"

	"tailscale.com/ipn"
	"tailscale.com/net/tsaddr"
	"tailscale.com/tailcfg"
	"tailscale.com/words"
)

type jsExitNode struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
	Online    *bool    `json:"online,omitempty"`
}

// jsExitNodes converts Go-only types into values accepted by syscall/js.ValueOf.
func jsExitNodes(nodes []jsExitNode) []any {
	result := make([]any, len(nodes))
	for index, node := range nodes {
		addresses := make([]any, len(node.Addresses))
		for addressIndex, address := range node.Addresses {
			addresses[addressIndex] = address
		}
		value := map[string]any{
			"id":        node.ID,
			"name":      node.Name,
			"addresses": addresses,
		}
		if node.Online != nil {
			value["online"] = *node.Online
		}
		result[index] = value
	}
	return result
}

func defaultHostname() string {
	return "Moonbeam-" + generateHostname()
}

func exitNodesForPeers(peers []tailcfg.NodeView) []jsExitNode {
	var exitNodes []jsExitNode
	for _, peer := range peers {
		if !peer.AllowedIPs().ContainsFunc(tsaddr.IsExitRoute) {
			continue
		}
		addresses := make([]string, 0, peer.Addresses().Len())
		for _, prefix := range peer.Addresses().All() {
			addresses = append(addresses, prefix.Addr().String())
		}
		exitNodes = append(exitNodes, jsExitNode{
			ID:        string(peer.StableID()),
			Name:      peer.Name(),
			Addresses: addresses,
			Online:    peer.Online().Clone(),
		})
	}
	return exitNodes
}

func exitNodePrefs(id tailcfg.StableNodeID, allowLANAccess *bool) *ipn.MaskedPrefs {
	prefs := &ipn.MaskedPrefs{
		RouteAllSet:   true,
		ExitNodeIDSet: true,
		Prefs: ipn.Prefs{
			RouteAll:   true,
			ExitNodeID: id,
		},
	}
	if allowLANAccess != nil {
		prefs.ExitNodeAllowLANAccessSet = true
		prefs.ExitNodeAllowLANAccess = *allowLANAccess
	}
	return prefs
}

func clearExitNodePrefs() *ipn.MaskedPrefs {
	return &ipn.MaskedPrefs{
		RouteAllSet:   true,
		ExitNodeIDSet: true,
	}
}

func generateHostname() string {
	tails := words.Tails()
	scales := words.Scales()
	if rand.IntN(2) == 0 {
		tails = filterSlice(tails, func(s string) bool { return strings.HasPrefix(s, "j") })
		scales = filterSlice(scales, func(s string) bool { return strings.HasPrefix(s, "s") })
	} else {
		tails = filterSlice(tails, func(s string) bool { return strings.HasPrefix(s, "w") })
		scales = filterSlice(scales, func(s string) bool { return strings.HasPrefix(s, "a") })
	}
	return fmt.Sprintf("%s-%s", tails[rand.IntN(len(tails))], scales[rand.IntN(len(scales))])
}

func filterSlice[T any](a []T, f func(T) bool) []T {
	n := make([]T, 0, len(a))
	for _, e := range a {
		if f(e) {
			n = append(n, e)
		}
	}
	return n
}
