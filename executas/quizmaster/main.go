// Pixel Trivia · Bit the Quizmaster — the backend tool (Anna Executa) for the Pixel Trivia app.
//
// One static binary (Go standard library only, CGO disabled): it runs on any Linux, macOS or
// Windows machine without an interpreter, which is what Anna's Cloud Agent needs.
//
// Protocol: Executa JSON-RPC 2.0 over stdin/stdout, one JSON object per line.
//   - stdout carries protocol messages only; logs go to stderr
//   - every response echoes the request id and ends with "\n"
//   - `describe` returns the manifest directly in `result` (no wrapper)
//   - the process keeps reading stdin until it closes
//
// All AI work runs on Anna's LLM through reverse sampling (`sampling/createMessage`), so no API
// key lives here. Prompts come from prompts.json (embedded), shared with the app's fallback path.
//
// Methods (via `invoke`): make_lesson, make_quiz, check_quiz, explain, recap, ping.
package main

import (
	"bufio"
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed manifest.json
var manifestJSON []byte

//go:embed prompts.json
var promptsJSON []byte

var (
	manifest map[string]any
	prompts  map[string]any
	version  = "0.0.0"
)

const samplingTimeout = 75 * time.Second

// ---------- wire types ----------

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// ---------- output (serialised; one line per message) ----------

var outMu sync.Mutex

func writeMsg(v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf) // Encode appends exactly one "\n"
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		logf("encode failed: %v", err)
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	os.Stdout.Write(buf.Bytes())
}

func reply(id json.RawMessage, result any) {
	if len(id) == 0 {
		return // notifications get no reply
	}
	writeMsg(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func replyError(id json.RawMessage, code int, msg string) {
	if len(id) == 0 {
		return
	}
	writeMsg(map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError{Code: code, Message: msg}})
}

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[quizmaster] "+format+"\n", a...)
}

// ---------- reverse sampling ----------

var (
	pendingMu sync.Mutex
	pending   = map[string]chan envelope{}
	reqSeq    atomic.Int64
)

func idKey(raw json.RawMessage) string { return string(bytes.TrimSpace(raw)) }

// sample asks the Anna host to run its LLM and returns the reply text.
func sample(system, user string, maxTokens int, temperature float64) (string, error) {
	id := fmt.Sprintf("\"qm-s-%d\"", reqSeq.Add(1))
	ch := make(chan envelope, 1)
	pendingMu.Lock()
	pending[id] = ch
	pendingMu.Unlock()
	defer func() { pendingMu.Lock(); delete(pending, id); pendingMu.Unlock() }()

	writeMsg(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"method":  "sampling/createMessage",
		"params": map[string]any{
			"messages":     []any{map[string]any{"role": "user", "content": map[string]any{"type": "text", "text": user}}},
			"systemPrompt": system,
			"maxTokens":    maxTokens,
			"temperature":  temperature,
		},
	})

	select {
	case env := <-ch:
		if env.Error != nil {
			return "", fmt.Errorf("%d %s", env.Error.Code, env.Error.Message)
		}
		return contentText(env.Result), nil
	case <-time.After(samplingTimeout):
		return "", errors.New("sampling timed out")
	case <-stdinClosed:
		return "", errors.New("stdin closed before the sampling reply arrived")
	}
}

// contentText pulls the text out of a sampling result ({content:{type,text}} or a list of parts).
func contentText(raw json.RawMessage) string {
	var res struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &res) != nil {
		return ""
	}
	var one struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(res.Content, &one) == nil && one.Text != "" {
		return one.Text
	}
	var many []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(res.Content, &many) == nil {
		var b strings.Builder
		for _, p := range many {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	var s string
	if json.Unmarshal(res.Content, &s) == nil {
		return s
	}
	return ""
}

// ---------- helpers ----------

var spaces = regexp.MustCompile(`\s+`)

// clean trims, collapses whitespace and strips stray markdown emphasis.
func clean(v any) string {
	s, _ := v.(string)
	s = strings.NewReplacer("**", "", "__", "", "`", "").Replace(s)
	return strings.TrimSpace(spaces.ReplaceAllString(s, " "))
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return strings.TrimSpace(string(r[:n-1])) + "…"
	}
	return s
}

