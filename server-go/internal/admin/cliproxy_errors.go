package admin

import (
	"errors"
	"fmt"
	"strings"
)

func humanizeCLIProxyConnectError(err error, apiURL string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	host := strings.ToLower(strings.TrimSpace(apiURL))

	if strings.Contains(lower, "no such host") {
		if strings.Contains(host, "cliproxy") && !strings.Contains(host, "cliproxyapi") {
			return errors.New("无法连接 CPA：主机名 cliproxy 无法解析。Docker 部署请使用 http://cliproxyapi:8317。")
		}
		return fmt.Errorf("无法连接 CPA：主机名无法解析，请确认 PicPilot 容器能访问该地址（Docker 内通常为 http://cliproxyapi:8317）。详情：%s", msg)
	}
	if strings.Contains(lower, "connection refused") {
		return errors.New("无法连接 CPA：目标端口未监听，请确认 CLIProxyAPI 容器正在运行。")
	}
	if strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline exceeded") || strings.Contains(lower, "i/o timeout") {
		return errors.New("无法连接 CPA：请求超时，请检查地址是否正确，以及 PicPilot 是否已加入 cliproxyapi-net 网络。")
	}
	return fmt.Errorf("连接 CLIProxyAPI 失败：%s", msg)
}

func humanizeCLIProxyHTTPError(statusCode int, body string) error {
	trimmed := strings.TrimSpace(body)
	lower := strings.ToLower(trimmed)
	switch statusCode {
	case httpStatusUnauthorized:
		if strings.Contains(lower, "invalid management key") || strings.Contains(lower, "missing management key") {
			return errors.New("CPA 管理令牌无效：请填写 config.yaml 中 remote-management.secret-key 的明文值，不是 sk- 开头的出图 API Key。")
		}
		return errors.New("CPA 管理接口认证失败，请检查管理令牌是否正确。")
	case httpStatusNotFound:
		return errors.New("CPA 管理接口不存在：请确认地址指向 CLIProxyAPI 根路径（如 http://cliproxyapi:8317），且 remote-management.secret-key 已配置。")
	default:
		if trimmed == "" {
			return fmt.Errorf("CLIProxyAPI 返回 HTTP %d。", statusCode)
		}
		return fmt.Errorf("CLIProxyAPI 返回 HTTP %d：%s", statusCode, trimmed)
	}
}

const (
	httpStatusUnauthorized = 401
	httpStatusNotFound     = 404
)