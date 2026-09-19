package dto_test

import (
	"regexp"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/dto"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

func TestGenerateGoStructsBindingTags(t *testing.T) {
	codeBytes, err := dto.GenerateGoStructs(example.UserSpec, "dto")
	if err != nil {
		t.Fatalf("unexpected error generating structs: %v", err)
	}

	code := string(codeBytes)

	// Verify UserCreateDTO has binding tags
	// Email is required with format "email"
	reEmailCreate := regexp.MustCompile(`Email\s+string\s+` + "`" + `json:"email"\s+binding:"required,email"` + "`")
	if !reEmailCreate.MatchString(code) {
		t.Errorf("expected Email in UserCreateDTO to have binding:\"required,email\", got:\n%s", code)
	}

	// Name is required
	reNameCreate := regexp.MustCompile(`Name\s+string\s+` + "`" + `json:"name"\s+binding:"required"` + "`")
	if !reNameCreate.MatchString(code) {
		t.Errorf("expected Name in UserCreateDTO to have binding:\"required\", got:\n%s", code)
	}

	// Profile is optional, so it should have omitempty
	reProfileCreate := regexp.MustCompile(`Profile\s+\*UserProfile\s+` + "`" + `json:"profile,omitempty"\s+binding:"omitempty"` + "`")
	if !reProfileCreate.MatchString(code) {
		t.Errorf("expected Profile in UserCreateDTO to have binding:\"omitempty\", got:\n%s", code)
	}

	// In UserUpdateDTO, fields are forceOptional so all have binding:"omitempty"
	reEmailUpdate := regexp.MustCompile(`Email\s+\*string\s+` + "`" + `json:"email,omitempty"\s+binding:"omitempty"` + "`")
	if !reEmailUpdate.MatchString(code) {
		t.Errorf("expected Email in UserUpdateDTO to have binding:\"omitempty\", got:\n%s", code)
	}
}
