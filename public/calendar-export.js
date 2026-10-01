export function localDateTimeToUtc(day,minute,timeZone) {
  const [year,month,date]=day.split('-').map(Number);
  const wall=new Date(Date.UTC(year,month-1,date,0,minute));
  const target=wall.getTime();let guess=target;
  const format=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<4;i++){
    const p=Object.fromEntries(format.formatToParts(new Date(guess)).map(x=>[x.type,x.value]));
    const seen=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
    if(seen===target)return new Date(guess).toISOString().replace(/[-:]/g,'').replace('.000','');
    guess+=target-seen;
  }
  throw new Error('This time does not exist because the clocks change. Choose another time.');
}
export function planCalendarRange(event){
  const end=Number.isInteger(event.end_min)?event.end_min:event.start_min+120;
  const zone=event.time_zone||'Europe/London';
  return {start:localDateTimeToUtc(event.day,event.start_min,zone),end:localDateTimeToUtc(event.day,end,zone)};
}
