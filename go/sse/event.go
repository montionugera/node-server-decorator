package sse

import (
	"bytes"
	"encoding/json"
)

// Event represents a typed Server-Sent Event frame.
type Event[T any] struct {
	ID        string `json:"id,omitempty"`
	Event     string `json:"event,omitempty"`
	Data      T      `json:"data"`
	Timestamp int64  `json:"timestamp,omitempty"`
}

// Format formats the event into a standard SSE wire frame:
//
//	id: <ID>\n (if ID set)
//	event: <Event>\n (if Event set)
//	data: <JSON serialized Data>\n\n
func (e Event[T]) Format() ([]byte, error) {
	dataBytes, err := json.Marshal(e.Data)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	if e.ID != "" {
		buf.WriteString("id: ")
		buf.WriteString(e.ID)
		buf.WriteByte('\n')
	}
	if e.Event != "" {
		buf.WriteString("event: ")
		buf.WriteString(e.Event)
		buf.WriteByte('\n')
	}

	lines := bytes.Split(dataBytes, []byte("\n"))
	for _, line := range lines {
		buf.WriteString("data: ")
		buf.Write(line)
		buf.WriteByte('\n')
	}
	buf.WriteByte('\n')

	return buf.Bytes(), nil
}
