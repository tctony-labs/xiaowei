package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"time"
)

func main() {
	client := &http.Client{Timeout: 2 * time.Second}
	if err := checkReadiness(client, "http://127.0.0.1:10001/readyz"); err != nil {
		_, _ = io.WriteString(os.Stderr, "server is not ready\n")
		os.Exit(1)
	}
}

func checkReadiness(client *http.Client, address string) error {
	response, err := client.Get(address)
	if err != nil {
		return errors.New("readiness request failed")
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return errors.New("unexpected readiness HTTP status")
	}
	var body struct {
		Code *int32 `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&body); err != nil {
		return errors.New("invalid readiness response")
	}
	if body.Code == nil || *body.Code != 0 {
		return errors.New("server is not ready")
	}
	return nil
}
