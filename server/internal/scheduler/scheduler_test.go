package scheduler

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestImmediateRunAndRetryAfterFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		stop := Start(context.Background(), Task{
			Name:     "test",
			Interval: time.Hour,
			Timeout:  time.Minute,
			Run: func(context.Context) error {
				calls.Add(1)
				return errors.New("temporary failure")
			},
		})
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatalf("startup runs = %d, want 1", calls.Load())
		}

		time.Sleep(time.Hour)
		synctest.Wait()
		if calls.Load() != 2 {
			t.Fatalf("runs after interval = %d, want 2", calls.Load())
		}

		stop()
		stop()
		time.Sleep(time.Hour)
		synctest.Wait()
		if calls.Load() != 2 {
			t.Fatal("task ran after stop")
		}
	})
}

func TestTimeoutDoesNotOverlapAndStopWaitsForCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		var finished atomic.Int32
		stop := Start(context.Background(), Task{
			Name:     "test",
			Interval: time.Minute,
			Timeout:  3 * time.Minute,
			Run: func(ctx context.Context) error {
				calls.Add(1)
				<-ctx.Done()
				finished.Add(1)
				return ctx.Err()
			},
		})
		synctest.Wait()
		time.Sleep(2 * time.Minute)
		synctest.Wait()
		if calls.Load() != 1 || finished.Load() != 0 {
			t.Fatal("task executions overlapped")
		}

		time.Sleep(time.Minute)
		synctest.Wait()
		if calls.Load() != 2 || finished.Load() != 1 {
			t.Fatal("timed-out task did not finish and retry")
		}

		stop()
		if finished.Load() != 2 {
			t.Fatal("stop returned before the running task finished")
		}
	})
}

func TestCanceledParentDoesNotRunTask(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		calls := 0
		stop := Start(ctx, Task{
			Name:     "test",
			Interval: time.Hour,
			Timeout:  time.Minute,
			Run: func(context.Context) error {
				calls++
				return nil
			},
		})
		stop()
		if calls != 0 {
			t.Fatal("task ran with a canceled parent")
		}
	})
}
