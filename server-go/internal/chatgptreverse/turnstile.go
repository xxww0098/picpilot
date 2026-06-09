package chatgptreverse

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"time"
)

type orderedMap struct {
	keys   []string
	values map[string]any
}

func newOrderedMap() *orderedMap {
	return &orderedMap{values: map[string]any{}}
}

func (m *orderedMap) add(key string, value any) {
	if _, ok := m.values[key]; !ok {
		m.keys = append(m.keys, key)
	}
	m.values[key] = value
}

type turnstileFunc func(args ...any)

func solveTurnstileToken(dx, key string) string {
	if strings.TrimSpace(dx) == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(dx)
	if err != nil {
		return ""
	}
	var program []any
	if err := json.Unmarshal([]byte(xorString(string(decoded), key)), &program); err != nil {
		return ""
	}
	process := map[float64]any{}
	result := ""
	start := time.Now()

	process[1] = turnstileFunc(func(args ...any) {
		e, t, ok := twoNums(args)
		if !ok {
			return
		}
		process[e] = xorString(turnstileToString(process[e]), turnstileToString(process[t]))
	})
	process[2] = turnstileFunc(func(args ...any) {
		if len(args) < 2 {
			return
		}
		e, ok := numberArg(args[0])
		if !ok {
			return
		}
		process[e] = args[1]
	})
	process[3] = turnstileFunc(func(args ...any) {
		if len(args) == 0 {
			return
		}
		result = base64.StdEncoding.EncodeToString([]byte(turnstileToString(args[0])))
	})
	process[5] = turnstileFunc(func(args ...any) {
		e, t, ok := twoNums(args)
		if !ok {
			return
		}
		current := process[e]
		incoming := process[t]
		if list, ok := current.([]any); ok {
			process[e] = append(list, incoming)
			return
		}
		if _, ok := current.(string); ok {
			process[e] = turnstileToString(current) + turnstileToString(incoming)
			return
		}
		if _, ok := current.(float64); ok {
			process[e] = turnstileToString(current) + turnstileToString(incoming)
			return
		}
		if _, ok := incoming.(string); ok {
			process[e] = turnstileToString(current) + turnstileToString(incoming)
			return
		}
		if _, ok := incoming.(float64); ok {
			process[e] = turnstileToString(current) + turnstileToString(incoming)
			return
		}
		process[e] = "NaN"
	})
	process[6] = turnstileFunc(func(args ...any) {
		e, t, n, ok := threeNums(args)
		if !ok {
			return
		}
		tv, tok := process[t].(string)
		nv, nok := process[n].(string)
		if !tok || !nok {
			return
		}
		value := tv + "." + nv
		if value == "window.document.location" {
			process[e] = "https://chatgpt.com/"
		} else {
			process[e] = value
		}
	})
	process[7] = turnstileFunc(func(args ...any) {
		if len(args) < 1 {
			return
		}
		e, ok := numberArg(args[0])
		if !ok {
			return
		}
		target := process[e]
		values := make([]any, 0, len(args)-1)
		for _, arg := range args[1:] {
			if k, ok := numberArg(arg); ok {
				values = append(values, process[k])
			}
		}
		if target == "window.Reflect.set" && len(values) >= 3 {
			if obj, ok := values[0].(*orderedMap); ok {
				obj.add(turnstileToString(values[1]), values[2])
			}
			return
		}
		if fn, ok := target.(turnstileFunc); ok {
			fn(values...)
		}
	})
	process[8] = turnstileFunc(func(args ...any) {
		e, t, ok := twoNums(args)
		if !ok {
			return
		}
		process[e] = process[t]
	})
	process[9] = program
	process[10] = "window"
	process[14] = turnstileFunc(func(args ...any) {
		e, t, ok := twoNums(args)
		if !ok {
			return
		}
		text, ok := process[t].(string)
		if !ok {
			return
		}
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			process[e] = parsed
		}
	})
	process[15] = turnstileFunc(func(args ...any) {
		e, t, ok := twoNums(args)
		if !ok {
			return
		}
		body, err := json.Marshal(process[t])
		if err == nil {
			process[e] = string(body)
		}
	})
	process[16] = key
	process[17] = turnstileFunc(func(args ...any) {
		if len(args) < 2 {
			return
		}
		e, t, ok := twoNums(args)
		if !ok {
			return
		}
		var callArgs []any
		for _, arg := range args[2:] {
			if k, ok := numberArg(arg); ok {
				callArgs = append(callArgs, process[k])
			}
		}
		switch target := process[t]; target {
		case "window.performance.now":
			process[e] = float64(time.Since(start).Nanoseconds())/1e6 + rand.Float64()
		case "window.Object.create":
			process[e] = newOrderedMap()
		case "window.Object.keys":
			if len(callArgs) > 0 && callArgs[0] == "window.localStorage" {
				process[e] = []any{
					"STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4",
					"STATSIG_LOCAL_STORAGE_STABLE_ID",
					"client-correlated-secret",
					"oai/apps/capExpiresAt",
					"oai-did",
					"STATSIG_LOCAL_STORAGE_LOGGING_REQUEST",
					"UiState.isNavigationCollapsed.1",
				}
			}
		case "window.Math.random":
			process[e] = rand.Float64()
		default:
			if fn, ok := target.(turnstileFunc); ok {
				fn(callArgs...)
			}
		}
	})
	process[18] = turnstileFunc(func(args ...any) {
		if len(args) < 1 {
			return
		}
		e, ok := numberArg(args[0])
		if !ok {
			return
		}
		body, err := base64.StdEncoding.DecodeString(turnstileToString(process[e]))
		if err == nil {
			process[e] = string(body)
		}
	})
	process[19] = turnstileFunc(func(args ...any) {
		if len(args) < 1 {
			return
		}
		e, ok := numberArg(args[0])
		if !ok {
			return
		}
		process[e] = base64.StdEncoding.EncodeToString([]byte(turnstileToString(process[e])))
	})
	process[20] = turnstileFunc(func(args ...any) {
		if len(args) < 3 {
			return
		}
		e, t, n, ok := threeNums(args)
		if !ok || process[e] != process[t] {
			return
		}
		fn, ok := process[n].(turnstileFunc)
		if !ok {
			return
		}
		var values []any
		for _, arg := range args[3:] {
			if k, ok := numberArg(arg); ok {
				values = append(values, process[k])
			}
		}
		fn(values...)
	})
	process[21] = turnstileFunc(func(args ...any) {})
	process[23] = turnstileFunc(func(args ...any) {
		if len(args) < 2 {
			return
		}
		e, t, ok := twoNums(args)
		if !ok || process[e] == nil {
			return
		}
		if fn, ok := process[t].(turnstileFunc); ok {
			fn(args[2:]...)
		}
	})
	process[24] = turnstileFunc(func(args ...any) {
		e, t, n, ok := threeNums(args)
		if !ok {
			return
		}
		tv, tok := process[t].(string)
		nv, nok := process[n].(string)
		if tok && nok {
			process[e] = tv + "." + nv
		}
	})

	current := program
	for i := 0; i < 6 && result == ""; i++ {
		for _, item := range current {
			token, ok := item.([]any)
			if !ok || len(token) == 0 {
				continue
			}
			op, ok := numberArg(token[0])
			if !ok {
				continue
			}
			fn, ok := process[op].(turnstileFunc)
			if !ok {
				continue
			}
			func() {
				defer func() { _ = recover() }()
				fn(token[1:]...)
			}()
		}
		next, ok := process[9].([]any)
		if !ok || len(next) == len(current) {
			break
		}
		current = next
	}
	return result
}

