package httperr

import (
	"encoding/json"
	"errors"
	"net/http"
)

type StatusError struct {
	Status int
	Msg    string
	// Extra holds additional top-level body fields; "error" is always Msg.
	Extra map[string]any
}

func (e *StatusError) Error() string { return e.Msg }

func Fail(status int, msg string) *StatusError { return &StatusError{Status: status, Msg: msg} }

// FailWith is Fail with extra top-level fields in the body, e.g. the current
// updatedAt on a 409. An "error" key in extra is ignored.
func FailWith(status int, msg string, extra map[string]any) *StatusError {
	return &StatusError{Status: status, Msg: msg, Extra: extra}
}

func Write(w http.ResponseWriter, err error) {
	var se *StatusError
	if errors.As(err, &se) {
		// Validate status code is in valid range
		if se.Status < 400 || se.Status > 599 {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": "处理失败，请稍后重试"})
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(se.Status)
		body := make(map[string]any, len(se.Extra)+1)
		for k, v := range se.Extra {
			body[k] = v
		}
		body["error"] = se.Msg
		json.NewEncoder(w).Encode(body)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	json.NewEncoder(w).Encode(map[string]string{"error": "处理失败，请稍后重试"})
}
