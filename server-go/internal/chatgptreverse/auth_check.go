package chatgptreverse

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	AuthCheckStatusOK                 = "ok"
	AuthCheckStatusQuotaOrRateLimited = "quota_or_rate_limited"
	AuthCheckStatusExpired            = "expired"
	AuthCheckStatusInvalid            = "invalid"
	AuthCheckStatusDisabled           = "disabled"
	AuthCheckStatusError              = "error"

	webMePath                = "/backend-api/me"
	webConversationInitPath  = "/backend-api/conversation/init"
	webAccountCheckPath      = "/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480"
	webAccountCheckRoutePath = "/backend-api/accounts/check/v4-2023-04-27"

	defaultQuotaLimitedRefreshInterval = 5 * time.Minute
	defaultAuthCheckConcurrency        = 4
)

type AuthCheckResult struct {
	Name              string `json:"name"`
	Email             string `json:"email,omitempty"`
	UserID            string `json:"userId,omitempty"`
	HasRefreshToken   bool   `json:"hasRefreshToken"`
	Disabled          bool   `json:"disabled"`
	Status            string `json:"status"`
	Reason            string `json:"reason,omitempty"`
	HTTPStatus        *int   `json:"httpStatus,omitempty"`
	CheckedAt         int64  `json:"checkedAt"`
	PlanType          string `json:"type,omitempty"`
	Quota             *int   `json:"quota,omitempty"`
	ImageQuotaUnknown bool   `json:"imageQuotaUnknown,omitempty"`
	RestoreAt         string `json:"restoreAt,omitempty"`
	DefaultModelSlug  string `json:"defaultModelSlug,omitempty"`
}

type webAccountInfo struct {
	Email             string
	UserID            string
	PlanType          string
	Quota             int
	ImageQuotaUnknown bool
	RestoreAt         string
	DefaultModelSlug  string
	LimitsProgress    []any
}

// CheckAuthAccounts probes every reverse auth account stored in SQLite. It checks
// ChatGPT Web login usability and reports the image_gen quota returned by
// /backend-api/conversation/init.
func (s *Service) CheckAuthAccounts(ctx context.Context) ([]AuthCheckResult, error) {
	return s.CheckAuthAccountsWithProgress(ctx, nil)
}

func (s *Service) CountAuthAccounts(ctx context.Context) (int, error) {
	if s == nil || s.store == nil {
		return 0, errors.New("内置 reverse 未初始化。")
	}
	records, err := s.store.ListAuthAccounts(ctx)
	if err != nil {
		return 0, err
	}
	return len(records), nil
}

// CheckAuthAccountsWithProgress is the async-check primitive. It persists each
// result before reporting it so callers can reload the normal account list at any
// point during a long check.
func (s *Service) CheckAuthAccountsWithProgress(ctx context.Context, onResult func(AuthCheckResult)) ([]AuthCheckResult, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("内置 reverse 未初始化。")
	}
	records, err := s.store.ListAuthAccounts(ctx)
	if err != nil {
		return nil, err
	}
	return s.checkStoredAuthRecordsWithProgress(ctx, records, onResult), nil
}

func (s *Service) CheckAuthAccountsByNameWithProgress(ctx context.Context, names []string, onResult func(AuthCheckResult)) ([]AuthCheckResult, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("内置 reverse 未初始化。")
	}
	if len(names) == 0 {
		return s.CheckAuthAccountsWithProgress(ctx, onResult)
	}
	records := make([]StoredAuthAccount, 0, len(names))
	results := make([]AuthCheckResult, 0, len(names))
	for _, name := range names {
		record, found, err := s.store.GetAuthAccount(ctx, name)
		if err != nil {
			return nil, err
		}
		if !found {
			result := AuthCheckResult{
				Name:      name,
				Status:    AuthCheckStatusInvalid,
				Reason:    "账号不存在。",
				CheckedAt: time.Now().UnixMilli(),
			}
			if onResult != nil {
				onResult(result)
			}
			results = append(results, result)
			continue
		}
		records = append(records, record)
	}
	results = append(results, s.checkStoredAuthRecordsWithProgress(ctx, records, onResult)...)
	return results, nil
}

