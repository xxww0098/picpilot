package admin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
)

const maxReverseAuthCheckJobRequestBytes int64 = 16 << 10

const (
	reverseAuthJobRunning   = "running"
	reverseAuthJobSucceeded = "succeeded"
	reverseAuthJobFailed    = "failed"
)

type reverseAuthCheckJob struct {
	ID         string
	Status     string
	Total      int
	Completed  int
	StartedAt  int64
	UpdatedAt  int64
	FinishedAt int64
	Error      string
	Results    []chatgptreverse.AuthCheckResult
}

type reverseAuthCheckJobManager struct {
	mu   sync.Mutex
	jobs map[string]*reverseAuthCheckJob
}

func newReverseAuthCheckJobManager() *reverseAuthCheckJobManager {
	return &reverseAuthCheckJobManager{jobs: map[string]*reverseAuthCheckJob{}}
}

func (m *reverseAuthCheckJobManager) start(total int) map[string]any {
	now := time.Now().UnixMilli()
	job := &reverseAuthCheckJob{
		ID:        "rac-" + randomHex(8),
		Status:    reverseAuthJobRunning,
		Total:     total,
		StartedAt: now,
		UpdatedAt: now,
		Results:   []chatgptreverse.AuthCheckResult{},
	}
	m.mu.Lock()
	m.jobs[job.ID] = job
	m.mu.Unlock()
	return reverseAuthCheckJobView(job)
}

func (m *reverseAuthCheckJobManager) addResult(id string, result chatgptreverse.AuthCheckResult) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.jobs[id]
	if job == nil || job.Status != reverseAuthJobRunning {
		return
	}
	job.Results = append(job.Results, result)
	job.Completed = len(job.Results)
	if job.Total < job.Completed {
		job.Total = job.Completed
	}
	job.UpdatedAt = time.Now().UnixMilli()
}

func (m *reverseAuthCheckJobManager) finish(id string, results []chatgptreverse.AuthCheckResult, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.jobs[id]
	if job == nil {
		return
	}
	now := time.Now().UnixMilli()
	job.UpdatedAt = now
	job.FinishedAt = now
	if err != nil {
		job.Status = reverseAuthJobFailed
		job.Error = err.Error()
		return
	}
	if results == nil {
		results = []chatgptreverse.AuthCheckResult{}
	}
	job.Status = reverseAuthJobSucceeded
	job.Results = append([]chatgptreverse.AuthCheckResult{}, results...)
	job.Completed = len(results)
	if job.Total < job.Completed {
		job.Total = job.Completed
	}
}

func (m *reverseAuthCheckJobManager) get(id string) (map[string]any, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.jobs[id]
	if job == nil {
		return nil, false
	}
	return reverseAuthCheckJobView(job), true
}

func reverseAuthCheckJobView(job *reverseAuthCheckJob) map[string]any {
	results := append([]chatgptreverse.AuthCheckResult{}, job.Results...)
	view := map[string]any{
		"id":        job.ID,
		"status":    job.Status,
		"total":     job.Total,
		"completed": job.Completed,
		"startedAt": job.StartedAt,
		"updatedAt": job.UpdatedAt,
		"results":   results,
	}
	if job.FinishedAt > 0 {
		view["finishedAt"] = job.FinishedAt
	}
	if job.Error != "" {
		view["error"] = job.Error
	}
	return view
}

func (m *Module) startReverseAuthCheckJob(w http.ResponseWriter, r *http.Request) {
	if m.reverse == nil {
		httpx.Error(w, http.StatusBadRequest, "内置 reverse 未初始化，无法检查账号。")
		return
	}
	names, ok := m.reverseAuthCheckJobNames(w, r)
	if !ok {
		return
	}
	total := len(names)
	if total == 0 {
		if progress, ok := m.reverse.(reverseAuthProgressChecker); ok {
			if n, err := progress.CountAuthAccounts(r.Context()); err == nil {
				total = n
			}
		}
	}
	job := m.reverseJobs.start(total)
	id, _ := job["id"].(string)
	go m.runReverseAuthCheckJob(id, names)
	httpx.JSON(w, http.StatusOK, map[string]any{"job": job})
}

func (m *Module) reverseAuthCheckJobNames(w http.ResponseWriter, r *http.Request) ([]string, bool) {
	var body struct {
		Names []string `json:"names"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReverseAuthCheckJobRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		httpx.Error(w, http.StatusBadRequest, "请求 JSON 无法解析。")
		return nil, false
	}
	seen := map[string]bool{}
	names := make([]string, 0, len(body.Names))
	for _, raw := range body.Names {
		name, ok := cleanReverseAuthFilename(raw)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "账号名无效。")
			return nil, false
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	if len(names) > 200 {
		httpx.Error(w, http.StatusBadRequest, "单次最多刷新 200 个逆向账号。")
		return nil, false
	}
	return names, true
}

func (m *Module) getReverseAuthCheckJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	job, ok := m.reverseJobs.get(id)
	if !ok {
		httpx.Error(w, http.StatusNotFound, "账号检查任务不存在。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"job": job})
}

func (m *Module) runReverseAuthCheckJob(id string, names []string) {
	ctx := context.Background()
	var (
		results []chatgptreverse.AuthCheckResult
		err     error
	)
	if len(names) > 0 {
		if selective, ok := m.reverse.(reverseAuthSelectiveProgressChecker); ok {
			results, err = selective.CheckAuthAccountsByNameWithProgress(ctx, names, func(result chatgptreverse.AuthCheckResult) {
				m.reverseJobs.addResult(id, result)
			})
		} else if progress, ok := m.reverse.(reverseAuthProgressChecker); ok {
			results, err = progress.CheckAuthAccountsWithProgress(ctx, func(result chatgptreverse.AuthCheckResult) {
				if reverseAuthResultSelected(result.Name, names) {
					m.reverseJobs.addResult(id, result)
				}
			})
			results = filterReverseAuthResults(results, names)
		} else {
			results, err = m.reverse.CheckAuthAccounts(ctx)
			results = filterReverseAuthResults(results, names)
		}
	} else if progress, ok := m.reverse.(reverseAuthProgressChecker); ok {
		results, err = progress.CheckAuthAccountsWithProgress(ctx, func(result chatgptreverse.AuthCheckResult) {
			m.reverseJobs.addResult(id, result)
		})
	} else {
		results, err = m.reverse.CheckAuthAccounts(ctx)
	}
	m.reverseJobs.finish(id, results, err)
	if err != nil {
		m.logger.Warn("admin reverse auth async check failed", "scope", "admin", "jobId", id, "err", err.Error())
		return
	}
	m.logger.Info("admin reverse auth async check finished", "scope", "admin", "jobId", id, "count", len(results))
}

func reverseAuthResultSelected(name string, names []string) bool {
	for _, selected := range names {
		if selected == name {
			return true
		}
	}
	return false
}

func filterReverseAuthResults(results []chatgptreverse.AuthCheckResult, names []string) []chatgptreverse.AuthCheckResult {
	if len(names) == 0 {
		return results
	}
	out := make([]chatgptreverse.AuthCheckResult, 0, len(results))
	for _, result := range results {
		if reverseAuthResultSelected(result.Name, names) {
			out = append(out, result)
		}
	}
	return out
}
