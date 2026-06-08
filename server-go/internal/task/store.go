// Package task implements the async task model: clients submit work and get a task_id
// immediately (connection closes in ~ms), then poll GET /api/tasks/{id} or stream
// /api/tasks/{id}/events while a server-side executor runs the upstream request behind
// the global concurrency queue. This decouples request duration from connection
// duration — the fundamental fix for "long request dropped by some proxy layer".
package task

import (
	"database/sql"
	"encoding/json"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/idutil"
)

// Status is the task lifecycle state.
type Status string

const (
	StatusQueued    Status = "queued"
	StatusRunning   Status = "running"
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
	StatusCanceled  Status = "canceled"
)

func (s Status) terminal() bool {
	return s == StatusSucceeded || s == StatusFailed || s == StatusCanceled
}

// Task is a row of the tasks table.
type Task struct {
	ID           string
	UserID       string
	Type         string
	Status       Status
	Endpoint     string
	RequestJSON  string
	ResultJSON   string
	ErrorType    string
	ErrorMessage string
	CreatedAt    int64
	UpdatedAt    int64
	StartedAt    *int64
	FinishedAt   *int64
}

// View is the JSON representation returned to clients (omits user_id/request payload).
func (t *Task) View() map[string]any {
	v := map[string]any{
		"id":        t.ID,
		"type":      t.Type,
		"status":    string(t.Status),
		"endpoint":  t.Endpoint,
		"createdAt": t.CreatedAt,
		"updatedAt": t.UpdatedAt,
	}
	if t.StartedAt != nil {
		v["startedAt"] = *t.StartedAt
	}
	if t.FinishedAt != nil {
		v["finishedAt"] = *t.FinishedAt
	}
	if t.ResultJSON != "" {
		v["result"] = json.RawMessage(t.ResultJSON)
	}
	if t.ErrorType != "" {
		v["errorType"] = t.ErrorType
	}
	if t.ErrorMessage != "" {
		v["errorMessage"] = t.ErrorMessage
	}
	return v
}

// Store wraps task persistence.
type Store struct{ db *db.DB }

func NewStore(d *db.DB) *Store { return &Store{db: d} }

const taskCols = `id,user_id,idempotency_key,type,status,endpoint,request_json,result_json,error_type,error_message,created_at,updated_at,started_at,finished_at`

type scanner interface{ Scan(dest ...any) error }

func scanTask(sc scanner) (*Task, error) {
	var (
		t                                Task
		idem, endpoint, reqJSON, resJSON sql.NullString
		errType, errMsg                  sql.NullString
		started, finished                sql.NullInt64
		status                           string
	)
	if err := sc.Scan(&t.ID, &t.UserID, &idem, &t.Type, &status, &endpoint, &reqJSON, &resJSON,
		&errType, &errMsg, &t.CreatedAt, &t.UpdatedAt, &started, &finished); err != nil {
		return nil, err
	}
	t.Status = Status(status)
	t.Endpoint = endpoint.String
	t.RequestJSON = reqJSON.String
	t.ResultJSON = resJSON.String
	t.ErrorType = errType.String
	t.ErrorMessage = errMsg.String
	if started.Valid {
		t.StartedAt = &started.Int64
	}
	if finished.Valid {
		t.FinishedAt = &finished.Int64
	}
	return &t, nil
}

// Get returns a task by id.
func (s *Store) Get(id string) (*Task, error) {
	return scanTask(s.db.QueryRow("SELECT "+taskCols+" FROM tasks WHERE id = ?", id))
}

func (s *Store) getByIdem(userID, key string) (*Task, error) {
	return scanTask(s.db.QueryRow("SELECT "+taskCols+" FROM tasks WHERE user_id = ? AND idempotency_key = ?", userID, key))
}

// Create inserts a queued task. When idemKey is set and an existing task with the same
// (user, key) exists, it returns that task with created=false (idempotency).
func (s *Store) Create(userID, idemKey, typ, endpoint, requestJSON string) (task *Task, created bool, err error) {
	if idemKey != "" {
		if existing, e := s.getByIdem(userID, idemKey); e == nil {
			return existing, false, nil
		}
	}
	id := idutil.UUIDv4()
	now := time.Now().UnixMilli()
	var keyArg any
	if idemKey != "" {
		keyArg = idemKey
	}
	_, err = s.db.Exec(
		"INSERT INTO tasks (id,user_id,idempotency_key,type,status,endpoint,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
		id, userID, keyArg, typ, string(StatusQueued), endpoint, requestJSON, now, now,
	)
	if err != nil {
		// Lost an idempotency race: the unique index rejected us, so return the winner.
		if idemKey != "" {
			if existing, e := s.getByIdem(userID, idemKey); e == nil {
				return existing, false, nil
			}
		}
		return nil, false, err
	}
	t, gerr := s.Get(id)
	return t, true, gerr
}

// Claim atomically transitions queued->running; returns true if this caller won it.
func (s *Store) Claim(id string) (bool, error) {
	now := time.Now().UnixMilli()
	res, err := s.db.Exec("UPDATE tasks SET status='running', started_at=?, updated_at=? WHERE id=? AND status='queued'", now, now, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// Finish writes a terminal status with optional result/error payloads.
func (s *Store) Finish(id string, status Status, resultJSON, errType, errMsg string) error {
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(
		"UPDATE tasks SET status=?, result_json=?, error_type=?, error_message=?, updated_at=?, finished_at=? WHERE id=?",
		string(status), nullStr(resultJSON), nullStr(errType), nullStr(errMsg), now, now, id,
	)
	return err
}

// Cancel marks a non-terminal task canceled; returns true if it was queued/running.
func (s *Store) Cancel(id string) (bool, error) {
	now := time.Now().UnixMilli()
	res, err := s.db.Exec("UPDATE tasks SET status='canceled', updated_at=?, finished_at=? WHERE id=? AND status IN ('queued','running')", now, now, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RecoverPending resets interrupted running tasks back to queued (on restart) and
// returns all queued task ids in creation order for re-dispatch.
func (s *Store) RecoverPending() ([]string, error) {
	if _, err := s.db.Exec("UPDATE tasks SET status='queued' WHERE status='running'"); err != nil {
		return nil, err
	}
	rows, err := s.db.Query("SELECT id FROM tasks WHERE status='queued' ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
