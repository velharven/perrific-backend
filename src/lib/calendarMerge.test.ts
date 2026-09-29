import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDate, mergeCalendarValues, type CalendarValues } from './calendarMerge';

const baseline: CalendarValues = {
  title: 'Original',
  description: 'Original description',
  start: '2026-09-29T07:00:00Z',
  end: '2026-09-29T08:00:00Z',
  color: null,
  recurrence: null,
  checklist: '',
};

test('merges a local reschedule with a Google title edit', () => {
  const local = { ...baseline, start: '2026-09-30T07:00:00Z', end: '2026-09-30T08:00:00Z' };
  const remote = { ...baseline, title: 'Google title' };
  assert.deepEqual(
    mergeCalendarValues(
      baseline,
      local,
      remote,
      { start: '2026-09-29T03:01:00Z', end: '2026-09-29T03:01:00Z' },
      '2026-09-29T03:02:00Z',
    ),
    { ...local, title: remote.title },
  );
});

test('latest change wins a conflicting field, including clearing a description', () => {
  const local = { ...baseline, description: '' };
  const remote = { ...baseline, description: 'Google description' };
  assert.equal(
    mergeCalendarValues(
      baseline,
      local,
      remote,
      { description: '2026-09-29T03:03:00Z' },
      '2026-09-29T03:02:00Z',
    ).description,
    '',
  );
  assert.equal(
    mergeCalendarValues(
      baseline,
      local,
      remote,
      { description: '2026-09-29T03:01:00Z' },
      '2026-09-29T03:02:00Z',
    ).description,
    remote.description,
  );
});

test('an unrelated reorder timestamp cannot override a Google edit', () => {
  const local = { ...baseline };
  const remote = { ...baseline, title: 'Google title' };
  assert.equal(
    mergeCalendarValues(baseline, local, remote, {}, '2026-09-29T03:02:00Z').title,
    remote.title,
  );
});

test('date-only events stay on their date and timed events use Jakarta calendar days', () => {
  assert.equal(calendarDate('2026-09-29'), '2026-09-29');
  assert.equal(calendarDate('2026-09-29T18:00:00Z'), '2026-09-30');
});
