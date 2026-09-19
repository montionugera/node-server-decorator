package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core"
)

type ExpectedPayload struct {
	EventName string          `json:"eventName"`
	Payload   json.RawMessage `json:"payload"`
}

type Fixture struct {
	Messages []ExpectedPayload `json:"messages"`
}

// sendRESP sends raw RESP commands to Redis over plain TCP without external dependencies.
func sendRESP(conn net.Conn, reader *bufio.Reader, args ...string) ([]byte, error) {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("*%d\r\n", len(args)))
	for _, arg := range args {
		sb.WriteString(fmt.Sprintf("$%d\r\n%s\r\n", len([]byte(arg)), arg))
	}
	if _, err := conn.Write([]byte(sb.String())); err != nil {
		return nil, err
	}

	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	if len(line) == 0 {
		return nil, fmt.Errorf("empty redis response")
	}

	switch line[0] {
	case '+': // Simple string
		return bytesTrimCRLF(line[1:]), nil
	case ':': // Integer
		return bytesTrimCRLF(line[1:]), nil
	case '$': // Bulk string
		lengthStr := string(bytesTrimCRLF(line[1:]))
		length, err := strconv.Atoi(lengthStr)
		if err != nil {
			return nil, err
		}
		if length == -1 {
			return nil, nil // null bulk string
		}
		buf := make([]byte, length+2)
		var readTotal int
		for readTotal < length+2 {
			n, err := reader.Read(buf[readTotal:])
			if err != nil {
				return nil, err
			}
			readTotal += n
		}
		return buf[:length], nil
	case '-': // Error
		return nil, fmt.Errorf("redis error: %s", string(bytesTrimCRLF(line[1:])))
	default:
		return bytesTrimCRLF(line), nil
	}
}

func bytesTrimCRLF(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\r' || b[len(b)-1] == '\n') {
		b = b[:len(b)-1]
	}
	return b
}

func parseHostPort(rawURL string) (string, error) {
	if !strings.Contains(rawURL, "://") {
		rawURL = "redis://" + rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	host := u.Host
	if !strings.Contains(host, ":") {
		host = host + ":6379"
	}
	return host, nil
}

func main() {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}
	stream := os.Getenv("INTEROP_STREAM")
	if stream == "" {
		stream = "interop"
	}

	fixturePath := os.Getenv("FIXTURE_PATH")
	if fixturePath == "" {
		// default relative to root
		fixturePath = filepath.Join("interop", "shared", "expected-payloads.json")
	}

	data, err := os.ReadFile(fixturePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to read fixture %s: %v\n", fixturePath, err)
		os.Exit(1)
	}

	var fixture Fixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		fmt.Fprintf(os.Stderr, "failed to parse fixture: %v\n", err)
		os.Exit(1)
	}

	host, err := parseHostPort(redisURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid redis url %s: %v\n", redisURL, err)
		os.Exit(1)
	}

	conn, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to connect to redis at %s: %v\n", host, err)
		os.Exit(1)
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)

	// Send PING
	if _, err := sendRESP(conn, reader, "PING"); err != nil {
		fmt.Fprintf(os.Stderr, "failed to ping redis: %v\n", err)
		os.Exit(1)
	}

	topic := "orders"
	for _, expected := range fixture.Messages {
		msg := core.QueueMessage{
			EventName: expected.EventName,
			Payload:   expected.Payload,
			Timestamp: time.Now().UnixMilli(),
			Metadata: &core.QueueMessageMetadata{
				ClassName:  "OrderService",
				MethodName: "createOrder",
				Topic:      &topic,
			},
		}

		payloadBytes, err := json.Marshal(msg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to marshal QueueMessage: %v\n", err)
			os.Exit(1)
		}

		// XADD stream * data <payloadBytes>
		_, err = sendRESP(conn, reader, "XADD", stream, "*", "data", string(payloadBytes))
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to XADD message: %v\n", err)
			os.Exit(1)
		}
	}

	fmt.Printf("producer: wrote %d messages to stream %s\n", len(fixture.Messages), stream)
}
