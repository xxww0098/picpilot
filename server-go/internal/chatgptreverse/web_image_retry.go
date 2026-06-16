package chatgptreverse

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	webImageReferencedIDsRe = regexp.MustCompile(`referenced_image_ids`)
	webImageToolParamsRe    = regexp.MustCompile(`\{\s*"size"\s*:\s*"\d+x\d+"\s*,\s*"n"\s*:\s*\d+\s*\}`)
)

var (
	webImageDefaultPollTimeout              = 120 * time.Second
	webImageTextReplyPollTimeout            = 300 * time.Second
	webImageTextReplyPollMaxAttempts        = 3
	webImageTextReplyPollBackoffBase        = 30 * time.Second
	webImageTextReplyDownloadURLReadyTimeout = 120 * time.Second
	webImagePollInitialDelay                = 10 * time.Second
	webImagePollInterval                    = 10 * time.Second
)

type retryableWebImageError struct {
	message string
}

func (e *retryableWebImageError) Error() string { return e.message }

func newRetryableWebImageError(message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "ChatGPT Web 生图临时失败，将尝试其他账号。"
	}
	return &retryableWebImageError{message: message}
}

func isRetryableWebImageError(err error) bool {
	var target *retryableWebImageError
	return errors.As(err, &target)
}

type permanentWebImageError struct {
	message string
}

func (e *permanentWebImageError) Error() string { return e.message }

func newPermanentWebImageError(message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "ChatGPT Web 生图被拒绝。"
	}
	return &permanentWebImageError{message: message}
}

func isPermanentWebImageError(err error) bool {
	var target *permanentWebImageError
	return errors.As(err, &target)
}

func isWebImageTextReply(message string) bool {
	message = strings.TrimSpace(message)
	if message == "" {
		return false
	}
	return webImageReferencedIDsRe.MatchString(message) || webImageToolParamsRe.MatchString(message)
}

func shouldPollWebImageIDs(state webImageState) bool {
	if state.ConversationID == "" {
		return false
	}
	if len(state.FileIDs) > 0 || len(state.SedimentIDs) > 0 {
		return false
	}
	if isWebImageTextReply(state.Message) {
		return true
	}
	if state.ToolInvoked {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(state.TurnUseCase), "image gen")
}

func shouldUseExtendedWebImageWait(state webImageState) bool {
	return isWebImageTextReply(state.Message) || state.ToolInvoked || shouldPollWebImageIDs(state)
}

func webImagePollTimeout(state webImageState) time.Duration {
	if isWebImageTextReply(state.Message) {
		return webImageTextReplyPollTimeout
	}
	return webImageDefaultPollTimeout
}

func webImageDownloadURLReadyTimeoutFor(state webImageState) time.Duration {
	if shouldUseExtendedWebImageWait(state) {
		return webImageTextReplyDownloadURLReadyTimeout
	}
	return webImageDownloadURLReadyTimeout
}

func wrapRetryableUpstreamHTTPError(err error) error {
	if err == nil {
		return nil
	}
	var statusErr *httpStatusError
	if !errors.As(err, &statusErr) {
		return err
	}
	switch statusErr.Status {
	case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return newRetryableWebImageError(fmt.Sprintf("上游暂不可用：HTTP %d", statusErr.Status))
	case http.StatusForbidden:
		if strings.Contains(strings.ToLower(statusErr.Body), "just a moment") {
			return newRetryableWebImageError("上游被 Cloudflare 拦截（HTTP 403），将尝试其他账号。")
		}
	}
	return err
}

func webImageNoURLsError(state webImageState) error {
	if state.Blocked && state.Message != "" {
		return newPermanentWebImageError(state.Message)
	}
	if state.Message != "" {
		if isWebImageTextReply(state.Message) || shouldPollWebImageIDs(state) {
			return newRetryableWebImageError("ChatGPT Web 未返回图片（可能仍在生成）：" + state.Message)
		}
		return newPermanentWebImageError("ChatGPT Web 未返回图片：" + state.Message)
	}
	return newRetryableWebImageError("ChatGPT Web 未返回图片。")
}

func (s *Service) pollWebImageIDsWithRetries(ctx context.Context, session webSession, state *webImageState) error {
	if !shouldPollWebImageIDs(*state) {
		return nil
	}
	timeout := webImagePollTimeout(*state)
	maxAttempts := 1
	if isWebImageTextReply(state.Message) {
		maxAttempts = webImageTextReplyPollMaxAttempts
	}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := s.pollImageIDs(ctx, session, state, timeout); err != nil {
			if isWebImageTextReply(state.Message) {
				return newRetryableWebImageError(err.Error())
			}
			return err
		}
		if len(state.FileIDs) > 0 || len(state.SedimentIDs) > 0 {
			if attempt > 1 && s.logger != nil {
				s.logger.Info("chatgpt web image poll succeeded after retry", "scope", "reverse", "attempt", attempt, "conversationId", state.ConversationID, "fileIds", len(state.FileIDs), "sedimentIds", len(state.SedimentIDs))
			}
			return nil
		}
		if attempt >= maxAttempts {
			break
		}
		backoff := webImageTextReplyPollBackoffBase * time.Duration(attempt)
		if s.logger != nil {
			s.logger.Info("chatgpt web image poll retry scheduled", "scope", "reverse", "attempt", attempt, "maxAttempts", maxAttempts, "conversationId", state.ConversationID, "backoff", backoff.String())
		}
		if err := sleepContext(ctx, backoff); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) resolveWebImageURLs(ctx context.Context, session webSession, state webImageState) ([]string, error) {
	readyTimeout := webImageDownloadURLReadyTimeoutFor(state)
	urls, err := s.resolveImageURLs(ctx, session, state.ConversationID, state.FileIDs, state.SedimentIDs, readyTimeout)
	if err != nil {
		if shouldUseExtendedWebImageWait(state) {
			return nil, newRetryableWebImageError(err.Error())
		}
		return nil, err
	}
	if len(urls) > 0 {
		return urls, nil
	}
	if isWebImageTextReply(state.Message) && state.ConversationID != "" {
		extra := &webImageState{
			ConversationID: state.ConversationID,
			FileIDs:        append([]string(nil), state.FileIDs...),
			SedimentIDs:    append([]string(nil), state.SedimentIDs...),
			Message:        state.Message,
			ToolInvoked:    state.ToolInvoked,
			TurnUseCase:    state.TurnUseCase,
		}
		if err := s.pollImageIDs(ctx, session, extra, webImageTextReplyPollTimeout); err == nil {
			urls, err = s.resolveImageURLs(ctx, session, extra.ConversationID, extra.FileIDs, extra.SedimentIDs, readyTimeout)
			if err == nil && len(urls) > 0 {
				state.FileIDs = extra.FileIDs
				state.SedimentIDs = extra.SedimentIDs
				return urls, nil
			}
		}
	}
	return nil, webImageNoURLsError(state)
}