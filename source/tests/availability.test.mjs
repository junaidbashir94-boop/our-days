import test from 'node:test';
import assert from 'node:assert/strict';
import {availabilityAt,availabilityIntervals,confirmedFullDayOff,importChangeSummary,normalizePreferences} from '../public/availability.js';
import {planCalendarRange,localDateTimeToUtc} from '../public/calendar-export.js';
const off={entry_type:'off'},night={entry_type:'shift',shift_start_min:1320,shift_end_min:510};
test('night recovery agrees with full-day, breakfast and evening availability',()=>{
  const input={current:off,previous:night};
  assert.equal(confirmedFullDayOff(input),false);
  assert.equal(availabilityAt(input,540),'busy');
  assert.equal(availabilityAt(input,959),'busy');
  assert.equal(availabilityAt(input,960),'free');
});
test('missing and malformed schedules never become free',()=>{
  assert.equal(availabilityAt({},1200),'unknown');assert.equal(confirmedFullDayOff({}),false);
  assert.equal(availabilityAt({current:{entry_type:'shift'}},1200),'unknown');
});
test('manual availability takes precedence over imported shift and recovery',()=>{
  assert.equal(availabilityAt({current:off,previous:night,overrides:[{meal:'breakfast',status:'available'}]},540),'free');
  assert.equal(availabilityAt({current:off,overrides:[{meal:'dinner',status:'unavailable'}]},1200),'busy');
});
test('travel buffers cross day boundaries',()=>{
  assert.equal(availabilityAt({current:off,next:{entry_type:'shift',shift_start_min:15,shift_end_min:500},preferences:{commuteBefore:60}},1400),'busy');
  assert.equal(availabilityAt({current:off,previous:{entry_type:'shift',shift_start_min:900,shift_end_min:1430},preferences:{commuteAfter:30}},10),'busy');
});
test('zero recovery preference is respected, but shift end still blocks availability',()=>{
  const x={current:off,previous:night,preferences:{postNightUntil:0}};
  assert.equal(availabilityAt(x,509),'busy');assert.equal(availabilityAt(x,510),'free');
});
test('derived intervals merge adjacent identical states',()=>assert.deepEqual(availabilityIntervals({current:off}),[{start:0,end:1440,status:'free'}]));
test('lunch override blocks noon–16:00 and full-day free status',()=>{
  const x={overrides:[{meal:'breakfast',status:'available'},{meal:'lunch',status:'unavailable'},{meal:'dinner',status:'available'}]};
  assert.equal(availabilityAt(x,840),'busy');assert.equal(confirmedFullDayOff(x),false);
  assert.equal(availabilityAt(x,540),'free');assert.equal(availabilityAt(x,1200),'free');
});
test('import preview protects manual entries and rejects duplicate mappings',()=>{
  const rows=[{member_id:'a',day:'2030-01-01'},{member_id:'a',day:'2030-01-02'}];
  assert.deepEqual(importChangeSummary(rows,[{...rows[0],source:'manual'}]),{added:1,replaced:0,preserved:1});
  assert.throws(()=>importChangeSummary([rows[0],rows[0]],[]),/same person and date/);
});
test('invalid preferences return explicit defaults',()=>assert.equal(normalizePreferences({postNightUntil:-1}).postNightUntil,960));
test('calendar export preserves full selected duration and London summer time',()=>assert.deepEqual(planCalendarRange({day:'2030-07-01',start_min:1020,end_min:1320,time_zone:'Europe/London'}),{start:'20300701T160000Z',end:'20300701T210000Z'}));
test('calendar export supports overnight and winter time',()=>assert.deepEqual(planCalendarRange({day:'2030-01-01',start_min:1320,end_min:1500,time_zone:'Europe/London'}),{start:'20300101T220000Z',end:'20300102T010000Z'}));
test('nonexistent DST wall time is rejected',()=>assert.throws(()=>localDateTimeToUtc('2030-03-31',90,'Europe/London'),/clocks change/));