func (s *Service) checkStoredAuthRecordsWithProgress(ctx context.Context, records []StoredAuthAccount, onResult func(AuthCheckResult)) []AuthCheckResult {
	results := make([]AuthCheckResult, len(records))
	if len(records) == 0 {
		return results
	}

	type job struct {
		index  int
		record StoredAuthAccount
	}
	type indexedResult struct {
		index  int
		result AuthCheckResult
	}

	jobs := make(chan job)
	completed := make(chan indexedResult, len(records))
	workerCount := authCheckWorkerCount(len(records))
	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				completed <- indexedResult{
					index:  item.index,
					result: s.checkAndPersistStoredAuthAccount(ctx, item.record),
				}
			}
		}()
	}

	go func() {
		for index, record := range records {
			jobs <- job{index: index, record: record}
		}
		close(jobs)
		wg.Wait()
		close(completed)
	}()

	for item := range completed {
		results[item.index] = item.result
		if onResult != nil {
			onResult(item.result)
		}
	}

	return results
}

func authCheckWorkerCount(total int) int {
	if total <= 0 {
		return 0
	}
	if total < defaultAuthCheckConcurrency {
		return total
	}
	return defaultAuthCheckConcurrency
}

func (s *Service) CheckDueQuotaLimitedAccounts(ctx context.Context, now time.Time, onResult func(AuthCheckResult)) ([]AuthCheckResult, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("内置 reverse 未初始化。")
	}
	if now.IsZero() {
		now = time.Now()
	}
	records, err := s.store.ListAuthAccounts(ctx)
	if err != nil {
		return nil, err
	}
	due := []StoredAuthAccount{}
	for _, record := range records {
		if !quotaLimitedRestoreDue(record, now) {
			continue
		}
		due = append(due, record)
	}
	return s.checkStoredAuthRecordsWithProgress(ctx, due, onResult), nil
}

func (s *Service) StartQuotaLimitedRefreshLoop(ctx context.Context, interval time.Duration) {
	if s == nil || s.store == nil {
		return
	}
	if interval <= 0 {
		interval = defaultQuotaLimitedRefreshInterval
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				results, err := s.CheckDueQuotaLimitedAccounts(ctx, time.Now(), nil)
				if err != nil {
					if s.logger != nil {
						s.logger.Warn("chatgpt reverse scheduled quota refresh failed", "scope", "reverse", "err", err.Error())
					}
					continue
				}
				if len(results) > 0 && s.logger != nil {
					s.logger.Info("chatgpt reverse scheduled quota refresh finished", "scope", "reverse", "count", len(results))
				}
			}
		}
	}()
}

func (s *Service) checkAndPersistStoredAuthAccount(ctx context.Context, record StoredAuthAccount) AuthCheckResult {
	result := s.checkStoredAuthAccount(ctx, record)
	if err := s.store.UpdateAuthAccountMetadata(ctx, record.Name, authCheckMetadata(result)); err != nil && s.logger != nil {
		s.logger.Warn("chatgpt reverse auth metadata update failed", "scope", "reverse", "name", record.Name, "err", err.Error())
	}
	return result
}

func quotaLimitedRestoreDue(record StoredAuthAccount, now time.Time) bool {
	if record.Disabled || record.Status != AuthCheckStatusQuotaOrRateLimited || strings.TrimSpace(record.RestoreAt) == "" {
		return false
	}
	restoreAt, err := time.Parse(time.RFC3339, strings.TrimSpace(record.RestoreAt))
	if err != nil {
		return false
	}
	return !restoreAt.After(now)
}

func authCheckMetadata(result AuthCheckResult) AuthAccountMetadata {
	return AuthAccountMetadata{
		Email:             result.Email,
		UserID:            result.UserID,
		Status:            result.Status,
		StatusReason:      result.Reason,
		HTTPStatus:        result.HTTPStatus,
		AccountType:       result.PlanType,
		Quota:             result.Quota,
		ImageQuotaUnknown: result.ImageQuotaUnknown,
		RestoreAt:         result.RestoreAt,
		DefaultModelSlug:  result.DefaultModelSlug,
		CheckedAt:         result.CheckedAt,
	}
}