func str(args map[string]any, key, def string, max int) string {
	s := clean(args[key])
	if s == "" {
		s = def
	}
	return clip(s, max)
}

func intArg(args map[string]any, key string, def, lo, hi int) int {
	n := def
	switch v := args[key].(type) {
	case float64:
		n = int(v)
	case string:
		fmt.Sscanf(v, "%d", &n)
	}
	if n < lo {
		n = lo
	}
	if n > hi {
		n = hi
	}
	return n
}

func boolArg(args map[string]any, key string, def bool) bool {
	if v, ok := args[key].(bool); ok {
		return v
	}
	return def
}

func prompt(key string) string { s, _ := prompts[key].(string); return s }

func fill(tpl string, vars map[string]string) string {
	for k, v := range vars {
		tpl = strings.ReplaceAll(tpl, "{{"+k+"}}", v)
	}
	return tpl
}

func levelText(level string) string {
	if m, ok := prompts["levels"].(map[string]any); ok {
		if s, ok := m[level].(string); ok {
			return s
		}
	}
	return "medium (keen learners)"
}

func normLevel(s string) string {
	switch strings.ToLower(s) {
	case "easy", "medium", "hard":
		return strings.ToLower(s)
	}
	return "medium"
}

// parseJSON finds the JSON object in a model reply (tolerating prose or code fences around it).
func parseJSON(text string) (map[string]any, error) {
	text = strings.TrimSpace(text)
	i, j := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if i < 0 || j <= i {
		return nil, errors.New("no JSON object in the reply")
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(text[i:j+1]), &obj); err != nil {
		return nil, fmt.Errorf("reply was not valid JSON: %v", err)
	}
	return obj, nil
}

func ok(data any) map[string]any     { return map[string]any{"success": true, "data": data} }
func fail(msg string) map[string]any { return map[string]any{"success": false, "error": msg} }

func lines(v any, max int) string {
	var out []string
	switch x := v.(type) {
	case []any:
		for _, it := range x {
			if s := clean(it); s != "" {
				out = append(out, "- "+clip(s, 200))
			}
		}
	case string:
		for _, s := range strings.Split(x, "\n") {
			if s = clean(s); s != "" {
				out = append(out, "- "+clip(strings.TrimPrefix(s, "- "), 200))
			}
		}
	}
	if len(out) > max {
		out = out[len(out)-max:]
	}
	if len(out) == 0 {
		return "(none)"
	}
	return strings.Join(out, "\n")
}

// ---------- question validation (mirrors validateQuestion in bundle/lib/ai.js) ----------

type question struct {
	Q     string   `json:"q"`
	A     string   `json:"a"`
	Wrong []string `json:"wrong"`
	Exp   string   `json:"exp"`
	Hint  string   `json:"hint"`
}

var (
	banned      = regexp.MustCompile(`(?i)\b(all|none|both) of the above\b|\b(currently|as of|at present|this year|nowadays|right now)\b|\blatest\b|\bmost recent\b`)
	nonWord     = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	letterRegex = regexp.MustCompile(`[A-DX]`)
)

func key(s string) string { return strings.TrimSpace(nonWord.ReplaceAllString(strings.ToLower(s), " ")) }

// containsWord reports whether answer appears in the question as whole words (case-insensitive).
func containsWord(q, a string) bool {
	ka := key(a)
	if len([]rune(ka)) < 3 {
		return false
	}
	return strings.Contains(" "+key(q)+" ", " "+ka+" ")
}

func validate(raw any) (question, string) {
	m, _ := raw.(map[string]any)
	if m == nil {
		return question{}, "not an object"
	}
	q := question{Q: clean(m["q"]), A: clean(m["a"]), Exp: clip(clean(m["exp"]), 260), Hint: clip(clean(m["hint"]), 110)}
	if q.Q == "" || q.A == "" {
		return q, "missing question or answer"
	}
	if len([]rune(q.Q)) > 220 || len([]rune(q.A)) > 90 {
		return q, "too long"
	}
	seen := map[string]bool{key(q.A): true}
	if ws, ok := m["wrong"].([]any); ok {
		for _, w := range ws {
			s := clean(w)
			k := key(s)
			if s == "" || seen[k] || len([]rune(s)) > 90 {
				continue
			}
			seen[k] = true
			q.Wrong = append(q.Wrong, s)
			if len(q.Wrong) == 3 {
				break
			}
		}
	}
	if len(q.Wrong) != 3 {
		return q, "needs three different wrong options"
	}
	all := q.Q + " " + q.A + " " + strings.Join(q.Wrong, " ")
	if banned.MatchString(all) {
		return q, "time-sensitive or 'of the above' wording"
	}
	if containsWord(q.Q, q.A) {
		return q, "the question gives the answer away"
	}
	return q, ""
}

