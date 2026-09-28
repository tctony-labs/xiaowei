export interface FocusTarget {
  processId: number;
  restore(): Promise<boolean>;
  isFrontmost(): Promise<boolean>;
  release(): void;
}

export function createFocusSession(options: {
  capture(): Promise<FocusTarget | undefined>;
  frontmostProcess(): number | undefined;
  ownProcess: number;
}) {
  let generation = 0;
  let target: FocusTarget | undefined;
  let active = false;

  function abandon(): void {
    generation++;
    active = false;
    target?.release();
    target = undefined;
  }

  return {
    abandon,
    async begin(): Promise<boolean> {
      if (active) return true;
      const current = ++generation;
      const source = options.frontmostProcess();
      const captured = await options.capture();
      if (current !== generation || source !== options.frontmostProcess()) {
        captured?.release();
        return false;
      }
      target = captured;
      active = true;
      return true;
    },
    async restore(): Promise<boolean> {
      const captured = target;
      const current = ++generation;
      target = undefined;
      active = false;
      if (!captured) return false;
      try {
        const foreground = options.frontmostProcess();
        if (foreground !== options.ownProcess && foreground !== captured.processId) return false;
        if (!(await captured.restore()) || current !== generation) return false;
        const deadline = Date.now() + 500;
        while (current === generation && Date.now() < deadline) {
          const foreground = options.frontmostProcess();
          if (foreground !== options.ownProcess && foreground !== captured.processId) return false;
          if (await captured.isFrontmost()) return current === generation;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return false;
      } finally {
        captured.release();
      }
    },
  };
}