func (s *Service) checkStoredAuthAccount(ctx context.Context, record StoredAuthAccount) AuthCheckResult {
	result := AuthCheckResult{Name: record.Name, CheckedAt: time.Now().UnixMilli()}
	var raw map[string]any
	if json.Unmarshal([]byte(record.RawJSON), &raw) != nil {
		result.Status = AuthCheckStatusInvalid
		result.Reason = "JSON 格式无效。"
		return result
	}
	result.Email = stringValue(raw["email"], "")
	result.HasRefreshToken = strings.TrimSpace(stringValue(raw["refresh_token"], "")) != ""
	rawDisabled := truthy(raw["disabled"])
	result.Disabled = record.Disabled || rawDisabled
	if result.Disabled {
		if !rawDisabled && passwordLoginAvailable(raw) {
			result.Disabled = false
		} else {
			result.Status = AuthCheckStatusDisabled
			result.Reason = "账号已禁用，未发起探测。"
			return result
		}
	}
	acc := account{
		AccessToken:      stringValue(raw["access_token"], ""),
		RefreshToken:     stringValue(raw["refresh_token"], ""),
		Email:            result.Email,
		Name:             record.Name,
		DefaultModelSlug: record.DefaultModelSlug,
		Raw:              raw,
	}
	if record.Disabled && passwordLoginAvailable(raw) {
		if relogged, ok := s.passwordRelogin(ctx, acc); ok {
			acc = relogged
			result.HasRefreshToken = acc.RefreshToken != ""
		}
	}
	if strings.TrimSpace(acc.AccessToken) == "" {
		if relogged, ok := s.passwordRelogin(ctx, acc); ok {
			acc = relogged
			result.HasRefreshToken = acc.RefreshToken != ""
		}
	}
	if strings.TrimSpace(acc.AccessToken) == "" {
		result.Status = AuthCheckStatusInvalid
		result.Reason = "缺少 access_token。"
		return result
	}
	if tokenExpiresSoon(acc.AccessToken, 0) {
		if refreshed, ok := s.refreshIfNeeded(ctx, acc, true); ok {
			acc = refreshed
			result.HasRefreshToken = acc.RefreshToken != ""
		} else {
			result.Status = AuthCheckStatusExpired
			result.Reason = "access_token 已过期，且无法自动恢复。"
			return result
		}
	}
	if refreshed, ok := s.refreshIfNeeded(ctx, acc, false); ok {
		acc = refreshed
		result.HasRefreshToken = acc.RefreshToken != ""
	}
	return s.probeAuthAccount(ctx, result, acc)
}

func (s *Service) probeAuthAccount(ctx context.Context, result AuthCheckResult, acc account) AuthCheckResult {
	info, err := s.fetchWebAccountInfo(ctx, acc.AccessToken)
	if err == nil {
		applyWebAccountInfo(&result, info)
		return result
	}
	var statusErr *httpStatusError
	if errors.As(err, &statusErr) && statusErr.Status == http.StatusUnauthorized {
		if refreshed, ok := s.refreshIfNeeded(ctx, acc, true); ok && refreshed.AccessToken != acc.AccessToken {
			info, err = s.fetchWebAccountInfo(ctx, refreshed.AccessToken)
			if err == nil {
				applyWebAccountInfo(&result, info)
				if result.Status == AuthCheckStatusOK {
					result.Reason = strings.TrimSuffix(result.Reason, "。") + "，已刷新 token。"
				}
				return result
			}
		}
	}
	if errors.As(err, &statusErr) {
		result.HTTPStatus = &statusErr.Status
		result.Status, result.Reason = classifyAuthCheckFailure(statusErr.Status, statusErr.Body)
		return result
	}
	result.Status = AuthCheckStatusError
	result.Reason = err.Error()
	return result
}

func (s *Service) fetchWebAccountInfo(ctx context.Context, token string) (webAccountInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	session := newWebSession(token)
	initPayload, err := s.fetchWebConversationInit(ctx, session)
	if err != nil {
		return webAccountInfo{}, err
	}
	info := webAccountInfoFromInit(initPayload)
	if me, err := s.fetchWebJSON(ctx, http.MethodGet, webMePath, session, nil); err == nil {
		info.Email = stringValue(me["email"], info.Email)
		info.UserID = stringValue(me["id"], info.UserID)
	}
	if accountPayload, err := s.fetchWebJSON(ctx, http.MethodGet, webAccountCheckPath, session, nil); err == nil {
		if plan := webPlanType(accountPayload); plan != "" {
			info.PlanType = plan
		}
	}
	return info, nil
}

func (s *Service) fetchWebConversationInit(ctx context.Context, session webSession) (map[string]any, error) {
	return s.fetchWebJSON(ctx, http.MethodPost, webConversationInitPath, session, map[string]any{
		"gizmo_id":                nil,
		"requested_default_model": nil,
		"conversation_id":         nil,
		"timezone_offset_min":     -480,
	})
}

