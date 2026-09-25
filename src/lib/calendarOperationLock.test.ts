import assert from 'node:assert/strict';
import test from 'node:test';
import { withUserCalendarLock } from './calendarOperationLock';

test('calendar operations for one user run in invocation order', async () => {
  const steps: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withUserCalendarLock('user-a', async () => {
    steps.push('delete-start');
    await firstGate;
    steps.push('delete-end');
  });
  const second = withUserCalendarLock('user-a', async () => {
    steps.push('sync-start');
  });

  try {
    await Promise.resolve();
    assert.deepEqual(steps, ['delete-start']);
  } finally {
    releaseFirst();
  }
  await Promise.all([first, second]);
  assert.deepEqual(steps, ['delete-start', 'delete-end', 'sync-start']);
});

test('calendar operations for different users do not block each other', async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withUserCalendarLock('user-b', async () => firstGate);
  try {
    const result = await withUserCalendarLock('user-c', async () => 'ready');
    assert.equal(result, 'ready');
  } finally {
    releaseFirst();
  }
  await first;
});
