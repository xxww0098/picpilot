package chatgptreverse

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	mrand "math/rand"
	"time"

	"golang.org/x/crypto/sha3"
)

const defaultPowScript = "https://chatgpt.com/backend-api/sentinel/sdk.js"

var (
	powCores        = []int{8, 16, 24, 32}
	powDocumentKeys = []string{"_reactListeningo743lnnpvdg", "location"}
)

func buildLegacyRequirementsToken(userAgent string) string {
	seed := fmt.Sprintf("%.17g", mrand.Float64())
	config := buildPowConfig(userAgent, nil, "")
	answer, _ := powGenerate(seed, "0fffff", config, 500000)
	return "gAAAAAC" + answer
}

func buildProofToken(seed, difficulty, userAgent string) (string, error) {
	config := buildPowConfig(userAgent, nil, "")
	answer, solved := powGenerate(seed, difficulty, config, 500000)
	if !solved {
		return "", fmt.Errorf("failed to solve proof token: difficulty=%s", difficulty)
	}
	return "gAAAAAB" + answer, nil
}

func buildPowConfig(userAgent string, scriptSources []string, dataBuild string) []any {
	navigatorKeys := []string{
		"registerProtocolHandler−function registerProtocolHandler() { [native code] }",
		"storage−[object StorageManager]",
		"locks−[object LockManager]",
		"appCodeName−Mozilla",
		"permissions−[object Permissions]",
		"share−function share() { [native code] }",
		"webdriver−false",
		"managed−[object NavigatorManagedData]",
		"canShare−function canShare() { [native code] }",
		"vendor−Google Inc.",
		"mediaDevices−[object MediaDevices]",
		"vibrate−function vibrate() { [native code] }",
		"storageBuckets−[object StorageBucketManager]",
		"mediaCapabilities−[object MediaCapabilities]",
		"cookieEnabled−true",
		"virtualKeyboard−[object VirtualKeyboard]",
		"product−Gecko",
		"presentation−[object Presentation]",
		"onLine−true",
		"mimeTypes−[object MimeTypeArray]",
		"credentials−[object CredentialsContainer]",
		"serviceWorker−[object ServiceWorkerContainer]",
		"keyboard−[object Keyboard]",
		"gpu−[object GPU]",
		"doNotTrack",
		"serial−[object Serial]",
		"pdfViewerEnabled−true",
		"language−zh-CN",
		"geolocation−[object Geolocation]",
		"userAgentData−[object NavigatorUAData]",
		"getUserMedia−function getUserMedia() { [native code] }",
		"sendBeacon−function sendBeacon() { [native code] }",
		"hardwareConcurrency−32",
		"windowControlsOverlay−[object WindowControlsOverlay]",
	}
	windowKeys := []string{
		"0", "window", "self", "document", "name", "location", "customElements",
		"history", "navigation", "innerWidth", "innerHeight", "scrollX", "scrollY",
		"visualViewport", "screenX", "screenY", "outerWidth", "outerHeight",
		"devicePixelRatio", "screen", "chrome", "navigator", "onresize",
		"performance", "crypto", "indexedDB", "sessionStorage", "localStorage",
		"scheduler", "alert", "atob", "btoa", "fetch", "matchMedia",
		"postMessage", "queueMicrotask", "requestAnimationFrame", "setInterval",
		"setTimeout", "caches", "__NEXT_DATA__", "__BUILD_MANIFEST",
		"__NEXT_PRELOADREADY",
	}
	scriptSource := defaultPowScript
	if len(scriptSources) > 0 {
		scriptSource = scriptSources[mrand.Intn(len(scriptSources))]
	}
	perfNow := float64(time.Now().UnixNano()%1_000_000_000) / 1_000_000
	return []any{
		[]int{3000, 4000, 5000}[mrand.Intn(3)],
		legacyParseTime(),
		4294705152,
		0,
		userAgent,
		scriptSource,
		dataBuild,
		"en-US",
		"en-US,es-US,en,es",
		0,
		navigatorKeys[mrand.Intn(len(navigatorKeys))],
		powDocumentKeys[mrand.Intn(len(powDocumentKeys))],
		windowKeys[mrand.Intn(len(windowKeys))],
		perfNow,
		randomID(),
		"",
		powCores[mrand.Intn(len(powCores))],
		float64(time.Now().UnixNano())/1_000_000 - perfNow,
	}
}

func legacyParseTime() string {
	loc := time.FixedZone("Eastern Standard Time", -5*60*60)
	return time.Now().In(loc).Format("Mon Jan 02 2006 15:04:05") + " GMT-0500 (Eastern Standard Time)"
}

func powGenerate(seed, difficulty string, config []any, limit int) (string, bool) {
	target, err := hex.DecodeString(difficulty)
	if err != nil || len(target) == 0 {
		return "", false
	}
	diffLen := len(difficulty) / 2
	seedBytes := []byte(seed)
	static1 := append(trimLast(mustJSON(config[:3])), ',')
	mid := mustJSON(config[4:9])
	static2 := append([]byte{','}, mid[1:len(mid)-1]...)
	static2 = append(static2, ',')
	tail := mustJSON(config[10:])
	static3 := append([]byte{','}, tail[1:]...)
	for i := 0; i < limit; i++ {
		var final bytes.Buffer
		final.Write(static1)
		final.WriteString(fmt.Sprintf("%d", i))
		final.Write(static2)
		final.WriteString(fmt.Sprintf("%d", i>>1))
		final.Write(static3)
		encoded := make([]byte, base64.StdEncoding.EncodedLen(final.Len()))
		base64.StdEncoding.Encode(encoded, final.Bytes())
		digest := sha3.Sum512(append(seedBytes, encoded...))
		if bytes.Compare(digest[:diffLen], target) <= 0 {
			return string(encoded), true
		}
	}
	fallback := "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%q", seed)))
	return fallback, false
}

func mustJSON(value any) []byte {
	body, _ := json.Marshal(value)
	return body
}

func trimLast(value []byte) []byte {
	if len(value) == 0 {
		return value
	}
	return value[:len(value)-1]
}

func init() {
	var seedBytes [8]byte
	if _, err := rand.Read(seedBytes[:]); err == nil {
		var seed int64
		for _, b := range seedBytes {
			seed = (seed << 8) | int64(b)
		}
		mrand.Seed(seed)
	}
}
