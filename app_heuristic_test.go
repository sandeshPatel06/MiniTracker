package main

import (
	"testing"

	"github.com/reak/get-hike/internal/db"
)

func TestHeuristicChunkScore(t *testing.T) {
	t.Run("empty chunk is idle", func(t *testing.T) {
		r := heuristicChunkScore(nil)
		if r.score != 5 || r.category != "Idle" {
			t.Fatalf("expected idle 5, got %v %s", r.score, r.category)
		}
	})

	t.Run("reading with clear visibility scores productive", func(t *testing.T) {
		r := heuristicChunkScore([]db.LogEntry{{AppName: "firefox", WindowTitle: "Docs"}, {AppName: "firefox"}})
		if r.score < 50 || r.score > 95 {
			t.Fatalf("score %v out of heuristic range", r.score)
		}
		if r.appName != "firefox" || r.appCategory != "Heuristic" || r.confidence != 0.4 {
			t.Fatalf("unexpected meta: %+v", r)
		}
	})

	t.Run("typing raises score above reading", func(t *testing.T) {
		reading := heuristicChunkScore([]db.LogEntry{{AppName: "zed"}})
		typing := heuristicChunkScore([]db.LogEntry{{AppName: "zed", TotalKeys: 120, EntropyScore: 70}})
		if typing.score <= reading.score {
			t.Fatalf("typing %v should beat reading %v", typing.score, reading.score)
		}
		if typing.score > 95 {
			t.Fatalf("typing score capped at 95, got %v", typing.score)
		}
	})
}
