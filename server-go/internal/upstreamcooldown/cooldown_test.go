package upstreamcooldown

import (
	"context"
	"testing"
	"time"
)

func TestParseBodyAndExtractRequestModel(t *testing.T) {
	body := []byte(`{"error":{"code":"model_cooldown","message":"All credentials are cooling down","model":"gpt-image-2","provider":"codex","reset_seconds":0.65}}`)
	info := ParseBody(body)
	if info == nil {
		t.Fatal("expected cooldown info")
	}
	if info.Model != "gpt-image-2" || info.Provider != "codex" {
		t.Fatalf("unexpected info: %+v", info)
	}
	if info.Delay < 600*time.Millisecond || info.Delay > 700*time.Millisecond {
		t.Fatalf("delay=%s want around 650ms", info.Delay)
	}

	if got := ExtractRequestModel("application/json", []byte(`{"model":"gpt-image-2","prompt":"x"}`)); got != "gpt-image-2" {
		t.Fatalf("json model=%q", got)
	}
}

func TestGateWaitsUntilCooldownExpires(t *testing.T) {
	gate := NewGate()
	gate.Set("gpt-image-2", 20*time.Millisecond)
	start := time.Now()
	if _, err := gate.Wait(context.Background(), "gpt-image-2"); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 15*time.Millisecond {
		t.Fatalf("waited only %s", elapsed)
	}
}