func turnstileToString(value any) string {
	switch v := value.(type) {
	case nil:
		return "undefined"
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case string:
		switch v {
		case "window.Math":
			return "[object Math]"
		case "window.Reflect":
			return "[object Reflect]"
		case "window.performance":
			return "[object Performance]"
		case "window.localStorage":
			return "[object Storage]"
		case "window.Object":
			return "function Object() { [native code] }"
		case "window.Reflect.set":
			return "function set() { [native code] }"
		case "window.performance.now":
			return "function () { [native code] }"
		case "window.Object.create":
			return "function create() { [native code] }"
		case "window.Object.keys":
			return "function keys() { [native code] }"
		case "window.Math.random":
			return "function random() { [native code] }"
		default:
			return v
		}
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				return fmt.Sprint(value)
			}
			parts = append(parts, s)
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(value)
	}
}

func xorString(text, key string) string {
	if key == "" {
		return text
	}
	var out strings.Builder
	out.Grow(len(text))
	for i, r := range text {
		out.WriteRune(rune(byte(r) ^ key[i%len(key)]))
	}
	return out.String()
}

func numberArg(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func twoNums(args []any) (float64, float64, bool) {
	if len(args) < 2 {
		return 0, 0, false
	}
	a, ok := numberArg(args[0])
	if !ok {
		return 0, 0, false
	}
	b, ok := numberArg(args[1])
	if !ok {
		return 0, 0, false
	}
	return a, b, true
}

func threeNums(args []any) (float64, float64, float64, bool) {
	if len(args) < 3 {
		return 0, 0, 0, false
	}
	a, b, ok := twoNums(args)
	if !ok {
		return 0, 0, 0, false
	}
	c, ok := numberArg(args[2])
	if !ok {
		return 0, 0, 0, false
	}
	return a, b, c, true
}
