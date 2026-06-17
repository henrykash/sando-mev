// Tiny shared test harness. Tests register via `test()` and are executed by
// `runAll()` so async cases are awaited (a synchronous try/catch would miss
// rejected promises and silently "pass").
type TestFn = () => void | Promise<void>;

const cases: { name: string; fn: TestFn }[] = [];
let passed = 0;
let failed = 0;

export function test(name: string, fn: TestFn) {
  cases.push({ name, fn });
}

export async function runAll(): Promise<void> {
  for (const { name, fn } of cases) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(`      ${(err as Error).message}`);
    }
  }
}

export function summary(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
