export const DEFAULT_PREFERENCES = Object.freeze({commuteBefore:0,commuteAfter:0,postNightUntil:960,minWindow:60,preferredPeriod:'any'});

export function normalizePreferences(raw={}) {
  const choice=(key,values)=>values.includes(raw[key])?raw[key]:DEFAULT_PREFERENCES[key];
  return {commuteBefore:choice('commuteBefore',[0,30,45,60]),commuteAfter:choice('commuteAfter',[0,30,45,60]),
    postNightUntil:Number.isInteger(raw.postNightUntil)&&raw.postNightUntil>=0&&raw.postNightUntil<1440?raw.postNightUntil:960,
    minWindow:choice('minWindow',[45,60,90,120]),preferredPeriod:choice('preferredPeriod',['any','breakfast','dinner'])};
}

export function availabilityAt({current,previous,next,preferences={},overrides=[]},minute) {
  if(!Number.isInteger(minute)||minute<0||minute>=1440)return 'unknown';
  const prefs=normalizePreferences(preferences);
  const meal=minute<720?'breakfast':minute<960?'lunch':'dinner';
  const override=overrides.find(x=>x.meal===meal);
  if(override?.status==='available')return 'free';
  if(override?.status==='unavailable')return 'busy';
  if(previous?.entry_type==='shift'&&Number.isInteger(previous.shift_start_min)&&Number.isInteger(previous.shift_end_min)){
    const overnight=previous.shift_end_min<=previous.shift_start_min;
    const end=overnight?Math.max(previous.shift_end_min+prefs.commuteAfter,prefs.postNightUntil):previous.shift_end_min+prefs.commuteAfter-1440;
    if(minute<end)return 'busy';
  }
  if(next?.entry_type==='shift'&&Number.isInteger(next.shift_start_min)&&minute>=1440+next.shift_start_min-prefs.commuteBefore)return 'busy';
  if(!current)return 'unknown';
  if(current.entry_type==='off')return 'free';
  if(current.entry_type==='busy')return 'busy';
  if(current.entry_type!=='shift')return 'unknown';
  const start=current.shift_start_min,end=current.shift_end_min;
  if(!Number.isInteger(start)||!Number.isInteger(end))return 'unknown';
  return minute>=start-prefs.commuteBefore&&(end<=start||minute<end+prefs.commuteAfter)?'busy':'free';
}

export function availabilityBoundaries(input) {
  const p=normalizePreferences(input.preferences);
  const {current:c,previous:b,next:n}=input;
  const points=[0,480,720,960,1440];
  if(c?.entry_type==='shift'){points.push(c.shift_start_min-p.commuteBefore);if(c.shift_end_min>c.shift_start_min)points.push(c.shift_end_min+p.commuteAfter);}
  if(b?.entry_type==='shift')points.push(b.shift_end_min<=b.shift_start_min?Math.max(b.shift_end_min+p.commuteAfter,p.postNightUntil):b.shift_end_min+p.commuteAfter-1440);
  if(n?.entry_type==='shift')points.push(1440+n.shift_start_min-p.commuteBefore);
  return [...new Set(points.filter(Number.isInteger).map(x=>Math.max(0,Math.min(1440,x))))].sort((a,b)=>a-b);
}

export function availabilityIntervals(input) {
  const points=availabilityBoundaries(input),result=[];
  for(let i=0;i<points.length-1;i++){
    const status=availabilityAt(input,points[i]),last=result.at(-1);
    if(last?.status===status)last.end=points[i+1];
    else result.push({start:points[i],end:points[i+1],status});
  }
  return result;
}

export function confirmedFullDayOff(input) {
  // A full day is 00:00–24:00, including overnight spill and travel buffers.
  return availabilityIntervals(input).every(x=>x.status==='free');
}

export function importChangeSummary(rows,existing) {
  const seen=new Set();let added=0,replaced=0,preserved=0;
  for(const row of rows){
    const key=`${row.member_id}:${row.day}`;
    if(seen.has(key))throw new Error('More than one selected shift maps to the same person and date. Review the person mapping.');
    seen.add(key);
    const old=existing.find(x=>x.member_id===row.member_id&&x.day===row.day);
    if(old?.source==='manual')preserved++;
    else if(old)replaced++;
    else added++;
  }
  return {added,replaced,preserved};
}
