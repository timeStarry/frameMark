package httperr

import (
	"encoding/json"
	"errors"
	"net/http"
)

type StatusError struct {
	Status int
	Msg    string
}

func (e *StatusError) Error() string { return e.Msg }

func Fail(status int, msg string) *StatusError { return &StatusError{Status: status, Msg: msg} }

func Write(w http.ResponseWriter, err error) {
	var se *StatusError
	if errors.As(err, &se) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(se.Status)
		json.NewEncoder(w).Encode(map[string]string{"error": se.Msg})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	json.NewEncoder(w).Encode(map[string]string{"error": "处理失败，请稍后重试"})
}