func validateAll(raw any, avoid map[string]bool) (kept []question, dropped int) {
	list, _ := raw.([]any)
	seen := map[string]bool{}
	for _, it := range list {
		q, why := validate(it)
		k := key(q.Q)
		if why != "" || seen[k] || avoid[k] {
			dropped++
			continue
		}
		seen[k] = true
		kept = append(kept, q)
	}
	return
}

// ---------- methods ----------

func makeLesson(args map[string]any) map[string]any {
	subject := str(args, "subject", "", 40)
	topic := str(args, "topic", "", 80)
	if subject == "" || topic == "" {
		return fail("subject and topic are required")
	}
	cards := intArg(args, "cards", 4, 3, 5)
	level := normLevel(str(args, "level", "medium", 10))
	vars := map[string]string{"subject": subject, "topic": topic, "level": levelText(level), "cards": fmt.Sprint(cards), "avoid": lines(args["avoid"], 20)}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := sample(fill(prompt("lesson_system"), vars), fill(prompt("lesson_user"), vars), 900, 0.7)
		if err != nil {
			return fail("make_lesson failed: " + err.Error())
		}
		obj, err := parseJSON(raw)
		if err != nil {
			lastErr = err
			continue
		}
		var out []map[string]string
		if cs, ok := obj["cards"].([]any); ok {
			for _, c := range cs {
				cm, _ := c.(map[string]any)
				fact := clip(clean(cm["fact"]), 260)
				if fact == "" {
					continue
				}
				out = append(out, map[string]string{"title": clip(clean(cm["title"]), 40), "fact": fact, "hook": clip(clean(cm["hook"]), 140)})
			}
		}
		if len(out) < 2 {
			lastErr = errors.New("the lesson came back without enough cards")
			continue
		}
		if len(out) > cards {
			out = out[:cards]
		}
		title := clip(clean(obj["title"]), 48)
		if title == "" {
			title = topic
		}
		return ok(map[string]any{"title": title, "intro": clip(clean(obj["intro"]), 120), "cards": out, "subject": subject, "topic": topic, "level": level})
	}
	return fail("make_lesson failed: " + lastErr.Error())
}

func generateQuestions(args map[string]any) ([]question, int, error) {
	subject := str(args, "subject", "", 40)
	topic := str(args, "topic", "", 80)
	if subject == "" {
		return nil, 0, errors.New("subject is required")
	}
	if topic == "" {
		topic = "anything in " + subject
	}
	count := intArg(args, "count", 5, 1, 10)
	level := normLevel(str(args, "level", "medium", 10))
	lesson := clip(clean(args["lesson"]), 2400)
	fromLesson := intArg(args, "from_lesson", 0, 0, count)
	if lesson == "" {
		lesson, fromLesson = "(no lesson)", 0
	} else if fromLesson == 0 {
		fromLesson = count
	}
	avoid := map[string]bool{}
	if xs, ok := args["avoid"].([]any); ok {
		for _, x := range xs {
			avoid[key(clean(x))] = true
		}
	}
	// Ask for a couple of spares: the format check and the second check may drop some.
	ask := count + 2
	if count >= 8 {
		ask = count + 3
	}
	vars := map[string]string{"subject": subject, "topic": topic, "level": levelText(level), "count": fmt.Sprint(ask),
		"lesson": lesson, "from_lesson": fmt.Sprint(fromLesson), "avoid": lines(args["avoid"], 30)}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := sample(fill(prompt("quiz_system"), vars), fill(prompt("quiz_user"), vars), 260*ask+300, 0.6)
		if err != nil {
			return nil, 0, err
		}
		obj, err := parseJSON(raw)
		if err != nil {
			lastErr = err
			continue
		}
		kept, dropped := validateAll(obj["questions"], avoid)
		if len(kept) == 0 {
			lastErr = errors.New("no usable questions came back")
			continue
		}
		return kept, dropped, nil
	}
	return nil, 0, lastErr
}

