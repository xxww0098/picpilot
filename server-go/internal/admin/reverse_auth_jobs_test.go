package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
)

type selectiveReverseAuthChecker struct {
	results []chatgptreverse.AuthCheckResult
	names   []string
}

type nilReverseAuthChecker struct{}

func (nilReverseAuthChecker) CheckAuthAccounts(context.Context) ([]chatgptreverse.AuthCheckResult, error) {
	return nil, nil
}

func (c *selectiveReverseAuthChecker) CheckAuthAccounts(ctx context.Context) ([]chatgptreverse.AuthCheckResult, error) {
	return c.CheckAuthAccountsWithProgress(ctx, func(chatgptreverse.AuthCheckResult) {})
}

func (c *selectiveReverseAuthChecker) CountAuthAccounts(context.Context) (int, error) {
	return len(c.results), nil
}

func (c *selectiveReverseAuthChecker) CheckAuthAccountsWithProgress(ctx context.Context, onResult func(chatgptreverse.AuthCheckResult)) ([]chatgptreverse.AuthCheckResult, error) {
	return c.CheckAuthAccountsByNameWithProgress(ctx, nil, onResult)
}

func (c *selectiveReverseAuthChecker) CheckAuthAccountsByNameWithProgress(ctx context.Context, names []string, onResult func(chatgptreverse.AuthCheckResult)) ([]chatgptreverse.AuthCheckResult, error) {
	c.names = append([]string(nil), names...)
	allowed := map[string]bool{}
	for _, name := range names {
		allowed[name] = true
	}
	out := []chatgptreverse.AuthCheckResult{}
	for _, result := range c.results {
		if len(allowed) > 0 && !allowed[result.Name] {
			continue
		}
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
		out = append(out, result)
		if onResult != nil {
			onResult(result)
		}
	}
	return out, nil
}

func TestReverseAuthCheckJobCanLimitToSelectedAccountNames(t *testing.T) {
	checker := &selectiveReverseAuthChecker{results: []chatgptreverse.AuthCheckResult{
		{Name: "first.json", Status: chatgptreverse.AuthCheckStatusOK, CheckedAt: 1800000000000},
		{Name: "second.json", Status: chatgptreverse.AuthCheckStatusQuotaOrRateLimited, CheckedAt: 1800000000100},
		{Name: "third.json", Status: chatgptreverse.AuthCheckStatusExpired, CheckedAt: 1800000000200},
	}}
	e := setupWithReverseChecker(t, checker)

	rec := e.req("POST", "/api/admin/reverse-auth/check-jobs", e.adminTok, `{"names":["second.json","first.json","second.json"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("start selected job status=%d body=%s", rec.Code, rec.Body.String())
	}
	var started struct {
		Job struct {
			ID        string `json:"id"`
			Status    string `json:"status"`
			Total     int    `json:"total"`
			Completed int    `json:"completed"`
		} `json:"job"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &started); err != nil {
		t.Fatalf("decode start job: %v", err)
	}
	if started.Job.ID == "" || started.Job.Status != "running" || started.Job.Total != 2 {
		t.Fatalf("unexpected started selected job: %+v body=%s", started.Job, rec.Body.String())
	}

	deadline := time.Now().Add(time.Second)
	var final struct {
		Job struct {
			Status    string                           `json:"status"`
			Total     int                              `json:"total"`
			Completed int                              `json:"completed"`
			Results   []chatgptreverse.AuthCheckResult `json:"results"`
		} `json:"job"`
	}
	for time.Now().Before(deadline) {
		rec = e.req("GET", "/api/admin/reverse-auth/check-jobs/"+started.Job.ID, e.adminTok, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("poll selected job status=%d body=%s", rec.Code, rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &final); err != nil {
			t.Fatalf("decode selected poll: %v", err)
		}
		if final.Job.Status != "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if final.Job.Status != "succeeded" || final.Job.Total != 2 || final.Job.Completed != 2 {
		t.Fatalf("unexpected selected final job: %+v", final.Job)
	}
	if got := resultNames(final.Job.Results); strings.Join(got, ",") != "first.json,second.json" {
		t.Fatalf("selected job should only include requested accounts, got %v", got)
	}
	if strings.Join(checker.names, ",") != "second.json,first.json" {
		t.Fatalf("checker received names=%v", checker.names)
	}
}

func TestReverseAuthCheckJobRejectsInvalidSelectedAccountName(t *testing.T) {
	e := setupWithReverseChecker(t, &selectiveReverseAuthChecker{})
	rec := e.req("POST", "/api/admin/reverse-auth/check-jobs", e.adminTok, `{"names":["bad:name.json"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid selected name should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestReverseAuthCheckJobReturnsEmptyResultsArray(t *testing.T) {
	e := setupWithReverseChecker(t, nilReverseAuthChecker{})
	rec := e.req("POST", "/api/admin/reverse-auth/check-jobs", e.adminTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("start empty job status=%d body=%s", rec.Code, rec.Body.String())
	}
	var started struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &started); err != nil {
		t.Fatalf("decode start empty job: %v", err)
	}
	if started.Job.ID == "" {
		t.Fatalf("empty job missing id: %s", rec.Body.String())
	}

	deadline := time.Now().Add(time.Second)
	var final struct {
		Job struct {
			Status  string          `json:"status"`
			Results json.RawMessage `json:"results"`
		} `json:"job"`
	}
	for time.Now().Before(deadline) {
		rec = e.req("GET", "/api/admin/reverse-auth/check-jobs/"+started.Job.ID, e.adminTok, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("poll empty job status=%d body=%s", rec.Code, rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &final); err != nil {
			t.Fatalf("decode empty poll: %v", err)
		}
		if final.Job.Status != "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if final.Job.Status != "succeeded" {
		t.Fatalf("empty job did not finish: %+v body=%s", final.Job, rec.Body.String())
	}
	if string(final.Job.Results) != "[]" {
		t.Fatalf("empty job results should be [], got %s body=%s", string(final.Job.Results), rec.Body.String())
	}
}

func resultNames(results []chatgptreverse.AuthCheckResult) []string {
	names := make([]string, 0, len(results))
	for _, result := range results {
		names = append(names, result.Name)
	}
	return names
}
