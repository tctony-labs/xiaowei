package db

import (
	"context"
	"strings"
	"testing"
)

func TestInvalidMigrationVersions(t *testing.T) {
	for _, tc := range []struct {
		name  string
		steps []migration
		want  string
	}{
		{"sequence number", []migration{{version: 1}}, "timestamp"},
		{"invalid date", []migration{{version: 20261301000000}}, "timestamp"},
		{"duplicate timestamp", []migration{{version: 20261003100000}, {version: 20261003100000}}, "more than once"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Invalid registrations must fail before touching the database.
			err := migrate(context.Background(), nil, tc.steps)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("unexpected migration validation error: %v", err)
			}
		})
	}
}
