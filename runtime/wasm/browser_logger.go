// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import "log"

type browserLogConfig struct {
	Logf func(string, ...any)
}

func newBrowserLogConfig() browserLogConfig {
	return browserLogConfig{Logf: log.Printf}
}