func (s *Service) fetchWebJSON(ctx context.Context, method, path string, session webSession, body any) (map[string]any, error) {
	var reader io.Reader
	contentType := ""
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = strings.NewReader(string(payload))
		contentType = "application/json"
	}
	req, err := s.newWebRequest(ctx, method, path, session, reader, contentType, "application/json")
	if err != nil {
		return nil, err
	}
	if path == webAccountCheckPath {
		req.Header.Set("X-OpenAI-Target-Path", webAccountCheckRoutePath)
		req.Header.Set("X-OpenAI-Target-Route", webAccountCheckRoutePath)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusForbidden && isCloudflareChallengeResponse(resp) {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
			return nil, &httpStatusError{Status: resp.StatusCode, Body: "cloudflare challenge: " + strings.TrimSpace(string(body))}
		}
		return nil, upstreamHTTPError(resp)
	}
	var payload map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func webAccountInfoFromInit(payload map[string]any) webAccountInfo {
	limits, _ := payload["limits_progress"].([]any)
	quota, restoreAt, unknown := extractImageQuotaAndRestoreAt(limits)
	return webAccountInfo{
		Quota:             quota,
		ImageQuotaUnknown: unknown,
		RestoreAt:         restoreAt,
		DefaultModelSlug:  stringValue(payload["default_model_slug"], ""),
		LimitsProgress:    limits,
	}
}

func extractImageQuotaAndRestoreAt(limits []any) (int, string, bool) {
	for _, item := range limits {
		entry, ok := item.(map[string]any)
		if !ok || stringValue(entry["feature_name"], "") != "image_gen" {
			continue
		}
		return positiveInt(entry["remaining"], 0), stringValue(entry["reset_after"], ""), false
	}
	return 0, "", true
}

func applyWebAccountInfo(result *AuthCheckResult, info webAccountInfo) {
	if info.Email != "" {
		result.Email = info.Email
	}
	if info.UserID != "" {
		result.UserID = info.UserID
	}
	result.PlanType = info.PlanType
	result.Quota = &info.Quota
	result.ImageQuotaUnknown = info.ImageQuotaUnknown
	result.RestoreAt = info.RestoreAt
	result.DefaultModelSlug = info.DefaultModelSlug
	status, reason := webAccountCheckStatus(info)
	result.Status = status
	result.Reason = reason
}

func webAccountCheckStatus(info webAccountInfo) (string, string) {
	plan := strings.ToLower(strings.TrimSpace(info.PlanType))
	if info.ImageQuotaUnknown && plan != "" && plan != "free" {
		return AuthCheckStatusOK, "账号可用，网页图片额度未返回明确计数。"
	}
	if info.Quota <= 0 {
		reason := "网页图片剩余额度为 0。"
		if info.RestoreAt != "" {
			reason = "网页图片剩余额度为 0，预计恢复：" + info.RestoreAt + "。"
		}
		return AuthCheckStatusQuotaOrRateLimited, reason
	}
	return AuthCheckStatusOK, "账号可用，网页图片剩余额度 " + strconv.Itoa(info.Quota) + "。"
}

func webPlanType(payload map[string]any) string {
	accounts, _ := payload["accounts"].(map[string]any)
	defaultAccount, _ := accounts["default"].(map[string]any)
	account, _ := defaultAccount["account"].(map[string]any)
	return stringValue(account["plan_type"], "")
}

func classifyAuthCheckFailure(status int, body string) (string, string) {
	lower := strings.ToLower(body)
	if status == http.StatusUnauthorized {
		return AuthCheckStatusExpired, "登录态失效或 access_token 已过期。"
	}
	if status == http.StatusForbidden && strings.Contains(lower, "cloudflare challenge") {
		return AuthCheckStatusError, "ChatGPT Web 被 Cloudflare 拦截，暂时无法读取额度，请稍后重试或更换出站代理。"
	}
	if status == http.StatusTooManyRequests || strings.Contains(lower, "quota") || strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit") || strings.Contains(lower, "too many") || strings.Contains(lower, "usage limit") || strings.Contains(lower, "limit reached") {
		return AuthCheckStatusQuotaOrRateLimited, "上游返回限流或额度类错误，疑似无额度。"
	}
	if status == http.StatusForbidden {
		return AuthCheckStatusInvalid, "账号无权限或被上游拒绝。"
	}
	if status == 0 {
		return AuthCheckStatusError, "探测请求失败。"
	}
	return AuthCheckStatusError, "上游探测失败：HTTP " + http.StatusText(status)
}
