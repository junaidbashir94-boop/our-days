import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../public');
const demo=String.raw`
const names=['Alex','Sam','Taylor','Morgan'];
const members=names.map((name,i)=>({id:'demo-'+i,name,group_id:'demo-group',role:'member',is_owner:false,calendar_initials:name.slice(0,2).toUpperCase(),schedule_visibility:'shifts'}));
const today=new Date(),day=today.toISOString().slice(0,10),circle={id:'demo-circle',name:'The weekend crew',icon:'◎',group_id:'demo-group',description:'Good times, complicated schedules',discoverability:'invite_only'};
const data={members,shared_circle_memberships:members.map((m,i)=>({circle_id:circle.id,member_id:m.id,role:i===0?'admin':'member',member_type:'working'}))};
const chain=new Proxy(function(){},{get(_,key){if(key==='then')return resolve=>resolve({data:[],error:null});return ()=>chain;},apply(){return chain;}});
const supabase={from:()=>chain,rpc:()=>chain,auth:{getSession:async()=>({data:{session:null}})}};
const state={supabase,user:{id:'preview'},me:members[0],group:{id:'demo-group',name:'Our Days Off'},members,daysOff:[],mealOverrides:[],personalCircles:[],circleDefs:[],activeCircle:'all',sharedCircles:[circle],sharedCircleMemberships:data.shared_circle_memberships,joinRequests:[],activeSharedCircleId:circle.id,events:[{id:1,circle_id:circle.id,title:'Dinner & a catch-up',day:addDaysString(day,2),start_min:1080,end_min:1260,time_zone:'Europe/London',category:'dinner',location:'Choose a place together',note:'',created_by_member_id:'demo-0'}],eventRsvps:[{event_id:1,member_id:'demo-1',status:'going'}],eventNotes:[],eventLocationOptions:[],eventLocationVotes:[],calendarCompareIds:members.map(m=>m.id),compareSets:[],calendarLayout:'month',calendarMonthMode:'magicHour',compareCalendarMode:'magicHour',meSection:'profile',personalScheduleProfileId:null,memberActivity:[],myDevices:[],appActivity:[],groupFeed:[],groupPolls:[],circleSearchResults:[],circleInvitePreview:null,shiftDefinitions:[],aiRotaAnalysis:null,expandedPlanId:null,pendingDeepLink:null,lastSyncedAt:today.toISOString(),meetupFilter:'all',meetRangeDays:14,socialPrefs:defaultSocialPrefs(),view:new Date(Date.UTC(today.getFullYear(),today.getMonth(),1)),selectedDate:day,editDate:null,realtimeChannel:null,activityTimer:null,networkWired:true,offlineMode:false,availability:[]};
for(let i=0;i<45;i++)for(const [j,m] of members.entries()){
  const date=addDaysString(day,i),isOff=(i+j)%3!==0;
  state.daysOff.push({member_id:m.id,day:date,entry_type:isOff?'off':'shift',shift_start_min:isOff?null:480,shift_end_min:isOff?null:1020,source:'manual',note:'',raw_value:isOff?'OFF':'0800-1700'});
  state.availability.push({member_id:m.id,day:date,full_day_off:isOff,intervals:isOff?[{start:0,end:1440,status:'free'}]:[{start:0,end:480,status:'free'},{start:480,end:1020,status:'busy'},{start:1020,end:1440,status:'free'}]});
}
localStorage.setItem('odoWelcome:demo-0:v12','1');
renderMain(state);window.previewState=state;
const banner=document.createElement('div');banner.textContent='Design preview · fictional data · changes are not saved';banner.style='text-align:center;font-size:12px;padding:6px;background:#21334c;color:#cde0f6';document.body.prepend(banner);
`;
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/config.js'){res.setHeader('content-type','text/javascript');res.end('window.APP_CONFIG={};');return;}
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  let body=fs.readFileSync(file);
  if(pathname==='/app.js')body=body.toString().replace(/^import \{ createClient \}[^\n]+/m,'').replace('if (!configured) renderConfigNeeded();\nelse start().catch(showFatal);','')+'\n'+demo;
  if(pathname==='/'||pathname==='/index.html')body=body.toString().replace(/<script src="https:[^]+?<\/script>/,'');
  const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
  res.setHeader('content-type',mime[path.extname(file)]||'text/plain');res.setHeader('cache-control','no-store');res.end(body);
});
server.listen(4173,'127.0.0.1',()=>console.log('Local design preview: http://127.0.0.1:4173'));
