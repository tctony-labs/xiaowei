package scheduler

import (
	"context"
	"log/slog"
	"time"
)

type Task struct {
	Name     string
	Interval time.Duration
	Timeout  time.Duration
	Run      func(context.Context) error
}

// Start runs a task immediately and then at its interval, without overlapping executions.
// The returned stop function cancels the task and waits for its goroutine to exit.
func Start(ctx context.Context, task Task) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})

	go func() {
		defer close(done)
		ticker := time.NewTicker(task.Interval)
		defer ticker.Stop()
		slog.Info("scheduled task started", "task", task.Name, "interval", task.Interval)

		for {
			if ctx.Err() != nil {
				return
			}

			taskCtx, taskCancel := context.WithTimeout(ctx, task.Timeout)
			err := task.Run(taskCtx)
			taskCancel()
			if err != nil && ctx.Err() == nil {
				slog.Error("scheduled task failed", "task", task.Name, "error", err)
			}

			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	return func() {
		cancel()
		<-done
	}
}