// checkQuestions answers every question blind (options shuffled, no key) and keeps only those
// where the blind answer matches the key. Returns one verdict per question.
func checkQuestions(qs []question) ([]bool, []string, error) {
	if len(qs) == 0 {
		return nil, nil, nil
	}
	letters := []string{"A", "B", "C", "D"}
	correct := make([]string, len(qs))
	var b strings.Builder
	for i, q := range qs {
		opts := append([]string{q.A}, q.Wrong...)
		order := rand.Perm(4)
		fmt.Fprintf(&b, "%d. %s\n", i+1, q.Q)
		for j, o := range order {
			fmt.Fprintf(&b, "%s) %s\n", letters[j], opts[o])
			if o == 0 {
				correct[i] = letters[j]
			}
		}
		b.WriteString("\n")
	}
	raw, err := sample(prompt("check_system"), b.String(), 40+12*len(qs), 0)
	if err != nil {
		return nil, nil, err
	}
	obj, err := parseJSON(raw)
	if err != nil {
		return nil, nil, err
	}
	ans, _ := obj["answers"].([]any)
	if len(ans) != len(qs) {
		return nil, nil, fmt.Errorf("the check returned %d answers for %d questions", len(ans), len(qs))
	}
	keep := make([]bool, len(qs))
	picked := make([]string, len(qs))
	for i, a := range ans {
		s, _ := a.(string)
		picked[i] = letterRegex.FindString(strings.ToUpper(s))
		keep[i] = picked[i] != "" && picked[i] == correct[i]
	}
	return keep, picked, nil
}

func questionsOut(qs []question) []map[string]any {
	out := make([]map[string]any, 0, len(qs))
	for _, q := range qs {
		out = append(out, map[string]any{"q": q.Q, "a": q.A, "wrong": q.Wrong, "exp": q.Exp, "hint": q.Hint})
	}
	return out
}

func makeQuiz(args map[string]any) map[string]any {
	qs, dropped, err := generateQuestions(args)
	if err != nil {
		return fail("make_quiz failed: " + err.Error())
	}
	count := intArg(args, "count", 5, 1, 10)
	checked := false
	if boolArg(args, "check", true) {
		if keep, _, err := checkQuestions(qs); err != nil {
			logf("check skipped: %v", err)
		} else {
			checked = true
			var kept []question
			for i, q := range qs {
				if keep[i] {
					kept = append(kept, q)
				} else {
					dropped++
				}
			}
			qs = kept
		}
	}
	if len(qs) > count {
		qs = qs[:count]
	}
	if len(qs) == 0 {
		return fail("make_quiz failed: every question was dropped by the checks")
	}
	return ok(map[string]any{"questions": questionsOut(qs), "dropped": dropped, "checked": checked})
}

func checkQuiz(args map[string]any) map[string]any {
	list, _ := args["questions"].([]any)
	if len(list) == 0 {
		return fail("questions are required")
	}
	if len(list) > 12 {
		return fail("check up to 12 questions at a time")
	}
	qs := make([]question, len(list))
	for i, it := range list {
		q, why := validate(it)
		if why != "" {
			return fail(fmt.Sprintf("question %d is malformed: %s", i+1, why))
		}
		qs[i] = q
	}
	keep, picked, err := checkQuestions(qs)
	if err != nil {
		return fail("check_quiz failed: " + err.Error())
	}
	return ok(map[string]any{"keep": keep, "picked": picked})
}

func explain(args map[string]any) map[string]any {
	q := str(args, "q", "", 240)
	a := str(args, "a", "", 120)
	if q == "" || a == "" {
		return fail("q and a are required")
	}
	vars := map[string]string{"q": q, "a": a, "chosen": str(args, "chosen", "(ran out of time)", 120)}
	raw, err := sample(prompt("explain_system"), fill(prompt("explain_user"), vars), 220, 0.4)
	if err != nil {
		return fail("explain failed: " + err.Error())
	}
	return textResult(raw, "explain")
}

