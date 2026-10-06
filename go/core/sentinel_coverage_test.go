package core

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestCacheMissSentinel_StringAndIdentity(t *testing.T) {
	if got := CacheMiss.String(); got != "CACHE_MISS" {
		t.Fatalf("CacheMiss.String() = %q, want CACHE_MISS", got)
	}
	// fmt must pick up the Stringer so logs show the sentinel name, not a pointer.
	if got := fmt.Sprintf("%v", CacheMiss); got != "CACHE_MISS" {
		t.Fatalf("fmt %%v of CacheMiss = %q, want CACHE_MISS", got)
	}
	// Identity, not equality: a second sentinel value must not be mistaken for a miss.
	var asAny any = CacheMiss
	if asAny != any(CacheMiss) {
		t.Fatal("CacheMiss must compare equal to itself through an interface")
	}
	if other := any(&cacheMissSentinel{}); other == asAny {
		t.Fatal("a distinct sentinel pointer must not equal CacheMiss")
	}
}

func TestErrCacheMiss_IsDetectableWhenWrapped(t *testing.T) {
	if ErrCacheMiss.Error() != "cache: key not found" {
		t.Fatalf("ErrCacheMiss message = %q", ErrCacheMiss.Error())
	}
	wrapped := fmt.Errorf("redis get user:1: %w", ErrCacheMiss)
	if !errors.Is(wrapped, ErrCacheMiss) {
		t.Fatal("wrapped ErrCacheMiss must satisfy errors.Is")
	}
	if errors.Is(errors.New("cache: key not found"), ErrCacheMiss) {
		t.Fatal("an unrelated error with the same text must not match ErrCacheMiss")
	}
	if errors.Is(context.Canceled, ErrCacheMiss) {
		t.Fatal("context.Canceled must not match ErrCacheMiss")
	}
}