func recap(args map[string]any) map[string]any {
	vars := map[string]string{
		"name": str(args, "name", "the player", 24), "subject": str(args, "subject", "Mixed", 40), "topic": str(args, "topic", "Mixed", 80),
		"right": fmt.Sprint(intArg(args, "right", 0, 0, 100)), "total": fmt.Sprint(intArg(args, "total", 0, 0, 100)),
		"got": lines(args["got"], 12), "missed": lines(args["missed"], 12),
	}
	raw, err := sample(prompt("recap_system"), fill(prompt("recap_user"), vars), 240, 0.7)
	if err != nil {
		return fail("recap failed: " + err.Error())
	}
	return textResult(raw, "recap")
}

func textResult(raw, what string) map[string]any {
	text := ""
	if obj, err := parseJSON(raw); err == nil {
		text = clean(obj["text"])
	}
	if text == "" {
		text = strings.Trim(clean(raw), "\"'{} ")
	}
	if text == "" {
		return fail(what + " came back empty")
	}
	return ok(map[string]any{"text": clip(text, 420)})
}

func invoke(tool string, args map[string]any) (res map[string]any) {
	defer func() { // never let one bad call take the process down
		if r := recover(); r != nil {
			logf("invoke %s panicked: %v", tool, r)
			res = fail(fmt.Sprintf("%s failed: internal error", tool))
		}
	}()
	if args == nil {
		args = map[string]any{}
	}
	switch tool {
	case "ping":
		return ok(map[string]any{"pong": true, "version": version})
	case "make_lesson":
		return makeLesson(args)
	case "make_quiz":
		return makeQuiz(args)
	case "check_quiz":
		return checkQuiz(args)
	case "explain":
		return explain(args)
	case "recap":
		return recap(args)
	}
	return fail("unknown method: " + tool)
}

// ---------- dispatch ----------

type invokeParams struct {
	Tool      string         `json:"tool"`
	Method    string         `json:"method"`
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
	Args      map[string]any `json:"args"`
}

var (
	stdinClosed = make(chan struct{})
	inflight    sync.WaitGroup
)

func dispatch(env envelope) {
	switch env.Method {
	case "initialize":
		reply(env.ID, map[string]any{
			"protocolVersion": "2.0",
			"server_info":     map[string]any{"name": manifest["display_name"], "version": version},
			"capabilities":    map[string]any{"sampling": map[string]any{}},
		})
	case "describe":
		reply(env.ID, json.RawMessage(compactManifest))
	case "health":
		reply(env.ID, map[string]any{"status": "ready", "version": version})
	case "invoke":
		var p invokeParams
		_ = json.Unmarshal(env.Params, &p)
		tool := firstNonEmpty(p.Tool, p.Method, p.Name)
		args := p.Arguments
		if args == nil {
			args = p.Args
		}
		// Run invokes concurrently so the reader keeps routing sampling replies.
		inflight.Add(1)
		go func(id json.RawMessage) {
			defer inflight.Done()
			reply(id, invoke(tool, args))
		}(env.ID)
	case "shutdown":
		reply(env.ID, map[string]any{})
	default:
		if strings.HasPrefix(env.Method, "notifications/") {
			return
		}
		replyError(env.ID, -32601, "unknown rpc: "+env.Method)
	}
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

var compactManifest []byte

func main() {
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		logf("bad embedded manifest: %v", err)
		os.Exit(1)
	}
	if err := json.Unmarshal(promptsJSON, &prompts); err != nil {
		logf("bad embedded prompts: %v", err)
		os.Exit(1)
	}
	if v, ok := manifest["version"].(string); ok {
		version = v
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, manifestJSON); err != nil {
		logf("bad embedded manifest: %v", err)
		os.Exit(1)
	}
	compactManifest = buf.Bytes()

	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println("pixel-trivia-quizmaster", version)
		return
	}
	logf("Bit the Quizmaster %s ready", version)

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var env envelope
		if err := json.Unmarshal(line, &env); err != nil {
			logf("ignoring non-JSON line")
			continue
		}
		if env.Method == "" && len(env.ID) > 0 { // a reply to one of our sampling requests
			pendingMu.Lock()
			ch := pending[idKey(env.ID)]
			pendingMu.Unlock()
			if ch != nil {
				ch <- env
			}
			continue
		}
		dispatch(env)
	}
	if err := sc.Err(); err != nil {
		logf("stdin read error: %v", err)
	}
	close(stdinClosed)
	inflight.Wait()
}
