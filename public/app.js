import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

import {availabilityAt, availabilityBoundaries, confirmedFullDayOff, normalizePreferences, importChangeSummary} from "./availability.js";

import {planCalendarRange} from "./calendar-export.js";
const $app = document.querySelector("#app");
const APP_VERSION = "14.0.0-preview";
const APP_THEMES = [
  {key:"ocean", label:"Ocean", swatches:["#2563eb","#06b6d4","#14b8a6"]},
  {key:"violet", label:"Violet", swatches:["#7c3aed","#a855f7","#ec4899"]},
  {key:"sunset", label:"Sunset", swatches:["#ea580c","#f59e0b","#e11d48"]},
  {key:"mint", label:"Mint", swatches:["#059669","#14b8a6","#22c55e"]},
  {key:"berry", label:"Berry", swatches:["#be185d","#e11d48","#8b5cf6"]}
];
function normaliseAppTheme(value){
  return APP_THEMES.some(x=>x.key===value)?value:"ocean";
}
function applyAppTheme(value, persist=true){
  const theme=normaliseAppTheme(value);
  document.documentElement.dataset.appTheme=theme;
  if(persist) localStorage.setItem("odoAppTheme",theme);
  const themeMeta=document.querySelector('meta[name="theme-color"]');
  const primary=APP_THEMES.find(x=>x.key===theme)?.swatches?.[0]||"#2563eb";
  if(themeMeta) themeMeta.setAttribute("content",primary);
  return theme;
}
applyAppTheme(localStorage.getItem("odoAppTheme")||"ocean",false);
const PERSONAL_CIRCLES=[
  {key:"all",label:"All",icon:"◎"},
  {key:"shift",label:"Shift work",icon:"🩺"},
  {key:"friends",label:"Friends",icon:"👥"},
  {key:"family",label:"Family",icon:"🏠"},
  {key:"team",label:"Team / club",icon:"⚽"},
  {key:"community",label:"Community",icon:"🤝"}
];
let deferredInstallPrompt = null;
let updateRegistration = null;
let updateReloading = false;

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
});

const cfg = window.APP_CONFIG || {};
const configured =
  typeof cfg.SUPABASE_URL === "string" &&
  cfg.SUPABASE_URL.startsWith("https://") &&
  typeof cfg.SUPABASE_PUBLISHABLE_KEY === "string" &&
  !cfg.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");

if (!configured) renderConfigNeeded();
else start().catch(showFatal);

function renderConfigNeeded() {
  $app.innerHTML = `
    <section class="setup stack">
      <div class="row" style="gap:12px">
        <img class="app-brand-icon" src="./icon-192.png" alt="">
        <div><p class="eyebrow">One-time setup</p><h1 style="margin:0">Our Days Off</h1></div>
      </div>
      <div class="card stack">
        <h2 class="section-title">Connect the shared database</h2>
        <div class="notice">Open <strong>config.js</strong> and add the Supabase project URL and publishable key.</div>
      </div>
    </section>`;
}


function readDeepLinkFromUrl(){
  const url=new URL(window.location.href);
  const type=(url.searchParams.get("open")||"").toLowerCase();
  const id=url.searchParams.get("id");
  return type&&id?{type,id}:null;
}
function buildDeepLink(type,id){
  const url=new URL(window.location.href);url.search="";url.hash="";
  url.searchParams.set("open",type);url.searchParams.set("id",String(id));
  return url.toString();
}
function clearDeepLinkFromUrl(){
  const url=new URL(window.location.href);url.searchParams.delete("open");url.searchParams.delete("id");history.replaceState({},"",url.toString());
}
async function applyPendingDeepLink(state){
  const link=state.pendingDeepLink||readDeepLinkFromUrl();if(!link)return;
  if(link.type==="plan"){
    const event=state.events.find(x=>String(x.id)===String(link.id));
    if(!event){state.setStatus?.("This plan is unavailable or you do not have access to its circle.",true);return;}
    if(event.circle_id&&event.circle_id!==state.activeSharedCircleId) await setActiveSharedCircle(state,event.circle_id);
    state.activeTab="events";state.expandedPlanId=Number(event.id);updateMainTabUI(state);renderUpcomingEvents(state);
    setTimeout(()=>document.querySelector(`[data-event-card="${event.id}"]`)?.scrollIntoView({behavior:"smooth",block:"start"}),120);
    state.pendingDeepLink=null;clearDeepLinkFromUrl();
  }
}
function extractDeviceCode(value){
  const raw=String(value||"").trim();if(!raw)return "";
  try{const u=new URL(raw);return normalizeCode(u.searchParams.get("device"));}catch{}
  return normalizeCode(raw);
}

async function start() {
  const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw new Error(`Anonymous sign-in failed: ${error.message}`);
    session = data.session;
  }

  const now = new Date();
  const state = {
    supabase,
    user: session.user,
    me: null,
    group: null,
    members: [],
    daysOff: [],
    mealOverrides: [],
    personalCircles: [],
    circleDefs: [],
    activeCircle: "all",
    sharedCircles: [],
    sharedCircleMemberships: [],
    joinRequests: [],
    activeSharedCircleId: localStorage.getItem("odoActiveSharedCircle") || null,
    events: [],
    eventRsvps: [],
    eventNotes: [],
    eventLocationOptions: [],
    eventLocationVotes: [],
    calendarCompareIds: [],
    compareSets: [],
    calendarLayout: localStorage.getItem("odoCalendarLayout") || "month",
    calendarMonthMode: localStorage.getItem("odoCalendarMonthMode") || "daysOff",
    compareCalendarMode: localStorage.getItem("odoCompareCalendarMode") || "daysOff",
    meSection: "profile",
    personalScheduleProfileId: null,
    memberActivity: [],
    myDevices: [],
    appActivity: [],
    groupFeed: [],
    groupPolls: [],
    circleSearchResults: [],
    circleInvitePreview: null,
    shiftDefinitions: [],
    aiRotaAnalysis: null,
    expandedPlanId: null,
    pendingDeepLink: readDeepLinkFromUrl(),
    lastSyncedAt: null,
    meetupFilter: "all",
    meetRangeDays: Number(localStorage.getItem("odoMeetRangeDays")||14),
    socialPrefs: loadLocalSocialPrefs(),
    view: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)),
    selectedDate: null,
    editDate: null,
    realtimeChannel: null,
    activityTimer: null,
    networkWired: false,
    offlineMode: false
  };

  await maybeAutoLinkDevice(state);
  await resolveMembership(state);
}


function guessDeviceName(){
  const ua=navigator.userAgent||"";
  if(/iPhone/i.test(ua)) return "iPhone";
  if(/iPad/i.test(ua)) return "iPad";
  if(/Android/i.test(ua)) return /Mobile/i.test(ua)?"Android phone":"Android tablet";
  if(/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if(/Windows/i.test(ua)) return "Windows computer";
  if(/Linux/i.test(ua)) return "Linux computer";
  return "Browser device";
}

async function maybeAutoLinkDevice(state){
  const url=new URL(window.location.href);
  const code=normalizeCode(url.searchParams.get("device"));
  if(!code) return;
  const {data:existing}=await state.supabase.rpc("get_my_profile").maybeSingle();
  if(existing){
    url.searchParams.delete("device");
    history.replaceState({},"",url.toString());
    return;
  }
  const {error}=await state.supabase.rpc("link_device_v13_2",{p_code:code,p_device_name:guessDeviceName()});
  if(error){
    sessionStorage.setItem("odoDeviceLinkError",error.message||"That device link is invalid or expired.");
    return;
  }
  url.searchParams.delete("device");
  history.replaceState({},"",url.toString());
  sessionStorage.setItem("odoDeviceLinked","1");
}

async function touchCurrentDevice(state){
  try{await state.supabase.rpc("touch_current_device_v13_2",{p_device_name:guessDeviceName()});}catch{}
}

async function resolveMembership(state) {
  try {
    const { data, error } = await state.supabase
      .rpc("get_my_profile")
      .maybeSingle();

    if (error) throw error;
    if (!data) return renderSetup(state);

    state.me = data;
    await touchCurrentDevice(state);
    await touchMemberActivity(state);
    await loadGroup(state);
    state.offlineMode = false;
    if(!joinedSharedCircles(state).length) renderPendingAccess(state);
    else renderMain(state);
    setupNetworkAwareness(state);
    setupActivityHeartbeat(state);
    await checkSmartNotifications(state);
    await subscribeRealtime(state);
  } catch (error) {
    if (!navigator.onLine && loadOfflineSnapshot(state)) {
      state.offlineMode = true;
      renderMain(state);
      setupNetworkAwareness(state);
      return;
    }
    throw error;
  }
}

async function loadGroup(state) {
  const [groupRes,circlesRes,membershipsRes,membersRes,daysRes,overridesRes,eventsRes,rsvpsRes,pollsPlaceholder,personalCirclesRes,circleDefsRes,eventNotesRes,compareSetsRes,locationOptionsRes,locationVotesRes,scheduleProfileRes,joinRequestsRes,devicesRes,appActivityRes] = await Promise.all([
    state.supabase.from("groups").select("id, name, invite_code, community_type").eq("id", state.me.group_id).single(),
    state.supabase.rpc("get_shared_circles_v13"),
    state.supabase.rpc("get_shared_circle_memberships_v13"),
    state.supabase.from("members").select("id, name, is_owner, user_id, role, created_at, schedule_visibility, public_handle, calendar_initials").eq("group_id", state.me.group_id).order("created_at"),
    state.supabase.rpc("get_group_schedule_visible_v14",scheduleQueryRange(state)),
    state.supabase.from("meal_availability_overrides").select("id, member_id, day, meal, status, note").eq("group_id", state.me.group_id),
    state.supabase.from("group_events").select("id, circle_id, title, day, start_min, end_min, time_zone, location, note, category, created_by_member_id, created_at, updated_at").eq("group_id", state.me.group_id).order("day").order("start_min"),
    state.supabase.from("event_rsvps").select("id, event_id, member_id, status, updated_at").eq("group_id", state.me.group_id),
    Promise.resolve({data:[],error:null}),
    state.supabase.from("personal_member_circles").select("target_member_id,circle_key").eq("group_id",state.me.group_id),
    state.supabase.from("personal_circle_defs").select("circle_key,label,icon,created_at").eq("group_id",state.me.group_id).order("created_at"),
    state.supabase.from("event_plan_notes").select("id,event_id,member_id,body,created_at").eq("group_id",state.me.group_id).order("created_at"),
    Promise.resolve({data:[],error:null}),
    state.supabase.from("event_location_options").select("id,event_id,label,created_by_member_id,created_at").eq("group_id",state.me.group_id).order("created_at"),
    state.supabase.from("event_location_votes").select("id,event_id,option_id,member_id,created_at").eq("group_id",state.me.group_id),
    state.supabase.rpc("ensure_personal_schedule_profile"),
    state.supabase.rpc("get_join_requests_v13"),
    state.supabase.rpc("get_my_devices_v13_2"),
    state.me?.is_owner ? state.supabase.rpc("get_app_activity_owner_v13_3",{p_limit:80}) : Promise.resolve({data:[],error:null})
  ]);

  for(const result of [groupRes,circlesRes,membershipsRes,membersRes,daysRes,overridesRes,eventsRes,rsvpsRes,personalCirclesRes,circleDefsRes,eventNotesRes,compareSetsRes,locationOptionsRes,locationVotesRes,scheduleProfileRes]){
    if(result?.error) throw result.error;
  }

  state.group=groupRes.data;
  state.sharedCircles=circlesRes.data||[];
  state.sharedCircleMemberships=membershipsRes.data||[];
  state.joinRequests=joinRequestsRes?.error?[]:(joinRequestsRes.data||[]);
  state.myDevices=devicesRes?.error?[]:(devicesRes.data||[]);
  state.appActivity=appActivityRes?.error?[]:(appActivityRes.data||[]);
  state.members=membersRes.data||[];
  const meMemberRow=state.members.find(x=>x.id===state.me.id);if(meMemberRow){state.me.name=meMemberRow.name;state.me.calendar_initials=meMemberRow.calendar_initials||null;}
  state.daysOff=(daysRes.data||[]).map(x=>({
    ...x,availability_type:x.availability_type||"off",note:x.note||"",source:x.source||"manual",import_file_name:x.import_file_name||"",
    entry_type:x.entry_type||(x.availability_type==="off"?"off":"partial"),shift_start_min:Number.isInteger(x.shift_start_min)?x.shift_start_min:null,
    shift_end_min:Number.isInteger(x.shift_end_min)?x.shift_end_min:null,raw_value:x.raw_value||""
  }));
  state.mealOverrides=overridesRes.data||[];
  state.events=eventsRes.data||[];
  state.eventRsvps=rsvpsRes.data||[];
  state.personalCircles=personalCirclesRes.data||[];
  state.circleDefs=circleDefsRes.data||[];
  state.eventNotes=eventNotesRes.data||[];
  state.compareSets=compareSetsRes.data||[];
  state.eventLocationOptions=locationOptionsRes.data||[];
  state.eventLocationVotes=locationVotesRes.data||[];
  state.personalScheduleProfileId=scheduleProfileRes.data||null;
  const shiftDefsRes=await state.supabase.rpc("get_my_shift_definitions_v13_3");
  state.shiftDefinitions=shiftDefsRes.error?[]:(shiftDefsRes.data||[]);

  const stored=localStorage.getItem(sharedCircleSelectionKey(state));
  const joinedIds=new Set(joinedSharedCircles(state).map(x=>x.id));
  state.activeSharedCircleId=joinedIds.has(stored)?stored:(joinedSharedCircles(state)[0]?.id||null);
  if(state.activeSharedCircleId) localStorage.setItem(sharedCircleSelectionKey(state),state.activeSharedCircleId);

  // v13.1: shared circles are the only people-organising model in the UI.
  state.activeCircle="all";
  state.calendarCompareIds=loadCalendarCompareSelection(state);

  await refreshCircleSocial(state);
  await refreshAvailability(state);

  state.lastSyncedAt=new Date().toISOString();
  state.memberActivity=[];
  if(state.me?.is_owner){
    const {data:activity,error:activityError}=await state.supabase.rpc("get_group_activity_owner");
    if(!activityError) state.memberActivity=activity||[];
  }
  saveOfflineSnapshot(state);
}

function renderSetup(state){
  const params=new URLSearchParams(window.location.search);
  const circleCode=normalizeCode(params.get("circle"));
  const referrer=(params.get("ref")||"").trim().slice(0,80);
  const linkError=sessionStorage.getItem("odoDeviceLinkError");sessionStorage.removeItem("odoDeviceLinkError");
  $app.innerHTML=`
    <main class="simple-onboarding-shell">
      <section class="simple-onboarding-card">
        <div class="onboarding-logo-wrap"><img class="simple-onboarding-logo" src="./icon-192.png" alt=""></div>
        <p class="eyebrow">Our Days Off</p><h1>What’s your name?</h1>
        <p class="onboarding-one-line">Start planning when everyone is free.</p>
        ${circleCode?`<div class="onboarding-invite-hint">You have a circle invitation waiting. Start or continue your account first.</div>`:""}
        ${linkError?`<div class="notice">${escapeHtml(linkError)}</div>`:""}
        <form id="simpleSignupForm" class="simple-name-form">
          <label class="sr-only" for="simpleSignupName">Your name</label>
          <input class="input simple-name-input" id="simpleSignupName" maxlength="40" autocomplete="name" placeholder="Your name" required autofocus>
          <button class="btn btn-primary simple-start-btn" id="simpleSignupBtn" type="submit">Start using Our Days Off</button>
        </form>
        <button class="onboarding-secondary-link" id="continueAccountBtn" type="button">Already use Our Days Off? <strong>Continue my account</strong></button>
        <form id="continueAccountForm" class="continue-account-form" hidden>
          <label class="field"><span>Device link or saved recovery key</span><input class="input" id="continueAccountCode" autocomplete="off" placeholder="Paste code from My Devices"></label>
          <p class="subtle">Use Me → Help & devices → Add another device on a signed-in device, or paste a recovery key you saved earlier.</p>
          <button class="btn" id="continueAccountSubmit" type="submit">Continue my account</button>
        </form>
        <div id="simpleSignupMsg" class="toast" aria-live="polite"></div>
      </section>
    </main>`;
  $("#continueAccountBtn").addEventListener("click",()=>{$("#continueAccountForm").hidden=!$("#continueAccountForm").hidden;});
  $("#continueAccountForm").addEventListener("submit",async e=>{
    e.preventDefault();const rawCode=$("#continueAccountCode").value.trim();const recovery=/^[a-f0-9]{64}$/i.test(rawCode);const code=recovery?rawCode.toLowerCase():extractDeviceCode(rawCode);if(!code)return setMsg($("#simpleSignupMsg"),"Enter the one-time device code or link.",true);
    const btn=$("#continueAccountSubmit");btn.disabled=true;setMsg($("#simpleSignupMsg"),"Linking this device…");
    const {error}=await state.supabase.rpc(recovery?"recover_account_v14":"link_device_v13_2",{[recovery?"p_key":"p_code"]:code,p_device_name:guessDeviceName()});btn.disabled=false;
    if(error)return setMsg($("#simpleSignupMsg"),error.message,true);
    setMsg($("#simpleSignupMsg"),"Account linked ✓");await resolveMembership(state);
  });
  $("#simpleSignupForm").addEventListener("submit",async e=>{
    e.preventDefault();const name=$("#simpleSignupName").value.trim();if(!name)return setMsg($("#simpleSignupMsg"),"Enter your name.",true);
    const btn=$("#simpleSignupBtn");btn.disabled=true;setMsg($("#simpleSignupMsg"),"Setting up your account…");
    const signup=await state.supabase.rpc("simple_signup_v13_2",{p_display_name:name,p_referrer_handle:referrer||null,p_device_name:guessDeviceName()});
    btn.disabled=false;if(signup.error)return setMsg($("#simpleSignupMsg"),signup.error.message,true);
    const url=new URL(window.location.href);url.searchParams.delete("ref");history.replaceState({},"",url.toString());
    await resolveMembership(state);
  });
}

function sharedCircleSelectionKey(state){return `odoSharedCircle:${state.me?.group_id||"group"}:${state.me?.id||"member"}`;}
function circleMembership(state,circleId,memberId=state.me.id){return state.sharedCircleMemberships.find(x=>x.circle_id===circleId&&x.member_id===memberId)||null;}
function mySharedCircleRole(state,circleId){return circleMembership(state,circleId)?.role||null;}
function mySharedCircleMemberType(state,circleId){return circleMembership(state,circleId)?.member_type||"working";}
function isCircleJoined(state,circleId){return !!mySharedCircleRole(state,circleId);}
function canManageCircle(state,circleId){return mySharedCircleRole(state,circleId)==="admin";}
function canManageAnyCircle(state){return (state.sharedCircles||[]).some(c=>canManageCircle(state,c.id));}
function discoverableSharedCircles(state){return (state.sharedCircles||[]).filter(c=>!c.archived_at||isCircleJoined(state,c.id));}
function joinedSharedCircles(state){return discoverableSharedCircles(state).filter(c=>isCircleJoined(state,c.id));}
function accessibleSharedCircles(state){return joinedSharedCircles(state);}
function activeSharedCircle(state){return joinedSharedCircles(state).find(x=>x.id===state.activeSharedCircleId)||null;}
function sharedCircleMemberIds(state,circleId=state.activeSharedCircleId){return new Set((state.sharedCircleMemberships||[]).filter(x=>x.circle_id===circleId).map(x=>x.member_id));}
function sharedCircleMembers(state,circleId=state.activeSharedCircleId){if(!isCircleJoined(state,circleId))return[];const ids=sharedCircleMemberIds(state,circleId);return state.members.filter(x=>ids.has(x.id));}
function circleNameById(state,id){return state.sharedCircles.find(x=>x.id===id)?.name||"Circle";}
function myPendingCircleRequest(state,circleId){return (state.joinRequests||[]).find(r=>r.member_id===state.me.id&&r.circle_id===circleId)||null;}
function setCircleNotice(state,text,error=false){if(state.setStatus)state.setStatus(text,error);else{const el=$("#pendingCircleMsg");if(el){el.textContent=text;el.style.color=error?"var(--danger)":"";}}}
async function searchCircles(state,query,target){
  const q=String(query||"").trim();if(q.length<2){state.circleSearchResults=[];if(target)target.innerHTML=`<div class="subtle">Type at least 2 characters.</div>`;return;}
  const {data,error}=await state.supabase.rpc("search_shared_circles_v13_3",{p_query:q});
  if(error){if(target)target.innerHTML=`<div class="notice">${escapeHtml(error.message)}</div>`;return;}
  state.circleSearchResults=data||[];renderCircleSearchResults(state,target);
}
function renderCircleSearchResults(state,target){
  if(!target)return;const rows=state.circleSearchResults||[];
  target.innerHTML=rows.length?rows.map(c=>{const pending=myPendingCircleRequest(state,c.circle_id);return `<article class="circle-search-result"><div class="discoverable-circle-icon">${escapeHtml(c.icon||"◎")}</div><div class="circle-search-copy"><strong>${escapeHtml(c.name)}</strong><small>${c.description?escapeHtml(c.description):"🔒 Private circle"}</small></div><div class="join-role-actions"><select class="select select-small" data-join-type="${c.circle_id}" ${pending?"disabled":""}><option value="working">Working member</option><option value="viewer">Viewer</option></select><button class="btn btn-small" data-request-circle-join="${c.circle_id}" ${pending?"disabled":""}>${pending?"Pending":"Request to join"}</button></div></article>`;}).join(""):`<div class="soft-empty">No matching searchable circles. Try another spelling, or ask for an invite link.</div>`;
  wireCircleJoinActions(state,target);
}
async function requestJoinCircle(state,circleId,root=document){
  if(isCircleJoined(state,circleId))return setActiveSharedCircle(state,circleId);
  if(myPendingCircleRequest(state,circleId))return setCircleNotice(state,"Your request is already waiting for a circle admin.");
  const type=root.querySelector?.(`[data-join-type="${circleId}"]`)?.value||"working";
  const {error}=await state.supabase.rpc("request_circle_join_by_id_v13_3",{p_circle_id:circleId,p_member_type:type});
  if(error)return setCircleNotice(state,error.message,true);
  const {data}=await state.supabase.rpc("get_join_requests_v13");state.joinRequests=data||[];setCircleNotice(state,`Request sent as ${type==="viewer"?"Viewer":"Working member"} ✓`);
  root.querySelector?.(`[data-request-circle-join="${circleId}"]`)?.setAttribute("disabled","");
}
function wireCircleJoinActions(state,root=document){root.querySelectorAll?.("[data-request-circle-join]").forEach(btn=>btn.addEventListener("click",()=>requestJoinCircle(state,btn.dataset.requestCircleJoin,root)));}
async function loadInvitePreview(state){
  const code=normalizeCode(new URL(window.location.href).searchParams.get("circle"));if(!code){state.circleInvitePreview=null;return;}
  const {data,error}=await state.supabase.rpc("get_circle_invite_preview_v13_3",{p_circle_code:code});state.circleInvitePreview=error?null:(data?.[0]||null);
}
async function requestInviteCircle(state,type){
  const code=normalizeCode(new URL(window.location.href).searchParams.get("circle"));if(!code)return;
  const {error}=await state.supabase.rpc("request_circle_join_v13_3",{p_circle_code:code,p_member_type:type});if(error)return setCircleNotice(state,error.message,true);
  const {data}=await state.supabase.rpc("get_join_requests_v13");state.joinRequests=data||[];setCircleNotice(state,"Join request sent ✓");
}

async function refreshCircleSocial(state){
  if(!state.activeSharedCircleId){state.groupFeed=[];state.groupPolls=[];return;}
  const [feedRes,pollsRes]=await Promise.all([
    state.supabase.rpc("get_group_feed_v13",{p_circle_id:state.activeSharedCircleId,p_limit:20}),
    state.supabase.rpc("get_circle_polls_v13",{p_circle_id:state.activeSharedCircleId})
  ]);
  if(feedRes.error) throw feedRes.error;
  if(pollsRes.error) throw pollsRes.error;
  state.groupFeed=feedRes.data||[];
  state.groupPolls=normalizePollRows(pollsRes.data||[]);
}

function renderPendingAccess(state){
  $app.innerHTML=`<main class="pending-access-screen pending-v133 stack">
    <section class="pending-hero-card"><div class="pending-brand"><img class="app-brand-icon" src="./icon-192.png" alt=""><div><p class="eyebrow">Welcome, ${escapeHtml(state.me.name)}</p><h1>Find your people</h1></div></div><p>Your account is private. Search for a circle you know, use an invite link, or create your own.</p><div class="row-wrap"><button class="btn btn-primary" id="pendingInstallBtn" type="button">Install app</button><span class="subtle">Optional — web works too.</span></div></section>
    <section class="card stack" id="pendingInviteCard" hidden></section>
    <section class="card stack"><div><p class="eyebrow">Find a circle</p><h2 class="section-title">Search by name</h2><p class="subtle">There is no public circle directory. Search is fuzzy, so spelling does not need to be exact.</p></div><form id="pendingCircleSearchForm" class="circle-search-form"><input class="input" id="pendingCircleSearch" placeholder="e.g. ED team / cricket / family" autocomplete="off"><button class="btn" type="submit">Search</button></form><div id="pendingCircleSearchResults" class="circle-search-results"></div><div id="pendingCircleMsg" class="toast"></div></section>
    <section class="card stack create-first-circle-card"><div><p class="eyebrow">Or start your own</p><h2 class="section-title">Create a circle</h2></div><form id="pendingCreateCircleForm" class="new-circle-form"><label class="field"><span>Circle name</span><input class="input" id="pendingCircleName" maxlength="40" required></label><label class="field small-icon-field"><span>Icon</span><input class="input" id="pendingCircleIcon" maxlength="8" value="◎"></label><label class="field"><span>Description</span><input class="input" id="pendingCircleDescription" maxlength="120"></label><label class="field"><span>Who can find it?</span><select class="select" id="pendingCircleDiscoverability"><option value="searchable">Searchable by name</option><option value="invite_only">Invite only</option></select></label><button class="btn btn-primary" type="submit">Create my circle</button></form><div id="pendingCreateCircleMsg" class="toast"></div></section>
    <p class="footer">Search results never reveal members, member counts, plans, schedules or admins.</p>
  </main>`;
  $("#pendingInstallBtn")?.addEventListener("click",()=>installApp({setStatus:(t,e)=>setMsg($("#pendingCircleMsg"),t,e)}));
  $("#pendingCircleSearchForm")?.addEventListener("submit",e=>{e.preventDefault();searchCircles(state,$("#pendingCircleSearch").value,$("#pendingCircleSearchResults"));});
  $("#pendingCreateCircleForm")?.addEventListener("submit",async e=>{e.preventDefault();const name=$("#pendingCircleName").value.trim();if(!name)return;const btn=e.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;const {error}=await state.supabase.rpc("create_shared_circle_v13_3",{p_name:name,p_icon:$("#pendingCircleIcon").value.trim()||"◎",p_description:$("#pendingCircleDescription").value.trim()||null,p_discoverability:$("#pendingCircleDiscoverability").value});btn.disabled=false;if(error)return setMsg($("#pendingCreateCircleMsg"),error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"circles");});
  loadInvitePreview(state).then(()=>{const c=state.circleInvitePreview,card=$("#pendingInviteCard");if(!c||!card)return;card.hidden=false;card.innerHTML=`<div><p class="eyebrow">Private invitation</p><h2 class="section-title">${escapeHtml(c.icon||"◎")} ${escapeHtml(c.name)}</h2><p class="subtle">${escapeHtml(c.description||"You were invited to this circle.")}</p></div><label class="field"><span>Join as</span><select class="select" id="pendingInviteMemberType"><option value="working">Working member</option><option value="viewer">Viewer</option></select></label><button class="btn btn-primary" id="pendingInviteJoin" type="button">Request to join</button>`;$("#pendingInviteJoin").onclick=()=>requestInviteCircle(state,$("#pendingInviteMemberType").value);});
}

function renderMain(state) {
  const workers = workingMembers(state);
  const viewers = viewerMembers(state);
  const isViewer = mySharedCircleMemberType(state,state.activeSharedCircleId)==="viewer";
  const canAdmin=state.me.is_owner||canManageAnyCircle(state);
  const currentCircle=activeSharedCircle(state);
  if (!state.calendarView) state.calendarView = "group";
  if (!state.activeTab) state.activeTab = "home";

  $app.innerHTML = `
    <header class="topbar">
      <button class="topbar-brand topbar-brand-button" id="homeBrandButton" type="button" aria-label="Open my profile and settings">
        <img class="app-brand-icon small" src="./icon-192.png" alt="">
        <div>
          <p class="eyebrow">${currentCircle?"Shared circle":"Your network"}</p>
          <h1>${escapeHtml(currentCircle?.name||state.group.name)}</h1><p class="topbar-tagline">Find your overlap. Make a plan.</p>
        </div>
      </button>
      <button class="me-chip me-chip-button" id="accountChip" type="button" aria-label="Open account menu">${memberAvatarHtml(state.me,"xs")}<span>You: <strong>${escapeHtml(state.me.name)}</strong>${state.me.is_owner?" · Owner":mySharedCircleRole(state,state.activeSharedCircleId)==="admin"?" · Circle admin":isViewer?" · Viewer":""}</span></button>
    </header>

    <div class="stack">
      ${isViewer ? `<section class="notice viewer-notice"><strong>Viewer mode</strong> — rotas stay read-only, but you can create plans and RSVP.</section>` : ""}

      <nav class="main-tabs" id="mainTabs" aria-label="Main sections">
        <button class="main-tab" type="button" data-tab="home">Home</button>
        <button class="main-tab" type="button" data-tab="meetups">Meet</button>
        <button class="main-tab" type="button" data-tab="calendar">Calendar</button>
        <button class="main-tab" type="button" data-tab="events">Plans</button>
        <button class="main-tab" type="button" data-tab="more">Me</button>
      </nav>

      <nav class="mobile-bottom-nav" id="mobileBottomNav" aria-label="Mobile navigation">
        <button class="mobile-nav-btn" type="button" data-tab="home"><span class="mobile-nav-icon">⌂</span><span>Home</span></button>
        <button class="mobile-nav-btn" type="button" data-tab="meetups"><span class="mobile-nav-icon">◎</span><span>Meet</span></button>
        <button class="mobile-nav-btn" type="button" data-tab="calendar"><span class="mobile-nav-icon">▦</span><span>Calendar</span></button>
        <button class="mobile-nav-btn" type="button" data-tab="events"><span class="mobile-nav-icon">✦</span><span>Plans</span></button>
        <button class="mobile-nav-btn" type="button" data-tab="more"><span class="mobile-nav-icon">◉</span><span>Me</span></button>
      </nav>

      <div class="tab-panel stack" data-tab-panel="home">
        <section class="home-welcome">
          <div>
            <p class="eyebrow" id="homeGreeting"></p>
            <h2 class="home-title">When can we be together?</h2>
            <p class="subtle">Choose the shared circle you want to plan with.</p>
          </div>
        </section>

        <section class="card stack personal-circles-home">
          <div class="row-wrap between">
            <div>
              <p class="eyebrow">Shared circles</p>
              <h2 class="section-title">Who are you planning with?</h2>
              <p class="subtle">Only circles you have joined appear here. Search for another circle under Me → Circles.</p>
            </div>
            <button class="btn btn-small" id="manageCirclesBtn" type="button">Manage</button>
          </div>
          <div class="circle-switcher" data-circle-switcher></div>
        </section>

        <section class="best-opportunity-card" id="bestOpportunityHero"></section>

        <section class="card stack compact-home-card">
          <div class="row-wrap between">
            <div><p class="eyebrow">Today</p><h2 class="section-title" id="todayHeading"></h2></div>
            ${!isViewer ? `<button class="btn btn-small" id="quickAvailability" type="button">Update mine</button>` : ""}
          </div>
          <div class="today-view-switch" role="group" aria-label="Today's schedule view">
            <button class="btn btn-small" type="button" data-today-view="working">Working time</button>
            <button class="btn btn-small" type="button" data-today-view="off">Off time</button>
          </div>
          <div id="todayStrip" class="today-strip" aria-live="polite"></div>
        </section>

        <div class="home-two-column">
          <section class="card stack" id="nextPlanCard"></section>
          <section class="card stack" id="myScheduleCard"></section>
        </div>

        <section class="card stack recent-activity-card" id="recentActivityCard">
          <div class="row-wrap between">
            <div><p class="eyebrow">Recent</p><h2 class="section-title">What changed</h2></div>
            <button class="btn btn-small" id="refreshFeedBtn" type="button">Refresh</button>
          </div>
          <div id="recentActivity" class="activity-feed"></div>
        </section>

        <section class="home-action-bar">
          ${!isViewer ? `<button class="btn btn-primary" id="quickFreeToday" type="button">✓ I’m free today</button>` : ""}
          ${!isViewer ? `<button class="btn" id="quickUnavailableToday" type="button">× Unavailable today</button>` : ""}
          <button class="btn" id="quickAddEvent" type="button">+ Make a plan</button>
        </section>

        ${state.me.is_owner ? `<section class="owner-attention" id="ownerAttention" hidden></section>` : ""}
      </div>

      <section class="card stack tab-panel" data-tab-panel="meetups" id="meetupSection">
        <div>
          <p class="eyebrow">Meet</p>
          <h2 class="section-title">When can we actually meet?</h2>
          <p class="subtle">Real shared free-time windows. Breakfast is 08:00–16:00; Dinner starts at 16:00.</p>
          <div class="circle-switcher compact" data-circle-switcher></div>
          <div class="meet-range-tabs" id="meetRangeTabs">
            <button type="button" data-meet-range="7">7 days</button>
            <button type="button" data-meet-range="14">14 days</button>
            <button type="button" data-meet-range="30">30 days</button>
          </div>
        </div>

        <section class="card stack weekly-preview-card meet-best-windows-card" id="weeklyPreviewCard"></section>

        <div id="meetupSuggestions" class="meetup-sections"></div>
        <section class="meet-polls-wrap">
          <div class="row-wrap between">
            <div><p class="eyebrow">Ask the group</p><h3 class="subsection-title">Date / time questions</h3></div>
            <span class="subtle">Only shown when someone asks from Meet.</span>
          </div>
          <div id="groupPolls" class="poll-list"></div>
        </section>
      </section>

      <section class="card stack tab-panel" data-tab-panel="events" id="eventsSection">
        <div class="row-wrap between">
          <div>
            <p class="eyebrow">Plans</p>
            <h2 class="section-title">What are we doing?</h2>
            <p class="subtle">Plans belong to the selected shared circle. People outside it cannot see or RSVP.</p>
          </div>
          <div class="row-wrap"><button class="btn btn-primary btn-small" id="addEventBtn" type="button">+ Make a plan</button></div>
        </div>
        <div id="upcomingEvents" class="events-list"></div>
      </section>

      ${!isViewer ? `<div class="tab-panel stack" data-tab-panel="more"><section class="card stack" id="rotaImportSection" data-me-section-panel="schedule">
        <div>
          <p class="eyebrow">Automatic update</p>
          <h2 class="section-title">${state.me.is_owner ? "Import the whole department rota PDF" : "Import my rota PDF"}</h2>
          <p class="subtle">${state.me.is_owner
            ? "You can map PDF columns to any working member and update several people at once."
            : "You can import only your own column."} The PDF itself stays on this device.</p>
        </div>
        <label class="field">
          <span>Rota PDF</span>
          <input class="input file-input" id="rotaPdfFile" type="file" accept="application/pdf,.pdf">
        </label>
        <label class="field">
          <span>Codes that mean a full day off</span>
          <input class="input" id="rotaOffCodes" value="OFF, REST, REST DAY, A/L, AL, ANNUAL LEAVE, LEAVE, ZERO, ZERO DAY">
        </label>
        <div class="row-wrap">
          <button class="btn btn-primary" id="analyseRotaPdf" type="button">Read whole rota</button>
          <span id="rotaImportStatus" class="toast" aria-live="polite"></span>
        </div>
        <div id="rotaMappingPreview" class="rota-preview" hidden>
          <div><strong id="rotaPreviewTitle"></strong><div class="subtle" id="rotaPreviewText"></div></div>
          <div id="rotaMappings" class="mapping-list"></div>
          <div class="notice">Shift times and overnight shifts are imported. ALS/Induction/Taster-type entries are treated as busy. Manual edits always override PDF imports.</div>
          <div class="row-wrap between">
            <span id="rotaMappingSummary" class="subtle"></span>
            <button class="btn btn-primary" id="applyRotaImport" type="button">Update mapped rotas</button>
          </div>
        </div>


        <div class="dashboard-divider"></div>
        <div class="spreadsheet-import-box">
          <div>
            <p class="eyebrow">Spreadsheet</p>
            <h3>Import Excel / CSV rota</h3>
            <p class="subtle">Supports .xlsx, .xls and .csv. The app detects the date column and staff columns, then lets you map names before saving.</p>
          </div>
          <label class="field">
            <span>Rota spreadsheet</span>
            <input class="input file-input" id="rotaSheetFile" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv">
          </label>
          <div class="row-wrap">
            <button class="btn" id="analyseRotaSheet" type="button">Read spreadsheet</button>
            <span id="rotaSheetStatus" class="toast"></span>
          </div>
          <div id="rotaSheetPreview" class="rota-preview" hidden>
            <div><strong id="rotaSheetPreviewTitle"></strong><div class="subtle" id="rotaSheetPreviewText"></div></div>
            <div id="rotaSheetMappings" class="mapping-list"></div>
            <div class="notice">Blank cells stay unknown. Nothing is assumed to be OFF. Check the name mappings before applying.</div>
            <div class="row-wrap between">
              <span id="rotaSheetSummary" class="subtle"></span>
              <button class="btn btn-primary" id="applyRotaSheet" type="button">Import mapped columns</button>
            </div>
          </div>
        </div>

        <div class="dashboard-divider"></div>
        <div class="ai-rota-import-box">
          <div><p class="eyebrow">AI rota import</p><h3>Turn screenshots into a confirmed rota</h3><p class="subtle">Upload up to 5 screenshots. AI reads dates, names and shift codes, then asks what codes such as AM, LD, Late or Night actually mean before anything is saved.</p></div>
          <label class="field"><span>Rota screenshots/photos</span><input class="input file-input" id="aiRotaImages" type="file" accept="image/jpeg,image/png,image/webp" multiple></label>
          <div class="row-wrap"><button class="btn btn-primary" id="readRotaWithAi" type="button">✨ Read rota with AI</button><span id="aiRotaStatus" class="toast"></span></div>
          <div id="aiRotaReview" class="stack ai-rota-review" hidden><div id="aiRotaWarnings"></div><div><strong>1 · Map people</strong><div id="aiPersonMappings" class="mapping-list"></div></div><div><strong>2 · Define shift codes</strong><p class="subtle">Times are never guessed. Saved shift types are reused when available.</p><div id="aiShiftDefinitions" class="ai-shift-definitions"></div></div><div><strong>3 · Review dates</strong><div id="aiRotaEntries" class="ai-rota-entry-list"></div></div><div class="row-wrap between"><button class="btn" id="downloadAiRotaPdf" type="button">Generate clean PDF</button><button class="btn btn-primary" id="applyAiRota" type="button">Import confirmed rota</button></div></div>
        </div>
        <div id="shiftDictionaryCard" class="shift-dictionary-inline"><div class="row-wrap between"><div><strong>My shift types</strong><span class="subtle">Remember AM / LD / Late / Night timings for future imports.</span></div></div><div id="shiftDictionaryList"></div></div>
        <details class="local-ocr-fallback"><summary>Local OCR fallback</summary><div class="photo-import-box">
          <div>
            <p class="eyebrow">Refined beta</p>
            <h3>Import rota screenshot / photo</h3>
            <p class="subtle">The image is cleaned up before OCR. Auto mode can recognise a single-person rota or a department-style grid with names across the top.</p>
          </div>
          <label class="field"><span>Rota image</span><input class="input file-input" id="rotaImageFile" type="file" accept="image/*"></label>
          <label class="field">
            <span>Recognition mode</span>
            <select class="select" id="rotaImageMode">
              <option value="auto">Auto detect</option>
              <option value="grid">Department grid</option>
              <option value="single">One person</option>
            </select>
          </label>
          <label class="field" id="rotaImageMemberField"><span>Person (for one-person mode)</span><select class="select" id="rotaImageMember">${(state.me.is_owner?workingMembers(state):workingMembers(state).filter(x=>x.id===state.me.id)).map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}</select></label>
          <button class="btn" id="readRotaImage" type="button">Read screenshot</button>
          <span id="rotaImageStatus" class="toast"></span>
          <div id="rotaImageReview" class="stack" hidden>
            <div class="ocr-quality-row">
              <span id="rotaImageModeResult"></span>
              <span id="rotaImageConfidence"></span>
            </div>
            <label class="field">
              <span>Review / correct extracted text</span>
              <textarea class="input note-input mono-textarea" id="rotaImageText" rows="12" placeholder="Single: 07/09/2026 1400-2300&#10;&#10;Grid: DATE | Rashid | Faizan | Junaid&#10;07/09/2026 | OFF | 0800-1700 | 1400-2300"></textarea>
            </label>
            <div class="notice">For a department grid, use <strong>|</strong> between columns if OCR alignment is unclear. Rows with uncertain column counts are flagged and are never imported automatically.</div>
            <div id="rotaImageMappings" class="mapping-list"></div>
            <div class="row-wrap">
              <button class="btn" id="reparseRotaImage" type="button">Re-check text</button>
              <button class="btn btn-primary" id="applyRotaImage" type="button">Import confirmed rows</button>
            </div>
            <div id="rotaImagePreviewText" class="subtle"></div>
          </div>
        </div></details>
      </section></div>` : ""}

      <div class="tab-panel stack" data-tab-panel="calendar"><section class="card" id="calendarSection">
        <div class="calendar-layout-tabs" id="calendarLayoutTabs" aria-label="Calendar display">
          <button type="button" data-calendar-layout="month">Month</button>
          <button type="button" data-calendar-layout="grid">Rota grid</button>
          <button type="button" data-calendar-layout="compare">Compare</button>
        </div>

        <div class="calendar-toolbar">
          <div class="calendar-head">
            <button class="btn" id="prevMonth" type="button">←</button>
            <div>
              <div class="month-title" id="monthTitle"></div>
              <div class="subtle" id="calendarHint" style="text-align:center"></div>
            </div>
            <button class="btn" id="nextMonth" type="button">→</button>
          </div>
          <div class="calendar-subview-tabs" id="calendarSubviewTabs" aria-label="Calendar content view">
            <button type="button" data-calendar-subview="daysOff">Days Off</button>
            <button type="button" data-calendar-subview="magic">Magic Hour</button>
          </div>
          <label class="field calendar-view-field" id="calendarViewField">
            <span>Month view</span>
            <select class="select" id="calendarViewSelect">
              <option value="group">Group overview</option>
              ${workers.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
            </select>
          </label>
        </div>

        <div id="calendarComparePanel" class="calendar-compare-panel" hidden>
          <div>
            <p class="eyebrow">Compare schedules</p>
            <h3>Select people</h3>
            <p class="subtle">Choose any 2 or more people, then switch between Days Off and Magic Hour.</p>
          </div>
          <div id="calendarComparePeople" class="compare-people-picker"></div>
        </div>

        <div id="calendarMonthSurface">
          <div class="weekdays"><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div></div>
          <div class="calendar" id="calendar"></div>
        </div>

        <div id="rotaGridSurface" class="rota-grid-surface" hidden>
          <div class="row-wrap between rota-grid-heading">
            <div>
              <p class="eyebrow">Department-style view</p>
              <h3>Rota grid</h3>
              <p class="subtle">Dates down the side, people across the top. Swipe sideways on mobile.</p>
            </div>
            <span class="subtle" id="rotaGridCircleLabel"></span>
          </div>
          <div class="rota-grid-scroll" id="rotaGrid"></div>
        </div>

        <div class="legend rota-colour-legend" id="calendarLegend">
          <span><i class="rota-key key-day"></i>Day</span>
          <span><i class="rota-key key-late"></i>Late / back</span>
          <span><i class="rota-key key-night"></i>Night</span>
          <span><i class="rota-key key-off"></i>Off</span>
          <span><i class="rota-key key-leave"></i>Annual leave</span>
          <span><i class="rota-key key-development"></i>Study / development</span>
          <span><i class="rota-key key-busy"></i>Other busy</span>
          <span><i class="rota-key key-unknown"></i>Unknown</span>
        </div>
      </section>

      <section class="card">
        <h2 class="section-title">Day details</h2>
        <p class="subtle" id="selectedLabel">Tap a date on the calendar.</p>
        <div id="dayDetails"></div>
      </section></div>

      <div class="tab-panel stack" data-tab-panel="more">
      <section class="card me-hub-card">
        <div class="me-profile-summary">
          ${memberAvatarHtml(state.me,"lg")}
          <div>
            <p class="eyebrow">My account</p>
            <h2>${escapeHtml(state.me.name)}</h2>
            <p class="subtle">${state.me.is_owner?"Network owner":mySharedCircleRole(state,state.activeSharedCircleId)==="admin"?"Circle admin":mySharedCircleMemberType(state,state.activeSharedCircleId)==="viewer"?"Viewer":"Working member"} · ${escapeHtml(state.group.name)}</p>
          </div>
        </div>
        <div class="me-section-tabs" id="meSectionTabs">
          <button type="button" data-me-section="profile">Profile</button>
          ${!isViewer?`<button type="button" data-me-section="schedule">My schedule</button>`:""}
          <button type="button" data-me-section="circles">Circles</button>
          <button type="button" data-me-section="settings">Settings</button>
          <button type="button" data-me-section="extras">Help & devices</button>
          ${canAdmin?`<button type="button" data-me-section="admin">Admin</button>`:""}
        </div>
      </section>

      <section class="card stack me-profile-card" id="meProfileCard" data-me-section-panel="profile">
        <div class="row-wrap between"><div><p class="eyebrow">Profile</p><h2 class="section-title">${escapeHtml(state.me.name)}</h2><p class="subtle">Edit the name and initials shown throughout the app.</p></div><img class="profile-app-icon" src="./icon-192.png" alt=""></div>
        <form id="myProfileForm" class="profile-edit-grid"><label class="field"><span>Display name</span><input class="input" id="profileDisplayName" maxlength="60" value="${escapeAttr(state.me.name)}" required></label><label class="field"><span>Calendar initials</span><input class="input" id="profileInitials" maxlength="3" value="${escapeAttr(state.members.find(x=>x.id===state.me.id)?.calendar_initials||memberInitials(state.me))}" placeholder="JB"></label><button class="btn btn-primary" type="submit">Save profile</button></form><div id="profileEditMsg" class="toast"></div>
        <div class="profile-facts"><div><span>Network</span><strong>${escapeHtml(state.group.name)}</strong></div><div><span>Current circle role</span><strong>${mySharedCircleRole(state,state.activeSharedCircleId)==="admin"?"Circle admin":isViewer?"Viewer":"Working member"}</strong></div><div><span>Handle</span><strong>@${escapeHtml(state.members.find(x=>x.id===state.me.id)?.public_handle||"—")}</strong></div><div><span>App</span><strong>v${APP_VERSION}</strong></div></div>
      </section>

      <section class="card stack help-card" data-me-section-panel="extras">
        <div><p class="eyebrow">Quick guide</p><h2 class="section-title">How it works</h2></div>
        <div class="help-steps">
          <div><strong>1 · Calendar</strong><span>Coloured initials show who is OFF / free all day.</span></div>
          <div><strong>2 · Meet</strong><span>Tonight, this weekend and the best upcoming overlaps appear automatically.</span></div>
          <div><strong>3 · Plans</strong><span>Anyone, including viewers, can suggest a plan and everyone can RSVP.</span></div>
        </div>
        <details class="help-details">
          <summary>What do Unknown and Post-night mean?</summary>
          <p><strong>Unknown</strong> means rota/availability is not entered. <strong>Post-night</strong> means the previous night shift may affect the morning. Manual availability overrides take priority in meetup calculations.</p>
        </details>
      </section>

      <section class="card stack" id="sharedCirclesSettings" data-me-section-panel="circles">
        <div class="row-wrap between"><div><p class="eyebrow">Private by default</p><h2 class="section-title">Shared circles</h2><p class="subtle">Your joined circles are below. To find another one, search by name — there is no public directory.</p></div><span class="privacy-lock">🔒 Circle access</span></div>
        <div id="sharedCircleManager" class="shared-circle-manager"></div>
        <div class="dashboard-divider"></div><form id="circleSearchForm" class="circle-search-form"><input class="input" id="circleSearchInput" placeholder="Find a circle by name"><button class="btn" type="submit">Search</button></form><div id="circleSearchResults" class="circle-search-results"></div>
        <details class="create-circle-details"><summary>+ Create a new circle</summary><form id="newSharedCircleForm" class="new-circle-form"><label class="field"><span>Circle name</span><input class="input" id="newSharedCircleName" maxlength="40" required></label><label class="field small-icon-field"><span>Icon</span><input class="input" id="newSharedCircleIcon" maxlength="8" value="◎"></label><label class="field"><span>Description</span><input class="input" id="newSharedCircleDescription" maxlength="120"></label><label class="field"><span>Discoverability</span><select class="select" id="newSharedCircleDiscoverability"><option value="searchable">Searchable by name</option><option value="invite_only">Invite only</option></select></label><button class="btn btn-primary" type="submit">Create circle</button></form></details><div id="sharedCircleMsg" class="toast"></div>
      </section>

      <section class="card stack future-schedule-card" data-me-section-panel="profile">
        <div><p class="eyebrow">One schedule</p><h2 class="section-title">My personal schedule</h2><p class="subtle">Your rota belongs to you once. The same schedule powers every shared circle you join, subject to your schedule-visibility setting.</p></div>
      </section>

      <section class="card stack" id="privacySettings" data-me-section-panel="settings">
        <div>
          <p class="eyebrow">Privacy & sharing</p>
          <h2 class="section-title">Control what your schedule shows</h2>
          <p class="subtle">Circle membership controls who can reach your availability. People outside your circles cannot retrieve your schedule or plans.</p>
        </div>
        ${!isViewer ? `<label class="field">
          <span>What other group members can see from my rota</span>
          <select class="select" id="scheduleVisibilitySelect">
            <option value="freebusy">Free / busy only</option>
            <option value="shifts">Shift times, without notes</option>
            <option value="details">Full rota details</option>
          </select>
        </label>
        <div class="privacy-explainer" id="privacyExplainer"></div>` : `<div class="notice">Viewer accounts do not publish a rota.</div>`}
        <div class="privacy-badges">
          <span>🔒 Activity: admin only</span>
          <span>👥 Availability: shared circles only</span>
          <span>🚫 No public profile</span>
        </div>
        <div id="privacyMsg" class="toast"></div>
      </section>

      
      <section class="card stack social-preferences-card" id="socialPreferences" data-me-section-panel="settings">
        <div class="row-wrap between">
          <div><p class="eyebrow">Private matching preferences</p><h2 class="section-title">Social availability</h2><p class="subtle">Your travel and recovery preferences sync privately across devices. Circle members see the resulting availability, not your settings.</p></div>
          <span class="privacy-lock">🔒 Private</span>
        </div>
        <div class="settings-grid">
          <label class="field"><span>Travel buffer before shift</span><select class="select" id="socialCommuteBefore"><option value="0">None</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option></select></label>
          <label class="field"><span>Travel / wind-down after shift</span><select class="select" id="socialCommuteAfter"><option value="0">None</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option></select></label>
          <label class="field"><span>After a night, available from</span><input class="input" id="socialPostNightUntil" type="time" value="16:00"></label>
          <label class="field"><span>Minimum useful overlap</span><select class="select" id="socialMinWindow"><option value="45">45 min · quick coffee</option><option value="60">1 hour</option><option value="90">90 min · meal</option><option value="120">2 hours · hangout</option></select></label>
          <label class="field"><span>Preferred time</span><select class="select" id="socialPreferredPeriod"><option value="any">No preference</option><option value="breakfast">Breakfast / daytime</option><option value="dinner">Dinner / evening</option></select></label>
        </div>
        <div class="notice">Default post-night rule: finishing a night shift blocks social suggestions until 16:00. After 16:00 the person can appear in Dinner suggestions if otherwise free.</div>
      </section>

      <section class="card stack" id="notificationSettings" data-me-section-panel="settings">
        <div>
          <p class="eyebrow">Notifications</p>
          <h2 class="section-title">Useful, not noisy</h2>
          <p class="subtle">These preferences are saved on this device. Notifications work while the app/PWA is active; guaranteed closed-app push can be added later.</p>
        </div>
        <label class="setting-row"><span><strong>✨ Great day found</strong><small>When a new high-confidence overlap appears</small></span><input type="checkbox" id="notifyGoodDays"></label>
        <label class="setting-row"><span><strong>📅 New plans</strong><small>When someone creates a new circle plan</small></span><input type="checkbox" id="notifyNewPlans"></label>
        <label class="setting-row"><span><strong>⏰ Plan reminders</strong><small>A friendly reminder when a plan is happening today</small></span><input type="checkbox" id="notifyPlanReminders"></label>
        <label class="setting-row"><span><strong>🗳 Group polls</strong><small>When someone asks the group to choose between dates</small></span><input type="checkbox" id="notifyPolls"></label>
        <div id="notificationMsg" class="toast"></div>
      </section>


      <section class="card stack" id="appearanceSettings" data-me-section-panel="settings">
        <div>
          <p class="eyebrow">Appearance</p>
          <h2 class="section-title">Choose your colour scheme</h2>
          <p class="subtle">Make the app feel more personal. Your choice is saved only for you on this device.</p>
        </div>
        <div class="theme-choice-grid" id="themeChoiceGrid">
          ${APP_THEMES.map(theme=>`<button class="theme-choice" type="button" data-theme-choice="${theme.key}">
            <span class="theme-swatch-row">${theme.swatches.map(colour=>`<i style="background:${colour}"></i>`).join("")}</span>
            <strong>${theme.label}</strong>
          </button>`).join("")}
        </div>
        <div class="theme-demo-strip"><span>Home</span><span>Meet</span><span>Calendar</span><span>Plans</span></div>
        <div id="appearanceMsg" class="toast"></div>
      </section>

      <section class="card stack device-manager-card" id="deviceLinkCard" data-me-section-panel="extras">
        <div class="row-wrap between"><div><p class="eyebrow">My devices</p><h2 class="section-title">Use the same account everywhere</h2><p class="subtle">Your circles, schedule, plans and polls stay with the same person on phone, tablet and computer.</p></div><span class="privacy-lock">🔐 One identity</span></div>
        <div id="myDevicesList" class="my-device-list"></div>
        <div class="device-add-panel">
          <button class="btn btn-primary" id="createDeviceCode" type="button">+ Add another device</button>
          <div id="deviceCodeResult" class="device-link-result" hidden>
            <canvas id="deviceQrCanvas" width="176" height="176" aria-label="Device link QR code"></canvas>
            <div class="stack"><strong>Scan this on the other device</strong><span class="subtle">This one-time link expires in 15 minutes.</span><strong id="deviceCodeValue" class="invite-code"></strong><div class="row-wrap"><button class="btn btn-small" id="shareDeviceLink" type="button">Share link</button><button class="btn btn-small" id="copyDeviceCode" type="button">Copy link</button></div></div>
          </div>
        </div>
        <div id="deviceCodeMsg" class="toast"></div>
      </section>

      <section class="card stack" data-me-section-panel="extras">
        <div><p class="eyebrow">Recovery</p><h2 class="section-title">Save an account recovery key</h2><p class="subtle">Keep a key in your password manager in case you lose every linked device. It works once and expires after one year. Anyone with the key can access your account.</p></div><button class="btn" id="createRecoveryKey" type="button">Create a recovery key</button><div id="recoveryKeyResult" class="notice" hidden></div>
      </section>


      ${canAdmin ? `
      <section class="card stack" id="peopleAdminCard" data-me-section-panel="admin">
        <div><p class="eyebrow">People & access</p><h2 class="section-title">Join requests</h2><p class="subtle">New accounts see nothing until an authorised circle admin approves them.</p></div>
        <div id="joinRequestsAdmin" class="join-requests-admin"></div>
        <div class="dashboard-divider"></div>
        <form id="handleSearchForm" class="stack">
          <div><strong>Find someone already in this network</strong><div class="subtle">Exact handle only — there is no global people directory.</div></div>
          <div class="row-wrap"><input class="input" id="handleSearchInput" placeholder="exact_handle"><button class="btn" type="submit">Search</button></div>
        </form>
        <div id="handleSearchResult"></div>
        <div id="peopleAdminMsg" class="toast"></div>
      </section>` : ""}
      ${state.me.is_owner ? `
      <section class="card stack app-activity-admin-card" id="appActivityAdminCard" data-me-section-panel="admin">
        <div class="row-wrap between"><div><p class="eyebrow">App owner</p><h2 class="section-title">App activity</h2><p class="subtle">Account and access events only — never private rota or plan content.</p></div><button class="btn btn-small" id="refreshAppActivity" type="button">Refresh</button></div>
        <div id="appActivityList" class="app-activity-list"></div>
      </section>

      <section class="card stack" id="membersAdminCard" data-me-section-panel="admin">
        <div class="row-wrap between">
          <div>
            <p class="eyebrow">Admin only</p>
            <h2 class="section-title">Members</h2>
            <p class="subtle">Manage membership, rota freshness and broad activity status. Activity information is visible only here to the owner.</p>
          </div>
          <button class="btn btn-small" id="refreshMemberActivity" type="button">Refresh</button>
        </div>
        <div id="memberActivitySummary" class="admin-summary"></div>
        <form id="addMemberForm" class="owner-add-grid">
          <input class="input" id="newMemberName" maxlength="40" placeholder="Name" required>
          <select class="select" id="newMemberRole"><option value="working">Working member</option><option value="viewer">Viewer</option></select>
          <select class="select" id="newMemberCircle">${joinedSharedCircles(state).map(c=>`<option value="${c.id}">${escapeHtml(c.icon||"◎")} ${escapeHtml(c.name)}</option>`).join("")}</select>
          <button class="btn btn-primary" type="submit">+ Add to circle</button>
        </form>
        <div id="ownerMsg" class="toast"></div>
        <div id="ownerList" class="owner-list"></div>
      </section>` : ""}

      <section class="card stack invite-settings-card" data-me-section-panel="extras">
        <div><p class="eyebrow">Invite people</p><h2 class="section-title">Share Our Days Off</h2><p class="subtle">They open the link, enter only their name, then can request a circle or create their own. No group code to type.</p></div>
        <div class="invite-share-layout">
          <div class="invite-qr-wrap"><canvas id="inviteQrCanvas" width="176" height="176" aria-label="App invite QR code"></canvas><small>Scan to start</small></div>
          <div class="stack"><div class="row-wrap"><button class="btn btn-primary btn-small" id="shareInvite" type="button">Share app</button><button class="btn btn-small" id="copyInviteLink" type="button">Copy link</button><button class="btn btn-small" id="installAppShortcut" type="button">Install app</button></div><div class="notice">The recipient starts private. Circle members, plans and schedules stay locked until a circle admin approves them.</div></div>
        </div>
      </section>

      <section class="card stack app-info-card" data-me-section-panel="extras">
        <div class="row-wrap between"><div><strong>Our Days Off</strong><div class="subtle">Version ${APP_VERSION}</div><div class="subtle" id="lastSyncedLabel"></div></div><div class="row-wrap"><button class="btn btn-small" id="installAppBtn" type="button">Install app</button><button class="btn btn-small" id="checkForUpdate" type="button">Check for update</button></div></div>
        <p class="subtle">Privacy: only the group owner can see broad app-activity status. Normal members and viewers cannot see when other people use the app.</p>
      </section>
      </div>

      <section class="notice network-banner" id="networkBanner" hidden></section>
      <section class="notice update-banner" id="updateBanner" hidden><div><strong>🎉 A new version is ready</strong><div class="subtle">Update now to use the latest improvements.</div></div><button class="btn btn-primary btn-small" id="applyUpdate" type="button">Update now</button></section>

      <button class="floating-plan-btn" id="floatingPlanBtn" type="button" aria-label="Make a plan">+</button>

      <div class="row-wrap between sticky-status-row">
        <div class="toast" id="status" hidden aria-live="polite"></div>
        <div class="subtle" id="connection"></div>
      </div>
    </div>


    <dialog id="accountMenuDialog" class="account-menu-dialog">
      <div class="account-menu-sheet stack">
        <div class="row-wrap between"><div class="member-identity">${memberAvatarHtml(state.me,"sm")}<div><strong>${escapeHtml(state.me.name)}</strong><small>${state.me.is_owner?"Network owner":mySharedCircleRole(state,state.activeSharedCircleId)==="admin"?"Circle admin":"Account"}</small></div></div><button class="icon-close-btn" id="closeAccountMenu" type="button">×</button></div>
        <div class="account-menu-list">
          <button type="button" data-account-section="profile">👤 <span>Profile</span></button>
          ${!isViewer?`<button type="button" data-account-section="schedule">📅 <span>My schedule</span></button>`:""}
          <button type="button" data-account-section="circles">◎ <span>Circles</span></button>
          <button type="button" data-account-section="settings">⚙️ <span>Settings</span></button>
          <button type="button" data-account-section="extras">✨ <span>Help & devices</span></button>
          ${canAdmin?`<button type="button" data-account-section="admin">🛡 <span>Admin</span></button>`:""}
        </div>
      </div>
    </dialog>
    <dialog id="scheduleDialog" class="availability-dialog">
      <form method="dialog" id="scheduleForm" class="stack">
        <div><p class="eyebrow">Edit rota</p><h2 class="section-title" id="dialogDate"></h2><p class="subtle" id="dialogPerson"></p></div>
        <div class="choice-grid">
          <label class="choice-card choice-off"><input type="radio" name="entryType" value="off"><span><strong>OFF</strong><small>Full day off</small></span></label>
          <label class="choice-card"><input type="radio" name="entryType" value="shift"><span><strong>Working shift</strong><small>Enter start and finish</small></span></label>
          <label class="choice-card"><input type="radio" name="entryType" value="partial"><span><strong>Partial / half day</strong><small>Existing manual option</small></span></label>
          <label class="choice-card"><input type="radio" name="entryType" value="busy"><span><strong>Busy / training</strong><small>ALS, induction, course, etc.</small></span></label>
          <label class="choice-card"><input type="radio" name="entryType" value="clear"><span><strong>Clear entry</strong><small>Remove this date</small></span></label>
        </div>
        <div id="shiftTimeFields" class="shift-time-grid" hidden>
          <label class="field"><span>Start</span><input class="input" id="shiftStart" type="time" value="08:00"></label>
          <label class="field"><span>Finish</span><input class="input" id="shiftEnd" type="time" value="17:00"></label>
        </div>
        <label class="field"><span>Note (optional)</span><textarea class="input note-input" id="scheduleNote" maxlength="200" rows="3" placeholder="e.g. Free after 13:00"></textarea></label>
        <label class="row"><input type="checkbox" id="repeatWeekly"><span>Repeat weekly</span></label>
        <label class="field" id="repeatWeeksField" hidden><span>Number of weeks</span><input class="input" id="repeatWeeks" type="number" min="2" max="12" value="4"></label>
        <div id="dialogMsg" class="toast"></div>
        <div class="dialog-actions"><button class="btn" id="cancelSchedule" type="button">Cancel</button><button class="btn btn-primary" id="saveSchedule" type="submit">Save</button></div>
      </form>
    </dialog>

    <dialog id="availabilityOverrideDialog" class="availability-dialog">
      <form method="dialog" id="availabilityOverrideForm" class="stack">
        <div>
          <p class="eyebrow">Meetup availability</p>
          <h2 class="section-title" id="availabilityOverrideDate"></h2>
          <p class="subtle" id="availabilityOverridePerson"></p>
        </div>

        <div class="availability-preset-box">
          <div class="row-wrap between">
            <div>
              <strong>Quick presets</strong>
              <div class="subtle">One tap fills the meal settings below. Review, then Save.</div>
            </div>
          </div>
          <div class="availability-presets" id="availabilityPresetButtons">
            <button class="preset-chip" type="button" data-availability-preset="postnight">🌙 Post-night</button>
            <button class="preset-chip" type="button" data-availability-preset="sleeping">😴 Sleeping</button>
            <button class="preset-chip" type="button" data-availability-preset="away">✈️ Away</button>
            <button class="preset-chip" type="button" data-availability-preset="family">👨‍👩‍👧 Family plans</button>
            <button class="preset-chip" type="button" data-availability-preset="freeallday">✅ Free all day</button>
            <button class="preset-chip" type="button" data-availability-preset="auto">↺ Auto from rota</button>
          </div>
          <div class="free-after-preset">
            <label class="field">
              <span>Free after…</span>
              <input class="input" id="freeAfterTime" type="time" value="13:00">
            </label>
            <button class="btn btn-small" id="freeAfterPresetBtn" type="button">Apply free-after</button>
          </div>
        </div>

        <div class="availability-override-grid">
          <label class="field">
            <span>Breakfast · 09:00</span>
            <select class="select" id="breakfastOverride">
              <option value="auto">Auto from rota</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
            </select>
          </label>
          <label class="field">
            <span>Lunch · 14:00</span>
            <select class="select" id="lunchOverride">
              <option value="auto">Auto from rota</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
            </select>
          </label>
          <label class="field">
            <span>Dinner · 20:00</span>
            <select class="select" id="dinnerOverride">
              <option value="auto">Auto from rota</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>Reason / note <span class="subtle">(optional)</span></span>
          <input class="input" id="availabilityOverrideNote" maxlength="160" placeholder="e.g. Post-night, need sleep">
        </label>

        <div id="availabilityOverrideMsg" class="toast"></div>
        <div class="dialog-actions">
          <button class="btn" id="cancelAvailabilityOverride" type="button">Cancel</button>
          <button class="btn btn-primary" id="saveAvailabilityOverride" type="submit">Save availability</button>
        </div>
      </form>
    </dialog>


    <dialog id="pollDialog" class="availability-dialog poll-create-dialog">
      <form method="dialog" id="pollForm" class="stack">
        <div><p class="eyebrow">Ask your circle</p><h2 class="section-title">Create a poll</h2><p class="subtle">Choose any dates or times — it does not have to come from Meet.</p></div>
        <label class="field"><span>Question</span><input class="input" id="pollTitle" maxlength="120" placeholder="When should we meet?" required></label>
        <label class="field"><span>Circle</span><select class="select" id="pollCircle">${joinedSharedCircles(state).filter(c=>!c.archived_at).map(c=>`<option value="${c.id}" ${c.id===state.activeSharedCircleId?"selected":""}>${escapeHtml(c.icon||"◎")} ${escapeHtml(c.name)}</option>`).join("")}</select></label>
        <label class="field"><span>Voting style</span><select class="select" id="pollChoiceMode"><option value="availability">Works / Maybe / Can’t</option><option value="single">Pick one option</option></select></label>
        <div class="poll-option-editor-head row-wrap between"><strong>Date / time options</strong><button class="btn btn-small" id="addPollDraftOption" type="button">+ Add option</button></div>
        <div id="pollDraftOptions" class="poll-draft-options"></div>
        <div class="notice">Add 2–8 choices. Time is optional, so you can poll whole dates or specific times.</div>
        <div id="pollCreateMsg" class="toast"></div>
        <div class="dialog-actions"><button class="btn" id="cancelPoll" type="button">Cancel</button><button class="btn btn-primary" id="savePoll" type="submit">Create poll</button></div>
      </form>
    </dialog>
    <dialog id="eventDialog" class="availability-dialog">
      <form method="dialog" id="eventForm" class="stack">
        <div>
          <p class="eyebrow">Group plan</p>
          <h2 class="section-title" id="eventDialogTitle">Make a plan</h2>
        </div>

        <div class="stack plan-type-step">
          <div><strong>What are we doing?</strong><div class="subtle">Pick one. If you came from Meet, date and time are already filled.</div></div>
          <div class="plan-type-grid" id="planTypeGrid">
            <button class="plan-type-btn" type="button" data-plan-category="dinner" data-default-title="Dinner">🍽<span>Dinner</span></button>
            <button class="plan-type-btn" type="button" data-plan-category="coffee" data-default-title="Coffee">☕<span>Coffee</span></button>
            <button class="plan-type-btn" type="button" data-plan-category="home" data-default-title="Get together">🏠<span>Get together</span></button>
            <button class="plan-type-btn" type="button" data-plan-category="party" data-default-title="Party">🎉<span>Party</span></button>
            <button class="plan-type-btn" type="button" data-plan-category="dayout" data-default-title="Activity / day out">⚽<span>Activity</span></button>
            <button class="plan-type-btn" type="button" data-plan-category="trip" data-default-title="Trip">✈️<span>Trip</span></button>
            <button class="plan-type-btn" type="button" data-plan-category="breakfast" data-default-title="Breakfast">🍳<span>Breakfast</span></button>
            <button class="plan-type-btn" type="button" data-plan-category="other" data-default-title="">➕<span>Other</span></button>
          </div>
          <select id="eventCategory" hidden>
            <option value="dinner">Dinner</option><option value="home">Home</option><option value="coffee">Coffee</option><option value="breakfast">Breakfast</option><option value="party">Party</option><option value="trip">Trip</option><option value="dayout">Day out</option><option value="other">Other</option>
          </select>
          <label class="field">
            <span>Audience / shared circle</span>
            <select class="select" id="eventCircle">${accessibleSharedCircles(state).map(c=>`<option value="${c.id}">${escapeHtml(c.icon||"◎")} ${escapeHtml(c.name)}</option>`).join("")}</select>
          </label>
          <label class="field">
            <span>Plan title</span>
            <input class="input" id="eventTitle" maxlength="100" placeholder="e.g. Dinner in Glasgow" required>
          </label>
        </div>

        <div class="event-date-time-grid">
          <label class="field">
            <span>Date</span>
            <input class="input" id="eventDate" type="date" required>
          </label>
          <label class="field">
            <span>Time <span class="subtle">(optional)</span></span>
            <input class="input" id="eventTime" type="time">
          </label>
        </div>

        <label class="field">
          <span>Location <span class="subtle">(optional)</span></span>
          <input class="input" id="eventLocation" maxlength="160" placeholder="e.g. Glasgow / Junaid's house">
        </label>

        <label class="field">
          <span>Plan details <span class="subtle">(optional · editable by plan creator)</span></span>
          <textarea class="input note-input" id="eventNote" maxlength="400" rows="3" placeholder="Main details everyone should know"></textarea>
        </label>

        <div id="eventMsg" class="toast"></div>
        <div class="dialog-actions">
          <button class="btn btn-danger" id="deleteEventBtn" type="button" hidden>Delete</button>
          <button class="btn" id="cancelEvent" type="button">Cancel</button>
          <button class="btn btn-primary" id="saveEvent" type="submit">Save plan</button>
        </div>
      </form>
    </dialog>

    ${state.me.is_owner ? `<dialog id="memberAdminDialog" class="availability-dialog">
      <div class="stack">
        <div><p class="eyebrow">Admin only</p><h2 class="section-title" id="memberAdminDialogTitle">Member</h2></div>
        <div id="memberAdminDialogBody"></div>
        <div class="dialog-actions"><button class="btn" id="closeMemberAdminDialog" type="button">Close</button></div>
      </div>
    </dialog>` : ""}

    <dialog id="welcomeGuideDialog" class="welcome-guide-dialog">
      <div class="stack">
        <div><p class="eyebrow">You’re in 🎉</p><h2 class="section-title">Three things to know</h2><p class="subtle">The app should make sense in under a minute.</p></div>
        <div class="welcome-guide-steps">
          <div><span>1</span><div><strong>Add your schedule</strong><small>Upload a rota or add availability manually.</small></div></div>
          <div><span>2</span><div><strong>Meet finds the overlap</strong><small>Tonight, this weekend and later are ranked automatically.</small></div></div>
          <div><span>3</span><div><strong>Make a plan</strong><small>Anyone can suggest something and the group can RSVP.</small></div></div>
        </div>
        <div class="dialog-actions">
          <button class="btn" id="welcomeExploreBtn" type="button">Explore</button>
          ${!isViewer ? `<button class="btn btn-primary" id="welcomeAddScheduleBtn" type="button">Add my schedule</button>` : `<button class="btn btn-primary" id="welcomeMeetBtn" type="button">See when people are free</button>`}
        </div>
      </div>
    </dialog>

    <p class="footer">Our Days Off is for social planning, not an official employment rota. Do not enter patient-identifiable or confidential clinical information.</p>`;

  state.setStatus = (text, error = false) => {
    const el = $("#status");
    if (el) { clearTimeout(state.statusTimer);el.textContent=text;el.style.color=error?"var(--danger)":"";el.setAttribute("role",error?"alert":"status");el.hidden=false;if(!error)state.statusTimer=setTimeout(()=>{el.hidden=true;},4500); }
  };

  $("#copyInviteLink")?.addEventListener("click", async () => {
    const inviteUrl=buildInviteUrl(state);
    try { await navigator.clipboard.writeText(inviteUrl); state.setStatus("App link copied ✓"); }
    catch { window.prompt("Copy app link:", inviteUrl); }
  });

  $("#shareInvite")?.addEventListener("click", async () => {
    const inviteUrl=buildInviteUrl(state);
    const shareData={title:"Our Days Off",text:`Join me on Our Days Off — enter your name and start planning.`,url:inviteUrl};
    try{
      if(navigator.share){await navigator.share(shareData);state.setStatus("Invite opened for sharing.");}
      else{await navigator.clipboard.writeText(inviteUrl);state.setStatus("App link copied ✓");}
    }catch(error){if(error?.name!=="AbortError"){try{await navigator.clipboard.writeText(inviteUrl);state.setStatus("App link copied ✓");}catch{window.prompt("Copy app link:",inviteUrl);}}}
  });
  $("#installAppShortcut")?.addEventListener("click",()=>installApp(state));

  $("#prevMonth").addEventListener("click", async () => { state.view = addMonths(state.view, -1); await refreshRotaRows(state);renderRotaCalendar(state); });
  $("#nextMonth").addEventListener("click", async () => { state.view = addMonths(state.view, 1); await refreshRotaRows(state);renderRotaCalendar(state); });

  $("#calendarViewSelect").value = state.calendarView;
  $("#calendarViewSelect").addEventListener("change", e => {
    state.calendarView=e.target.value;
    renderRotaCalendar(state);
  });
  document.querySelectorAll("#calendarLayoutTabs [data-calendar-layout]").forEach(btn=>{
    btn.addEventListener("click",()=>setCalendarLayout(state,btn.dataset.calendarLayout));
  });
  document.querySelectorAll("#calendarSubviewTabs [data-calendar-subview]").forEach(btn=>{
    btn.addEventListener("click",()=>setCalendarSubview(state,btn.dataset.calendarSubview));
  });

  wireDeviceCode(state);
  renderMyDevices(state);
  renderAppActivity(state);
  wireDashboardActions(state);
  wireNotificationSettings(state);
  wirePrivacySettings(state);
  wireAppearanceSettings(state);
  renderSocialPreferences(state);
  wireSocialPreferences(state);
  wireMeetRangeTabs(state);
  wireMainTabs(state);
  wireMeHub(state);
  renderInviteQr(state);
  wireWelcomeGuide(state);
  renderRecentActivity(state);
  renderGroupPolls(state);
  renderCircleSwitchers(state);
  renderSharedCircleManager(state);
  renderJoinRequestsAdmin(state);
  renderCalendarComparePicker(state);
  wireSharedCircleManager(state);
  wireJoinRequestsAdmin(state);
  wireAccountMenu(state);
  wireMyProfile(state);
  renderShiftDictionary(state);
  wireShiftDictionary(state);

  $("#manageCirclesBtn")?.addEventListener("click",()=>openMeSection(state,"circles"));
  $("#floatingPlanBtn")?.addEventListener("click",()=>openEventDialog(state,null,dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate())));
  $("#refreshFeedBtn")?.addEventListener("click",async()=>{await refreshSocialExtras(state);renderRecentActivity(state);renderGroupPolls(state);state.setStatus("Group activity refreshed ✓");});
  $("#checkForUpdate")?.addEventListener("click",()=>checkForAppUpdate(state));
  $("#applyUpdate")?.addEventListener("click",()=>applyAppUpdate());
  $("#installAppBtn")?.addEventListener("click", () => installApp(state));
  wireEventDialog(state);
  $("#addEventBtn")?.addEventListener("click", () => openEventDialog(state, null, state.selectedDate || dateString(todayUtc().getUTCFullYear(), todayUtc().getUTCMonth(), todayUtc().getUTCDate())));
  if (!isViewer) {
    wireScheduleDialog(state);
    wireFullRotaImport(state);
    wireSpreadsheetRotaImport(state);
    wireAiRotaImport(state);
    wireImageRotaImport(state);
    wireAvailabilityOverrideDialog(state);
  }

  if (state.me.is_owner) {
    $("#addMemberForm").addEventListener("submit", async e => {
      e.preventDefault();
      const name = $("#newMemberName").value.trim();
      if (!name) return;
      const button = e.currentTarget.querySelector("button");
      button.disabled = true;
      const { data:newMemberId, error } = await state.supabase.rpc("add_person", { p_member_name: name, p_role: "member" });
      if (!error && newMemberId && $("#newMemberCircle").value) {
        const addRes=await state.supabase.rpc("add_person_to_circle_v13",{p_circle_id:$("#newMemberCircle").value,p_target_member_id:newMemberId,p_role:"member"});
        if(addRes.error){button.disabled=false;return setMsg($("#ownerMsg"),addRes.error.message,true);}
        const typeRes=await state.supabase.rpc("set_circle_member_type_v13_3",{p_circle_id:$("#newMemberCircle").value,p_target_member_id:newMemberId,p_member_type:$("#newMemberRole").value});
        if(typeRes.error){button.disabled=false;return setMsg($("#ownerMsg"),typeRes.error.message,true);}
      }
      button.disabled = false;
      if (error) return setMsg($("#ownerMsg"), error.message, true);
      await loadGroup(state); renderMain(state);
    });
    $("#refreshAppActivity")?.addEventListener("click",async()=>{
      const {data,error}=await state.supabase.rpc("get_app_activity_owner_v13_3",{p_limit:80});
      if(error)return state.setStatus(error.message,true);state.appActivity=data||[];renderAppActivity(state);state.setStatus("App activity refreshed ✓");
    });
    $("#refreshMemberActivity")?.addEventListener("click",async()=>{
      await refreshMemberActivity(state);
      renderOwnerList(state);
      state.setStatus("Member activity refreshed ✓");
    });
    $("#closeMemberAdminDialog")?.addEventListener("click",()=>$("#memberAdminDialog").close());
    renderOwnerList(state);
  }

  showPendingUpdateBanner();
  updateNetworkUI(state);
  updateLastSyncedLabel(state);
  renderRotaCalendar(state);
  updateMainTabUI(state);
  renderMeSection(state);
  renderUpcomingEvents(state);
  setTimeout(()=>applyPendingDeepLink(state),60);
  renderDashboard(state);
}



function wireMyProfile(state){
  $("#myProfileForm")?.addEventListener("submit",async e=>{e.preventDefault();const name=$("#profileDisplayName").value.trim();const initials=$("#profileInitials").value.trim().toUpperCase();const btn=e.currentTarget.querySelector('button[type="submit"]');btn.disabled=true;const {error}=await state.supabase.rpc("update_my_profile_v13_3",{p_name:name,p_initials:initials||null});btn.disabled=false;if(error)return setMsg($("#profileEditMsg"),error.message,true);state.me.name=name;await loadGroup(state);renderMain(state);openMeSection(state,"profile");state.setStatus?.("Profile updated ✓");});
}
function shiftDefKey(code){return String(code||"").toUpperCase().replace(/[^A-Z0-9]+/g,"");}
function shiftDefFor(state,code){return (state.shiftDefinitions||[]).find(x=>shiftDefKey(x.code)===shiftDefKey(code))||null;}
function renderShiftDictionary(state){
  const h=$("#shiftDictionaryList");if(!h)return;h.innerHTML=(state.shiftDefinitions||[]).length?state.shiftDefinitions.map(d=>`<div class="shift-dict-row"><strong>${escapeHtml(d.code)}</strong><span>${escapeHtml(d.kind)}${d.kind==="working"?` · ${minutesToInputTime(d.start_min)}–${minutesToInputTime(d.end_min)}`:""}</span><button class="btn btn-tiny" data-delete-shift-def="${d.id}" type="button">Delete</button></div>`).join(""):`<div class="subtle">No saved shift codes yet. AI import can create them.</div>`;
}
function wireShiftDictionary(state){
  $("#shiftDictionaryList")?.querySelectorAll("[data-delete-shift-def]").forEach(btn=>btn.addEventListener("click",async()=>{const {error}=await state.supabase.rpc("delete_my_shift_definition_v13_3",{p_id:Number(btn.dataset.deleteShiftDef)});if(error)return state.setStatus?.(error.message,true);const {data}=await state.supabase.rpc("get_my_shift_definitions_v13_3");state.shiftDefinitions=data||[];renderShiftDictionary(state);}));
}
function renderMeSection(state){
  const valid=["profile","schedule","circles","settings","extras","admin"];
  if(!valid.includes(state.meSection)) state.meSection="profile";
  if(mySharedCircleMemberType(state,state.activeSharedCircleId)==="viewer"&&state.meSection==="schedule") state.meSection="profile";
  if(!canManageAnyCircle(state)&&state.meSection==="admin") state.meSection="profile";

  document.querySelectorAll("[data-me-section-panel]").forEach(panel=>{
    panel.hidden=panel.dataset.meSectionPanel!==state.meSection;
  });
  document.querySelectorAll("#meSectionTabs [data-me-section]").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.meSection===state.meSection);
  });
}

function openMeSection(state,section="profile"){
  state.meSection=section;
  switchMainTab(state,"more",{keepScroll:true});
  renderMeSection(state);
  window.scrollTo({top:0,behavior:"smooth"});
}

function wireMeHub(state){
  document.querySelectorAll("#meSectionTabs [data-me-section]").forEach(btn=>{
    btn.addEventListener("click",()=>{state.meSection=btn.dataset.meSection;renderMeSection(state);});
  });
}


function wireAccountMenu(state){
  const dialog=$("#accountMenuDialog");
  const open=()=>{if(dialog&&!dialog.open) dialog.showModal();};
  $("#homeBrandButton")?.addEventListener("click",open);
  $("#accountChip")?.addEventListener("click",open);
  $("#closeAccountMenu")?.addEventListener("click",()=>dialog?.close());
  dialog?.querySelectorAll("[data-account-section]").forEach(btn=>btn.addEventListener("click",()=>{
    const section=btn.dataset.accountSection;dialog.close();openMeSection(state,section);
  }));
}

async function setActiveSharedCircle(state,circleId){
  if(!discoverableSharedCircles(state).some(x=>x.id===circleId)) return;
  if(!isCircleJoined(state,circleId)) return requestJoinCircle(state,circleId);
  state.activeSharedCircleId=circleId;
  localStorage.setItem(sharedCircleSelectionKey(state),circleId);
  state.calendarCompareIds=loadCalendarCompareSelection(state);
  await refreshCircleSocial(state);
  renderMain(state);
}

function renderSharedCircleManager(state){
  const holder=$("#sharedCircleManager");if(!holder)return;const circles=joinedSharedCircles(state);
  holder.innerHTML=circles.length?circles.map(c=>{const members=sharedCircleMembers(state,c.id),mine=mySharedCircleRole(state,c.id),manager=canManageCircle(state,c.id);return `<div class="shared-circle-card ${c.id===state.activeSharedCircleId?"active":""} ${c.archived_at?"archived":""}"><div class="row-wrap between"><button type="button" class="shared-circle-title" data-switch-shared-circle="${c.id}"><span>${escapeHtml(c.icon||"◎")}</span><div><strong>${escapeHtml(c.name)}</strong><small>${c.archived_at?"Archived · ":""}${members.length} member${members.length===1?"":"s"} · ${mine==="admin"?"Admin":"Member"}</small></div></button>${c.id===state.activeSharedCircleId?`<span class="active-circle-badge">Active</span>`:""}</div>${manager?`<details class="circle-settings-panel"><summary>⚙️ Circle settings</summary><form class="circle-edit-form" data-edit-circle="${c.id}"><label class="field"><span>Name</span><input class="input" name="circleName" maxlength="40" value="${escapeAttr(c.name)}" required></label><label class="field"><span>Icon</span><input class="input" name="circleIcon" maxlength="8" value="${escapeAttr(c.icon||"◎")}"></label><label class="field"><span>Description</span><input class="input" name="circleDescription" maxlength="120" value="${escapeAttr(c.description||"")}"></label><label class="field"><span>Discoverability</span><select class="select" name="circleDiscoverability"><option value="searchable" ${c.discoverability!=="invite_only"?"selected":""}>Searchable by name</option><option value="invite_only" ${c.discoverability==="invite_only"?"selected":""}>Invite only</option></select></label><button class="btn btn-small" type="submit">Save circle details</button></form><div class="row-wrap"><button class="btn btn-small" type="button" data-archive-circle="${c.id}" data-archived="${c.archived_at?"1":"0"}">${c.archived_at?"Restore":"Archive"}</button><button class="btn btn-small btn-danger" type="button" data-delete-shared-circle="${c.id}">Delete circle</button></div></details>`:""}<div class="shared-circle-member-list detailed">${members.map(m=>{const ms=circleMembership(state,c.id,m.id)||{};return `<div class="circle-member-row">${memberAvatarHtml(m,"tiny")}<span><strong>${escapeHtml(m.name)}</strong><small>${ms.role==="admin"?"Circle admin · ":""}${ms.member_type==="viewer"?"Viewer":"Working member"}</small></span>${manager&&m.id!==state.me.id?`<select class="select select-tiny" data-member-type-circle="${c.id}" data-target-member="${m.id}"><option value="working" ${ms.member_type!=="viewer"?"selected":""}>Working</option><option value="viewer" ${ms.member_type==="viewer"?"selected":""}>Viewer</option></select><button class="btn btn-tiny" type="button" data-toggle-circle-admin="${c.id}" data-target-member="${m.id}" data-current-role="${ms.role||"member"}">${ms.role==="admin"?"Make member":"Make admin"}</button><button class="btn btn-tiny btn-danger" type="button" data-remove-circle-member="${c.id}" data-target-member="${m.id}">Remove</button>`:""}</div>`}).join("")}</div><div class="row-wrap">${manager&&!c.archived_at?`<button class="btn btn-small" type="button" data-circle-invite="${c.id}">Invite to circle</button>`:""}<button class="btn btn-small" type="button" data-leave-circle="${c.id}">Leave circle</button></div><div class="circle-invite-result" data-circle-invite-result="${c.id}"></div></div>`;}).join(""):`<div class="notice">You have not joined a circle yet.</div>`;
}

function wireSharedCircleManager(state){
  const holder=$("#sharedCircleManager");if(!holder)return;
  holder.querySelectorAll("[data-switch-shared-circle]").forEach(btn=>btn.addEventListener("click",()=>setActiveSharedCircle(state,btn.dataset.switchSharedCircle)));
  holder.querySelectorAll("[data-edit-circle]").forEach(form=>form.addEventListener("submit",async e=>{e.preventDefault();const {error}=await state.supabase.rpc("edit_shared_circle_v13_3",{p_circle_id:form.dataset.editCircle,p_name:form.circleName.value.trim(),p_icon:form.circleIcon.value.trim()||"◎",p_description:form.circleDescription.value.trim()||null,p_discoverability:form.circleDiscoverability.value});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"circles");}));
  holder.querySelectorAll("[data-archive-circle]").forEach(btn=>btn.addEventListener("click",async()=>{const archived=btn.dataset.archived==="1";const {error}=await state.supabase.rpc("set_circle_archived_v13_2",{p_circle_id:btn.dataset.archiveCircle,p_archived:!archived});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"circles");}));
  holder.querySelectorAll("[data-circle-invite]").forEach(btn=>btn.addEventListener("click",async()=>{btn.disabled=true;const {data,error}=await state.supabase.rpc("create_circle_invite_v13",{p_circle_id:btn.dataset.circleInvite});btn.disabled=false;if(error)return state.setStatus?.(error.message,true);const url=buildCircleInviteUrl(data),target=holder.querySelector(`[data-circle-invite-result="${btn.dataset.circleInvite}"]`);target.innerHTML=`<div class="circle-invite-box"><span>Private invite ready</span><button class="btn btn-tiny" type="button">Copy link</button></div>`;target.querySelector("button").onclick=async()=>{try{await navigator.clipboard.writeText(url);state.setStatus?.("Circle invite copied ✓");}catch{window.prompt("Copy circle invite:",url);}};}));
  holder.querySelectorAll("[data-member-type-circle]").forEach(sel=>sel.addEventListener("change",async()=>{const {error}=await state.supabase.rpc("set_circle_member_type_v13_3",{p_circle_id:sel.dataset.memberTypeCircle,p_target_member_id:sel.dataset.targetMember,p_member_type:sel.value});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"circles");}));
  holder.querySelectorAll("[data-remove-circle-member]").forEach(btn=>btn.addEventListener("click",async()=>{const person=state.members.find(x=>x.id===btn.dataset.targetMember);if(!confirm(`Remove ${person?.name||"this person"} from this circle?`))return;const {error}=await state.supabase.rpc("remove_person_from_circle_v13",{p_circle_id:btn.dataset.removeCircleMember,p_target_member_id:btn.dataset.targetMember});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"circles");}));
  holder.querySelectorAll("[data-toggle-circle-admin]").forEach(btn=>btn.addEventListener("click",async()=>{const next=btn.dataset.currentRole==="admin"?"member":"admin";const {error}=await state.supabase.rpc("set_circle_member_role_v13",{p_circle_id:btn.dataset.toggleCircleAdmin,p_target_member_id:btn.dataset.targetMember,p_role:next});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"circles");}));
  holder.querySelectorAll("[data-leave-circle]").forEach(btn=>btn.addEventListener("click",async()=>{if(!confirm("Leave this circle? You will immediately lose its private content."))return;const {error}=await state.supabase.rpc("remove_person_from_circle_v13",{p_circle_id:btn.dataset.leaveCircle,p_target_member_id:state.me.id});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);if(!joinedSharedCircles(state).length)return renderPendingAccess(state);renderMain(state);openMeSection(state,"circles");}));
  holder.querySelectorAll("[data-delete-shared-circle]").forEach(btn=>btn.addEventListener("click",async()=>{const circle=joinedSharedCircles(state).find(x=>x.id===btn.dataset.deleteSharedCircle);if(!circle)return;const typed=prompt(`Delete “${circle.name}”? Type the circle name exactly:`);if(typed!==circle.name)return;const {error}=await state.supabase.rpc("delete_shared_circle_v13_2",{p_circle_id:circle.id});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);if(!joinedSharedCircles(state).length)return renderPendingAccess(state);renderMain(state);openMeSection(state,"circles");}));
  $("#newSharedCircleForm")?.addEventListener("submit",async e=>{e.preventDefault();const {error}=await state.supabase.rpc("create_shared_circle_v13_3",{p_name:$("#newSharedCircleName").value.trim(),p_icon:$("#newSharedCircleIcon").value.trim()||"◎",p_description:$("#newSharedCircleDescription").value.trim()||null,p_discoverability:$("#newSharedCircleDiscoverability").value});if(error)return setMsg($("#sharedCircleMsg"),error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"circles");});
  $("#circleSearchForm")?.addEventListener("submit",e=>{e.preventDefault();searchCircles(state,$("#circleSearchInput").value,$("#circleSearchResults"));});
}

function renderJoinRequestsAdmin(state){
  const holder=$("#joinRequestsAdmin");if(!holder)return;const requests=(state.joinRequests||[]).filter(r=>r.member_id!==state.me.id);
  holder.innerHTML=requests.length?requests.map(r=>`<div class="join-request-card"><div class="member-identity"><div><strong>${escapeHtml(r.member_name)}</strong><small>@${escapeHtml(r.public_handle||"")} · wants to join ${escapeHtml(r.circle_name||"circle")}</small></div></div><div class="requested-circle-fixed">Requested role: <strong>${r.requested_member_type==="viewer"?"Viewer":"Working member"}</strong></div><label class="field"><span>Approve as</span><select class="select" data-approve-type="${r.request_id}"><option value="working" ${r.requested_member_type!=="viewer"?"selected":""}>Working member</option><option value="viewer" ${r.requested_member_type==="viewer"?"selected":""}>Viewer</option></select></label><div class="row-wrap"><button class="btn btn-primary btn-small" data-approve-request="${r.request_id}" type="button">Approve</button><button class="btn btn-small" data-reject-request="${r.request_id}" type="button">Reject</button></div></div>`).join(""):`<div class="subtle">No pending join requests for circles you administer.</div>`;
}

function wireJoinRequestsAdmin(state){
  const holder=$("#joinRequestsAdmin");holder?.querySelectorAll("[data-approve-request]").forEach(btn=>btn.addEventListener("click",async()=>{const type=holder.querySelector(`[data-approve-type="${btn.dataset.approveRequest}"]`)?.value||"working";const {error}=await state.supabase.rpc("approve_join_request_v13_3",{p_request_id:btn.dataset.approveRequest,p_member_type:type});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"admin");}));holder?.querySelectorAll("[data-reject-request]").forEach(btn=>btn.addEventListener("click",async()=>{const {error}=await state.supabase.rpc("reject_join_request_v13",{p_request_id:btn.dataset.rejectRequest});if(error)return state.setStatus?.(error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"admin");}));
  $("#handleSearchForm")?.addEventListener("submit",async e=>{e.preventDefault();const handle=$("#handleSearchInput").value.trim(),target=$("#handleSearchResult");if(!handle)return;const {data,error}=await state.supabase.rpc("find_person_by_handle_v13",{p_handle:handle});if(error)return setMsg($("#peopleAdminMsg"),error.message,true);const person=data?.[0];if(!person)return target.innerHTML=`<div class="subtle">No exact handle found.</div>`;const managed=joinedSharedCircles(state).filter(c=>canManageCircle(state,c.id));target.innerHTML=`<div class="handle-result"><strong>${escapeHtml(person.name)}</strong><span>@${escapeHtml(person.public_handle)}</span><select class="select" id="handleAddCircle">${managed.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select><select class="select" id="handleAddType"><option value="working">Working</option><option value="viewer">Viewer</option></select><button class="btn btn-small" id="handleAddBtn" type="button">Add</button></div>`;$("#handleAddBtn").onclick=async()=>{const add=await state.supabase.rpc("add_person_to_circle_v13",{p_circle_id:$("#handleAddCircle").value,p_target_member_id:person.member_id,p_role:"member"});if(add.error)return setMsg($("#peopleAdminMsg"),add.error.message,true);const type=await state.supabase.rpc("set_circle_member_type_v13_3",{p_circle_id:$("#handleAddCircle").value,p_target_member_id:person.member_id,p_member_type:$("#handleAddType").value});if(type.error)return setMsg($("#peopleAdminMsg"),type.error.message,true);await loadGroup(state);renderMain(state);openMeSection(state,"admin");};});
}

function buildCircleInviteUrl(code){const url=new URL(window.location.href);url.search="";url.hash="";url.searchParams.set("circle",code);return url.toString();}

function switchMainTab(state, tab, options = {}) {
  state.activeTab = tab;
  if(tab==="meetups")renderMeetupSuggestions(state);
  updateMainTabUI(state);
  if(tab==="more") renderMeSection(state);
  if (!options.keepScroll) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function wireMainTabs(state) {
  document.querySelectorAll("#mainTabs [data-tab], #mobileBottomNav [data-tab]").forEach(btn => {
    btn.addEventListener("click", () => switchMainTab(state, btn.dataset.tab));
  });
}

function updateMainTabUI(state) {
  const active = state.activeTab || "home";
  document.querySelectorAll("[data-tab-panel]").forEach(panel => {
    panel.hidden = panel.dataset.tabPanel !== active;
  });
  document.querySelectorAll("#mainTabs [data-tab], #mobileBottomNav [data-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === active);btn.setAttribute("aria-current",btn.dataset.tab===active?"page":"false");
  });
}

function wireDeviceCode(state){
  $("#createRecoveryKey")?.addEventListener("click",async()=>{
    if(!confirm("Create a new recovery key? Any previous recovery key will stop working."))return;
    const button=$("#createRecoveryKey");button.disabled=true;
    try{
      const key=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
      const {error}=await state.supabase.rpc("set_recovery_key_v14",{p_key:key});if(error)throw error;
      const box=$("#recoveryKeyResult");box.hidden=false;box.innerHTML='<strong>Save this key now</strong><p>Store it in your password manager. It is shown only here.</p><code style="overflow-wrap:anywhere"></code><button class="btn" type="button">I have saved it</button>';
      box.querySelector("code").textContent=key;box.querySelector("button").onclick=()=>{box.textContent="Recovery key created. Keep it private.";};
    }catch(error){state.setStatus?.(error.message,true);}finally{button.disabled=false;}
  });
  $("#createDeviceCode")?.addEventListener("click",async()=>{
    const b=$("#createDeviceCode");b.disabled=true;const {data,error}=await state.supabase.rpc("create_device_link_code");b.disabled=false;if(error)return setMsg($("#deviceCodeMsg"),error.message,true);
    const link=buildDeviceLinkUrl(data);$("#deviceCodeValue").textContent=data;$("#deviceCodeResult").hidden=false;setMsg($("#deviceCodeMsg"),"One-time link ready · expires in 15 minutes.");
    const canvas=$("#deviceQrCanvas");if(canvas&&window.QRCode?.toCanvas){try{await new Promise((resolve,reject)=>window.QRCode.toCanvas(canvas,link,{width:176,margin:1,errorCorrectionLevel:"M"},err=>err?reject(err):resolve()));}catch{}}
    $("#copyDeviceCode").onclick=async()=>{try{await navigator.clipboard.writeText(link);setMsg($("#deviceCodeMsg"),"Device link copied ✓");}catch{window.prompt("Copy device link:",link);}};
    $("#shareDeviceLink").onclick=async()=>{try{if(navigator.share)await navigator.share({title:"Link Our Days Off",text:"Open this one-time link on my other device.",url:link});else await navigator.clipboard.writeText(link);}catch(e){if(e?.name!=="AbortError")window.prompt("Copy device link:",link);}};
  });
}
function buildDeviceLinkUrl(code){const url=new URL(window.location.href);url.search="";url.hash="";url.searchParams.set("device",code);return url.toString();}




function renderMyDevices(state){
  const holder=$("#myDevicesList");if(!holder)return;
  const devices=state.myDevices||[];
  holder.innerHTML=devices.length?devices.map(d=>`<div class="my-device-row ${d.is_current?"current":""}"><div><strong>${escapeHtml(d.device_name||"Linked device")}</strong><small>${d.is_current?"This device · ":""}${d.last_seen_at?`Last active ${escapeHtml(relativeTime(d.last_seen_at))}`:`Linked ${escapeHtml(new Date(d.created_at).toLocaleDateString("en-GB"))}`}</small></div>${d.is_current?`<span class="device-current-badge">Current</span>`:`<button class="btn btn-tiny btn-danger" type="button" data-unlink-device="${d.device_id}">Remove</button>`}</div>`).join(""):`<div class="soft-empty">This device is linked.</div>`;
  holder.querySelectorAll("[data-unlink-device]").forEach(btn=>btn.addEventListener("click",async()=>{if(!window.confirm("Remove this linked device? It will lose access to your account."))return;const {error}=await state.supabase.rpc("unlink_my_device_v13_2",{p_device_id:Number(btn.dataset.unlinkDevice)});if(error)return setMsg($("#deviceCodeMsg"),error.message,true);const {data}=await state.supabase.rpc("get_my_devices_v13_2");state.myDevices=data||[];renderMyDevices(state);setMsg($("#deviceCodeMsg"),"Device removed ✓");}));
}
function appActivityText(item){
  const meta=item.meta||{};const subject=item.member_name||meta.member_name||"Someone";
  return ({account_created:`${subject} started using the app`,device_linked:`${subject} linked a device`,device_unlinked:`${subject} removed a linked device`,circle_join_requested:`${subject} requested to join ${meta.circle_name||"a circle"}`,circle_join_approved:`${subject} was approved into ${meta.circle_name||"a circle"}`,circle_join_rejected:`${subject}’s request was rejected`,circle_joined:`${subject} joined ${meta.circle_name||"a circle"}`,circle_left:`${subject} left ${meta.circle_name||"a circle"}`,circle_created:`${subject} created ${meta.circle_name||"a circle"}`,circle_renamed:`${meta.old_name||"A circle"} was renamed to ${meta.new_name||"a new name"}`,circle_archived:`${meta.circle_name||"A circle"} was archived`,circle_restored:`${meta.circle_name||"A circle"} was restored`,circle_deleted:`${meta.circle_name||"A circle"} was deleted`,account_deactivated:`${subject} deactivated their account`})[item.kind]||`${subject} · ${String(item.kind||"activity").replaceAll("_"," ")}`;
}
function renderAppActivity(state){
  const holder=$("#appActivityList");if(!holder)return;const items=(state.appActivity||[]).slice(0,80);
  holder.innerHTML=items.length?items.map(item=>`<div class="app-activity-row"><span class="app-activity-dot"></span><div><strong>${escapeHtml(appActivityText(item))}</strong><small>${escapeHtml(relativeTime(item.created_at))}</small></div></div>`).join(""):`<div class="soft-empty">New account and access activity will appear here.</div>`;
}

function calendarLayoutKey(state){
  return `odoCalendarLayout:${state.me?.group_id||"group"}:${state.me?.id||"member"}`;
}
function setCalendarLayout(state,layout){
  if(!["month","grid","compare"].includes(layout)) layout="month";
  state.calendarLayout=layout;
  if(layout!=="month") state.calendarView="group";
  localStorage.setItem(calendarLayoutKey(state),layout);
  const select=$("#calendarViewSelect");if(select)select.value=state.calendarView;
  renderRotaCalendar(state);
}
function renderCalendarLayoutTabs(state){
  document.querySelectorAll("#calendarLayoutTabs [data-calendar-layout]").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.calendarLayout===(state.calendarLayout||"month"));btn.setAttribute("aria-pressed",String(btn.dataset.calendarLayout===(state.calendarLayout||"month")));
  });
}


function currentCalendarSubview(state){
  return state.calendarLayout==="compare" ? (state.compareCalendarMode||"daysOff") : (state.calendarMonthMode||"daysOff");
}
function setCalendarSubview(state,mode){
  if(!["daysOff","magic"].includes(mode))mode="daysOff";
  if(state.calendarLayout==="compare"){
    state.compareCalendarMode=mode;
    localStorage.setItem("odoCompareCalendarMode",mode);
  }else{
    state.calendarMonthMode=mode;
    localStorage.setItem("odoCalendarMonthMode",mode);
  }
  renderRotaCalendar(state);
}
function renderCalendarSubviewTabs(state){
  const holder=$("#calendarSubviewTabs");
  if(!holder)return;
  const visible=state.calendarLayout==="month"||state.calendarLayout==="compare";
  holder.hidden=!visible;
  if(!visible)return;
  const active=currentCalendarSubview(state);
  holder.querySelectorAll("[data-calendar-subview]").forEach(btn=>{btn.classList.toggle("active",btn.dataset.calendarSubview===active);btn.setAttribute("aria-pressed",String(btn.dataset.calendarSubview===active));});
}
function offMembersForDay(state,members,day){
  return members.filter(member=>memberIsFullDayOff(state,member,day));
}
function allMemberAvatars(members,size="tiny"){
  if(!members?.length)return "";
  return `<span class="calendar-off-avatars" aria-label="${escapeAttr(members.map(m=>m.name).join(", "))}">${members.map(m=>memberAvatarHtml(m,size)).join("")}</span>`;
}

function compactGridTime(minute){
  if(!Number.isInteger(minute)) return "";
  const h=Math.floor(minute/60),m=minute%60;
  return m===0?String(h).padStart(2,"0"):`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function rotaSemanticClass(entry){
  if(!entry) return "grid-unknown";
  const raw=String(entry.raw_value||entry.note||"").trim().toUpperCase();

  if(/\b(ANNUAL\s*LEAVE|A\/L|AL|ANNUAL|LEAVE)\b/.test(raw)) return "grid-leave";
  if(/\b(EDT|STUDY|DEVELOPMENT|DEVELOP|SDT|SPA|TEACHING)\b/.test(raw)) return "grid-development";

  if(entry.entry_type==="off") return "grid-off";
  if(entry.entry_type==="shift"){
    const start=entry.shift_start_min,end=entry.shift_end_min;
    const overnight=Number.isInteger(start)&&Number.isInteger(end)&&(end<=start||start>=19*60);
    if(overnight) return "grid-night";
    if(Number.isInteger(start)&&start>=12*60) return "grid-late";
    return "grid-day";
  }
  if(entry.entry_type==="busy"){
    if(/\b(ALS|ATLS|COURSE|INDUCTION|TASTER|TRAINING|EXAM)\b/.test(raw)) return "grid-busy";
    return "grid-busy";
  }
  return "grid-busy";
}
function compactRotaGridLabel(state,member,entry){
  if(!entry) return "—";
  const mode=memberScheduleVisibility(state,member);
  if(mode==="freebusy") return entry.entry_type==="off"?"FREE":"BUSY";

  const raw=String(entry.raw_value||"").trim();
  const upper=raw.toUpperCase();
  if(/\b(ANNUAL\s*LEAVE|A\/L|AL)\b/.test(upper)) return upper.includes("ANNUAL")?"A/L":"A/L";
  if(/\b(EDT|STUDY|DEVELOPMENT|DEVELOP|SDT|SPA)\b/.test(upper)){
    if(upper.includes("EDT")) return "EDT";
    if(upper.includes("STUD")) return "STUDY";
    return "DEV";
  }
  if(entry.entry_type==="off") return "OFF";
  if(entry.entry_type==="shift"&&Number.isInteger(entry.shift_start_min)&&Number.isInteger(entry.shift_end_min)){
    return `${compactGridTime(entry.shift_start_min)}-${compactGridTime(entry.shift_end_min)}`;
  }
  if(entry.entry_type==="busy") return raw?raw.slice(0,10).toUpperCase():"BUSY";
  return raw?raw.slice(0,10).toUpperCase():"BUSY";
}

function renderRotaGrid(state){
  const holder=$("#rotaGrid");
  if(!holder) return;
  const workers=workingMembers(state);
  $("#rotaGridCircleLabel").textContent=activeSharedCircle(state)?.name||"Shared circle";

  if(!workers.length){
    holder.innerHTML=`<div class="soft-empty">No working members in this circle.</div>`;
    return;
  }

  const y=state.view.getUTCFullYear(),m=state.view.getUTCMonth();
  const count=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  let html=`<table class="rota-grid-table"><thead><tr><th class="rota-grid-date-head">Date</th>${workers.map(member=>`<th><button type="button" class="rota-grid-person-head" data-grid-person="${member.id}">${escapeHtml(member.name)}</button></th>`).join("")}</tr></thead><tbody>`;

  for(let d=1;d<=count;d++){
    const day=dateString(y,m,d);
    const dt=new Date(Date.UTC(y,m,d));
    const dow=new Intl.DateTimeFormat("en-GB",{weekday:"short",timeZone:"UTC"}).format(dt);
    html+=`<tr>
      <th class="rota-grid-date-cell"><button type="button" data-grid-day="${day}"><strong>${String(d).padStart(2,"0")}/${String(m+1).padStart(2,"0")}</strong><span>${dow}</span></button></th>
      ${workers.map(member=>{
        const entry=entryFor(state,member.id,day);
        const cls=rotaSemanticClass(entry);
        const label=compactRotaGridLabel(state,member,entry);
        const full=visibleEntryLabel(state,member,entry);
        return `<td class="${cls}"><button type="button" class="rota-grid-cell" data-grid-member="${member.id}" data-grid-day="${day}" title="${escapeAttr(full)}">${escapeHtml(label)}</button></td>`;
      }).join("")}
    </tr>`;
  }
  html+=`</tbody></table>`;
  holder.innerHTML=html;

  holder.querySelectorAll("[data-grid-person]").forEach(btn=>btn.addEventListener("click",()=>{
    state.calendarView=btn.dataset.gridPerson;
    state.calendarLayout="month";
    localStorage.setItem(calendarLayoutKey(state),"month");
    $("#calendarViewSelect").value=state.calendarView;
    renderRotaCalendar(state);
  }));

  holder.querySelectorAll("[data-grid-day]").forEach(btn=>btn.addEventListener("click",()=>{
    const day=btn.dataset.gridDay;
    const memberId=btn.dataset.gridMember;
    state.selectedDate=day;
    renderDayDetails(state);
    if(memberId){
      const member=state.members.find(x=>x.id===memberId);
      if(member&&canEditMember(state,member.id)) openScheduleDialog(state,member,day);
      else setTimeout(()=>$("#dayDetails")?.scrollIntoView({behavior:"smooth",block:"start"}),80);
    }else{
      setTimeout(()=>$("#dayDetails")?.scrollIntoView({behavior:"smooth",block:"start"}),80);
    }
  }));
}

function refreshAllScheduleViews(state){
  renderRotaCalendar(state);
  renderMeetupSuggestions(state);
  renderDashboard(state);
  renderDayDetails(state);
  renderCircleSwitchers(state);
}

function compareSelectionKey(state){
  return `odoCompare:${state.me?.group_id||"group"}:${state.me?.id||"member"}`;
}
function loadCalendarCompareSelection(state){
  let ids=[];
  try{ids=JSON.parse(localStorage.getItem(compareSelectionKey(state))||"[]");}catch{}
  const valid=new Set(workingMembers(state).map(m=>m.id));
  ids=ids.filter(id=>valid.has(id));
  if(!ids.length && workingMembers(state).some(m=>m.id===state.me.id)) ids=[state.me.id];
  return ids;
}
function selectedCompareMembers(state){
  const wanted=new Set(state.calendarCompareIds||[]);
  return workingMembers(state).filter(m=>wanted.has(m.id));
}
function saveCompareSelection(state){
  localStorage.setItem(compareSelectionKey(state),JSON.stringify(state.calendarCompareIds||[]));
}
function sharedDaySummary(state,memberId,day){
  const shared=state.availability?.find(x=>x.member_id===memberId&&x.day===day);
  if(!shared)return {label:"Availability unknown",className:"unknown"};
  if(shared.full_day_off)return {label:"Free all day",className:"free"};
  const free=shared.intervals.filter(x=>x.status==="free"&&x.end>480);
  if(free.length)return {label:free.map(x=>windowTimeLabel(Math.max(480,x.start),x.end)).join(" · "),className:"partial"};
  if(shared.intervals.some(x=>x.status==="unknown"))return {label:"Availability unknown",className:"unknown"};
  return {label:"Unavailable",className:"busy"};
}
function memberIsFullDayOff(state,member,day){
  const shared=state.availability?.find(x=>x.member_id===member.id&&x.day===day);
  if(shared)return shared.full_day_off===true;
  if(member.id!==state.me.id)return false;
  return confirmedFullDayOff(personAvailabilityInput(state,member.id,day));
}
function renderCalendarComparePicker(state){
  const panel=$("#calendarComparePanel");
  if(!panel)return;
  const compare=state.calendarLayout==="compare";
  panel.hidden=!compare;
  if(!compare)return;

  const picker=$("#calendarComparePeople");
  const members=circleWorkingMembers(state);
  state.calendarCompareIds=(state.calendarCompareIds||[]).filter(id=>members.some(m=>m.id===id));

  picker.innerHTML=members.map(member=>{
    const checked=state.calendarCompareIds.includes(member.id);
    return `<label class="compare-person-chip ${checked?"selected":""}">
      <input type="checkbox" data-compare-member="${member.id}" ${checked?"checked":""}>
      ${memberAvatarHtml(member,"tiny")}<span>${escapeHtml(member.name)}</span>
    </label>`;
  }).join("");

  picker.querySelectorAll("[data-compare-member]").forEach(input=>input.addEventListener("change",()=>{
    const id=input.dataset.compareMember;
    const next=new Set(state.calendarCompareIds||[]);
    if(input.checked)next.add(id);else next.delete(id);
    state.calendarCompareIds=[...next];
    saveCompareSelection(state);
    renderCalendarComparePicker(state);
    renderRotaCalendar(state);
  }));
}

function renderCalendarCompareSummary(state){}

function renderRotaCalendar(state) {
  const layout=state.calendarLayout||"month";
  renderCalendarLayoutTabs(state);
  renderCalendarSubviewTabs(state);

  const monthSurface=$("#calendarMonthSurface");
  const gridSurface=$("#rotaGridSurface");
  const viewField=$("#calendarViewField");
  const comparePanel=$("#calendarComparePanel");
  const subview=currentCalendarSubview(state);

  if(monthSurface)monthSurface.hidden=layout==="grid";
  if(gridSurface)gridSurface.hidden=layout!=="grid";
  if(viewField)viewField.hidden=false;
  if(viewField)viewField.querySelector("span").textContent=layout==="grid"?"Rota view":layout==="compare"?"Group overview":"Month view";
  if(comparePanel)comparePanel.hidden=layout!=="compare";

  const y=state.view.getUTCFullYear(),m=state.view.getUTCMonth();
  $("#monthTitle").textContent=new Intl.DateTimeFormat("en-GB",{month:"long",year:"numeric",timeZone:"UTC"}).format(state.view);

  if(layout==="grid"){
    if(comparePanel)comparePanel.hidden=true;
    $("#calendarHint").textContent="Department-style rota overview";
    renderRotaGrid(state);renderDayDetails(state);return;
  }

  const allWorkers=workingMembers(state);
  const compareView=layout==="compare";
  const groupView=!compareView&&state.calendarView==="group";
  const compareMembers=selectedCompareMembers(state);
  const workers=compareView?compareMembers:(groupView?circleWorkingMembers(state):allWorkers);
  const viewed=(groupView||compareView)?null:allWorkers.find(x=>x.id===state.calendarView);

  if(!groupView&&!compareView&&!viewed){state.calendarView="group";return renderRotaCalendar(state);}

  if(compareView){
    $("#calendarHint").textContent=compareMembers.length>=2
      ? `${subview==="daysOff"?"Days Off":"Magic Hour"} · comparing ${compareMembers.map(x=>x.name).join(", ")}`
      : "Select at least 2 people below";
  }else if(groupView){
    $("#calendarHint").textContent=subview==="daysOff"
      ? `Days Off · ${activeSharedCircle(state)?.name||"Shared circle"}`
      : `Magic Hour heatmap · ${activeSharedCircle(state)?.name||"Shared circle"}: brighter days have stronger overlap`;
  }else{
    $("#calendarHint").textContent=`${viewed.name} — ${canEditMember(state,viewed.id)?"tap a date to edit":"tap a date to inspect"}`;
  }

  renderCalendarComparePicker(state);

  const cal=$("#calendar");cal.innerHTML="";
  const first=new Date(Date.UTC(y,m,1));
  const pad=(first.getUTCDay()+6)%7;
  for(let i=0;i<pad;i++)cal.appendChild(document.createElement("div"));
  const count=new Date(Date.UTC(y,m+1,0)).getUTCDate();

  for(let d=1;d<=count;d++){
    const day=dateString(y,m,d);
    const btn=document.createElement("button");btn.type="button";btn.className="day rota-day";
    if(state.selectedDate===day)btn.classList.add("selected");

    if(compareView){
      const enough=compareMembers.length>=2;
      if(!enough){
        btn.classList.add("compare-calendar-day");
        btn.innerHTML=`<span class="n">${d}</span><span class="no-free-label">Select people</span>`;
      }else if(subview==="daysOff"){
        const off=offMembersForDay(state,compareMembers,day),allOff=off.length===compareMembers.length;
        btn.classList.add("compare-calendar-day","days-off-calendar-day");
        if(allOff)btn.classList.add("days-off-all");else if(off.length)btn.classList.add("days-off-some");
        btn.innerHTML=`<span class="n">${d}</span>${off.length?`<span class="off-count">${off.length}/${compareMembers.length} off</span>${allMemberAvatars(off,"tiny")}`:`<span class="no-free-label">—</span>`}`;
        btn.setAttribute("aria-label",`${prettyDate(day)}. ${off.length?`${off.length} of ${compareMembers.length} selected people are off: ${off.map(m=>m.name).join(", ")}`:"No selected person confirmed off all day."}`);
      }else{
        const best=bestMagicWindowForDay(state,compareMembers,day);
        btn.classList.add("compare-calendar-day",magicStrengthClass(best));
        if(best?.allFree)btn.classList.add("compare-all-off");
        btn.innerHTML=`<span class="n">${d}</span>${best?`<span class="magic-calendar-score">${best.free}/${best.total}</span><span class="compare-time-badge">${best.name==="Breakfast"?"🍳":"🍽"} ${escapeHtml(best.time)}</span>${magicMemberAvatars(best,"tiny")}`:`<span class="no-free-label">—</span>`}`;
      }
    }else if(groupView){
      if(subview==="daysOff"){
        const off=offMembersForDay(state,workers,day),allOff=workers.length>0&&off.length===workers.length;
        btn.classList.add("simple-free-day","days-off-calendar-day");
        if(allOff)btn.classList.add("days-off-all");else if(off.length)btn.classList.add("days-off-some");
        btn.innerHTML=`<span class="n">${d}</span>${off.length?`<span class="off-count">${off.length}/${workers.length} off</span>${allMemberAvatars(off,"tiny")}`:`<span class="no-free-label">—</span>`}`;
        btn.setAttribute("aria-label",`${prettyDate(day)}. ${off.length?`${off.length} off: ${off.map(m=>m.name).join(", ")}`:"No one confirmed off all day."}`);
      }else{
        const best=bestMagicWindowForDay(state,workers,day);
        btn.classList.add("simple-free-day",magicStrengthClass(best));
        btn.innerHTML=`<span class="n">${d}</span>${best?`<span class="magic-calendar-score">${best.free}/${best.total}</span><span class="magic-calendar-time">${best.name==="Breakfast"?"🍳":"🍽"} ${escapeHtml(best.time)}</span>${magicMemberAvatars(best,"tiny")}`:`<span class="no-free-label">—</span>`}`;
        btn.setAttribute("aria-label",best?`${prettyDate(day)}. ${magicWindowLabel(best)}. Free: ${best.freeMembers.map(m=>m.name).join(", ")}`:`${prettyDate(day)}. No useful confirmed overlap.`);
      }
    }else{
      const entry=entryFor(state,viewed.id,day);applyPersonDayAppearance(btn,entry);
      btn.innerHTML=`<span class="n">${d}</span><span class="person-day-value">${escapeHtml(visibleEntryLabel(state,viewed,entry))}</span>${canShowEntryNote(state,viewed)&&entry?.note?`<span class="note-mark">●</span>`:""}`;
    }

    const dayEvents=eventsForDay(state,day);
    if(dayEvents.length){btn.classList.add("has-group-event");const eventTag=document.createElement("span");eventTag.className="event-mini";eventTag.textContent=`${eventIcon(dayEvents[0]?.category)} ${dayEvents.length===1?"PLAN":`${dayEvents.length} PLANS`}`;btn.appendChild(eventTag);}

    btn.addEventListener("click",()=>{state.selectedDate=day;renderDayDetails(state);if(!groupView&&!compareView&&canEditMember(state,viewed.id))openScheduleDialog(state,viewed,day);else renderRotaCalendar(state);});
    cal.appendChild(btn);
  }
  renderDayDetails(state);
}

function applyPersonDayAppearance(btn, entry) {
  if (!entry) btn.classList.add("rota-unknown");
  else btn.classList.add(entry.entry_type==="off"?"rota-off":entry.entry_type==="shift"?"rota-shift":entry.entry_type==="busy"?"rota-busy":"rota-partial");
}

function personEntryLabel(entry) {
  if (!entry) return "—";
  if (entry.entry_type==="off") return "OFF";
  if (entry.entry_type==="shift") return entry.raw_value || `${minutesToInputTime(entry.shift_start_min)}-${minutesToInputTime(entry.shift_end_min)}`;
  if (entry.entry_type==="busy") return entry.raw_value || "BUSY";
  return entry.raw_value || "PARTIAL";
}

function memberScheduleVisibility(state,member){
  if(!member) return "shifts";
  if(member.id===state.me.id) return "details";
  return member.schedule_visibility||"shifts";
}
function visibleEntryLabel(state,member,entry){
  if(!entry) return "—";
  const mode=memberScheduleVisibility(state,member);
  if(mode==="freebusy") return sharedDaySummary(state,member.id,entry.day).label;
  if(mode==="shifts"){
    if(entry.entry_type==="off") return "OFF";
    if(entry.entry_type==="shift") return Number.isInteger(entry.shift_start_min)&&Number.isInteger(entry.shift_end_min)
      ? `${minutesToInputTime(entry.shift_start_min)}-${minutesToInputTime(entry.shift_end_min)}`
      : "WORKING";
    return "BUSY";
  }
  return personEntryLabel(entry);
}
function canShowEntryNote(state,member){
  return member?.id===state.me.id || memberScheduleVisibility(state,member)==="details";
}
function visibleDayReason(state,member,day){
  if(memberScheduleVisibility(state,member)==="freebusy")return sharedDaySummary(state,member.id,day).label;
  const postNight=personPostNightLabel(state,member.id,day);
  if(postNight) return postNight;
  if(member?.id===state.me.id || memberScheduleVisibility(state,member)==="details") return personDayReason(state,member.id,day);
  const entry=entryFor(state,member.id,day);
  if(!entry) return "Schedule not entered";
  if(entry.entry_type==="off") return "Free all day";
  return "Busy / working";
}

function renderDayDetails(state) {
  const label=$("#selectedLabel"), holder=$("#dayDetails");
  if (!state.selectedDate) {
    label.textContent="Tap a date on the calendar.";
    holder.innerHTML="";
    return;
  }

  label.textContent=prettyDate(state.selectedDate);
  const workers=state.calendarLayout==="compare"
    ? selectedCompareMembers(state)
    : state.calendarView==="group"
      ? circleWorkingMembers(state)
      : workingMembers(state);
  const dayEvents=eventsForDay(state,state.selectedDate);
  const dayBest=workers.length>=2?bestMagicWindowForDay(state,workers,state.selectedDate):null;

  holder.innerHTML=`
    ${dayBest?`
      <div class="day-magic-summary ${magicStrengthClass(dayBest)}">
        <div class="day-magic-copy">
          <p class="eyebrow">Best overlap</p>
          <strong>${escapeHtml(dayBest.name)} · ${escapeHtml(dayBest.time)}</strong>
          <span>${dayBest.free}/${dayBest.total} free · ${Math.round(dayBest.duration/60*10)/10}h</span>
        </div>
        ${magicMemberAvatars(dayBest,"sm")}
      </div>`:""}

    ${dayEvents.length ? `
      <div class="day-events-section">
        <div class="row-wrap between">
          <strong>Events</strong>
          <button class="btn btn-small" type="button" id="addEventForDay">+ Add event</button>
        </div>
        <div class="events-list compact-events">
          ${dayEvents.map(event => eventCardHtml(state,event,true)).join("")}
        </div>
      </div>` : `
      <div class="row-wrap day-add-event-row">
        <button class="btn btn-small" type="button" id="addEventForDay">+ Add event on this date</button>
      </div>`}

    <div class="day-status-legend">
      <span><i class="day-key key-off-green"></i>OFF</span>
      <span><i class="day-key key-day-blue"></i>Day</span>
      <span><i class="day-key key-late-teal"></i>Late</span>
      <span><i class="day-key key-night-purple"></i>Night</span>
      <span><i class="day-key key-postnight"></i>Post night</span>
      <span><i class="day-key key-leave-violet"></i>Leave</span>
      <span><i class="day-key key-development-amber"></i>Study / Dev</span>
      <span><i class="day-key key-busy-orange"></i>Busy</span>
    </div>

    <div class="day-detail-list">
      ${workers.map(member=>{
        const entry=entryFor(state,member.id,state.selectedDate);
        const b=personMealStatus(state,member.id,state.selectedDate,540);
        const l=personMealStatus(state,member.id,state.selectedDate,840);
        const d=personMealStatus(state,member.id,state.selectedDate,1200);
        const canEdit=canEditMember(state,member.id);
        const semantic=dayDetailSemanticClass(state,member,state.selectedDate,entry);
        const statusLabel=dayDetailStatusLabel(state,member,state.selectedDate,entry);
        return `<div class="day-person-row ${semantic}">
          <div class="row-wrap between">
            <div class="member-identity">
              ${memberAvatarHtml(member,"sm")}
              <div>
                <div class="day-person-name-line">
                  <strong>${escapeHtml(member.name)}</strong>
                  <span class="day-status-chip">${escapeHtml(statusLabel)}</span>
                </div>
                <div class="rota-value">${escapeHtml(visibleEntryLabel(state,member,entry))}</div>
              </div>
            </div>
            <div class="row-wrap">
              ${canEdit ? `<button class="btn btn-small" type="button" data-availability-member="${member.id}">Availability</button>` : ""}
              ${canEdit ? `<button class="btn btn-small" type="button" data-edit-member="${member.id}">Edit rota</button>` : ""}
            </div>
          </div>
          <div class="meal-badges">
            ${mealBadgeWithOverride(state,member.id,state.selectedDate,"breakfast","Breakfast",b)}
            ${mealBadgeWithOverride(state,member.id,state.selectedDate,"lunch","Lunch",l)}
            ${mealBadgeWithOverride(state,member.id,state.selectedDate,"dinner","Dinner",d)}
          </div>
          ${visibleDayReason(state,member,state.selectedDate)?`<div class="availability-reason">${escapeHtml(visibleDayReason(state,member,state.selectedDate))}</div>`:""}
          ${canShowEntryNote(state,member)&&entry?.note?`<div class="person-note">“${escapeHtml(entry.note)}”</div>`:""}
          ${entry?.source==="pdf"?`<div class="source-tag">PDF${entry.import_file_name?` · ${escapeHtml(entry.import_file_name)}`:""}</div>`:""}
        </div>`;
      }).join("")}
    </div>`;

  $("#addEventForDay")?.addEventListener("click",()=>openEventDialog(state,null,state.selectedDate));

  wireEventCardActions(state, holder);

  holder.querySelectorAll("[data-edit-member]").forEach(btn=>btn.addEventListener("click",()=>{
    const member=workers.find(x=>x.id===btn.dataset.editMember);
    if(member) openScheduleDialog(state,member,state.selectedDate);
  }));

  holder.querySelectorAll("[data-availability-member]").forEach(btn=>btn.addEventListener("click",()=>{
    const member=workers.find(x=>x.id===btn.dataset.availabilityMember);
    if(member) openAvailabilityOverrideDialog(state,member,state.selectedDate);
  }));
}

function defaultSocialPrefs(){
  return {commuteBefore:0,commuteAfter:0,postNightUntil:960,minWindow:60,preferredPeriod:"any"};
}
function loadLocalSocialPrefs(){
  const d=defaultSocialPrefs();
  try{
    const raw=JSON.parse(localStorage.getItem("odoSocialPrefs")||"{}");
    return {
      commuteBefore:[0,30,45,60].includes(Number(raw.commuteBefore))?Number(raw.commuteBefore):d.commuteBefore,
      commuteAfter:[0,30,45,60].includes(Number(raw.commuteAfter))?Number(raw.commuteAfter):d.commuteAfter,
      postNightUntil:Number.isInteger(Number(raw.postNightUntil))?Math.max(0,Math.min(1439,Number(raw.postNightUntil))):d.postNightUntil,
      minWindow:[45,60,90,120].includes(Number(raw.minWindow))?Number(raw.minWindow):d.minWindow,
      preferredPeriod:["any","breakfast","dinner"].includes(raw.preferredPeriod)?raw.preferredPeriod:d.preferredPeriod
    };
  }catch{return d;}
}
function saveLocalSocialPrefs(state){
  localStorage.setItem("odoSocialPrefs",JSON.stringify(state.socialPrefs||defaultSocialPrefs()));
}
function memberMatchingPrefs(state,memberId){
  // Personal buffers are private and applied to the current user's own schedule.
  // Universal post-night recovery applies to everyone unless they explicitly edit their own device preferences.
  const base=defaultSocialPrefs();
  if(memberId===state.me.id) return {...base,...(state.socialPrefs||{})};
  return base;
}
function periodForMinute(min){return min<960?"Breakfast":"Dinner";}
function periodWindow(name){return name==="Breakfast"?[480,960]:[960,1440];}
function windowTimeLabel(startMin,endMin){return `${minutesToInputTime(startMin)}–${endMin===1440?"24:00":minutesToInputTime(endMin)}`;}
function socialMealOverride(state,memberId,day,minute){
  const key=minute<960?"breakfast":"dinner";
  return mealOverrideFor(state,memberId,day,key);
}
function personAvailabilityInput(state,memberId,day){
  return {current:entryFor(state,memberId,day),previous:entryFor(state,memberId,addDaysString(day,-1)),next:entryFor(state,memberId,addDaysString(day,1)),preferences:memberMatchingPrefs(state,memberId),overrides:state.mealOverrides.filter(x=>x.member_id===memberId&&x.day===day)};
}
function personSocialStatusAt(state,member,day,minute){
  const shared=state.availability?.find(x=>x.member_id===member.id&&x.day===day);
  if(shared)return shared.intervals.find(x=>minute>=x.start&&minute<x.end)?.status||"unknown";
  if(member.id!==state.me.id)return "unknown";
  return availabilityAt(personAvailabilityInput(state,member.id,day),minute);
}
function personPostNightLabel(state,memberId,day){
  const prev=entryFor(state,memberId,addDaysString(day,-1));
  if(prev?.entry_type==="shift"&&isOvernightShift(prev)) return "Post night";
  return "";
}
function magicBoundariesForDay(state,members,day){
  const points=new Set([480,960,1440]);
  for(const member of members){
    const shared=state.availability?.find(x=>x.member_id===member.id&&x.day===day);
    const boundaries=shared?shared.intervals.flatMap(x=>[x.start,x.end]):member.id===state.me.id?availabilityBoundaries(personAvailabilityInput(state,member.id,day)):[];
    boundaries.forEach(x=>{if(x>=480&&x<=1440)points.add(x);});
  }
  return [...points].sort((a,b)=>a-b);
}
function magicWindowsForDay(state,members,day){
  if(!members.length) return [];
  const points=magicBoundariesForDay(state,members,day);
  const pieces=[];
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  const now=new Date();const nowMin=now.getHours()*60+now.getMinutes();

  for(let i=0;i<points.length-1;i++){
    let start=points[i],end=points[i+1];
    if(end<=start)continue;
    if(day===today){
      if(end<=nowMin)continue;
      start=Math.max(start,nowMin);
      if(end-start<1)continue;
    }
    const mid=Math.floor((start+end)/2);
    const free=[],busy=[],unknown=[];
    for(const member of members){
      const status=personSocialStatusAt(state,member,day,mid);
      if(status==="free")free.push(member);else if(status==="busy")busy.push(member);else unknown.push(member);
    }
    const name=periodForMinute(mid);
    const keyFree=free.map(x=>x.id).sort().join(",");
    const keyUnknown=unknown.map(x=>x.id).sort().join(",");
    const prev=pieces.at(-1);
    if(prev&&prev.endMin===start&&prev.name===name&&prev._freeKey===keyFree&&prev._unknownKey===keyUnknown){
      prev.endMin=end;prev.duration=prev.endMin-prev.startMin;prev.time=windowTimeLabel(prev.startMin,prev.endMin);continue;
    }
    pieces.push({
      day,name,period:name.toLowerCase(),startMin:start,endMin:end,minute:start,time:windowTimeLabel(start,end),
      duration:end-start,free:free.length,busy:busy.length,unknown:unknown.length,known:free.length+busy.length,total:members.length,
      freeMembers:free,busyMembers:busy,unknownMembers:unknown,_freeKey:keyFree,_unknownKey:keyUnknown,
      order:name==="Breakfast"?0:1
    });
  }

  const min=Math.max(30,Number(state.socialPrefs?.minWindow||60));
  return pieces.filter(x=>x.duration>=min&&x.free>0).map(x=>{
    const allFree=x.unknown===0&&x.free===x.total;
    const ratio=x.total?x.free/x.total:0;
    const pref=state.socialPrefs?.preferredPeriod||"any";
    const preferenceBonus=pref==="any"||pref===x.period?0.08:0;
    return {...x,allFree,ratio,closeEnough:!allFree&&x.free>=Math.max(2,Math.ceil(x.total*.6)),
      score:(ratio*100)+(Math.min(x.duration,300)/30)+preferenceBonus*100-(x.unknown*4)};
  });
}
function buildMagicHourCandidatesForMembers(state,members,daysAhead=14){
  if(!members.length)return [];
  const start=todayUtc(),arr=[];
  for(let i=0;i<daysAhead;i++){
    const dt=new Date(start.getTime()+i*86400000);
    const day=dateString(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate());
    arr.push(...magicWindowsForDay(state,members,day));
  }
  return arr.sort((a,b)=>b.score-a.score||b.free-a.free||b.duration-a.duration||a.day.localeCompare(b.day)||a.startMin-b.startMin);
}
function bestMagicWindowForDay(state,members,day){
  return magicWindowsForDay(state,members,day).sort((a,b)=>b.score-a.score||b.free-a.free||b.duration-a.duration)[0]||null;
}
function magicStrengthClass(window){
  if(!window)return "magic-none";
  if(window.allFree)return "magic-all";
  if(window.ratio>=.8)return "magic-strong";
  if(window.ratio>=.6)return "magic-medium";
  return "magic-low";
}

function magicMemberAvatars(window,size="tiny"){
  if(!window?.freeMembers?.length) return "";
  const names=window.freeMembers.map(m=>m.name).join(", ");
  return `<span class="magic-member-avatars" aria-label="${escapeAttr(`Free: ${names}`)}">${window.freeMembers.map(m=>memberAvatarHtml(m,size)).join("")}</span>`;
}

function dayDetailSemanticClass(state,member,day,entry){
  const previous=entryFor(state,member.id,addDaysString(day,-1));
  const isPostNight=previous?.entry_type==="shift"&&isOvernightShift(previous);
  if(isPostNight && entry?.entry_type!=="shift") return "day-semantic-postnight";

  const cls=rotaSemanticClass(entry);
  if(cls==="grid-off") return "day-semantic-off";
  if(cls==="grid-day") return "day-semantic-day";
  if(cls==="grid-late") return "day-semantic-late";
  if(cls==="grid-night") return "day-semantic-night";
  if(cls==="grid-leave") return "day-semantic-leave";
  if(cls==="grid-development") return "day-semantic-development";
  if(cls==="grid-busy") return "day-semantic-busy";
  return "day-semantic-unknown";
}

function dayDetailStatusLabel(state,member,day,entry){
  if(memberScheduleVisibility(state,member)==="freebusy")return sharedDaySummary(state,member.id,day).label;
  const previous=entryFor(state,member.id,addDaysString(day,-1));
  const isPostNight=previous?.entry_type==="shift"&&isOvernightShift(previous);
  if(isPostNight && entry?.entry_type!=="shift") return "Post night";

  if(!entry) return "Unknown";
  const raw=String(entry.raw_value||entry.note||"").trim().toUpperCase();

  if(/\b(ANNUAL\s*LEAVE|A\/L|AL|ANNUAL|LEAVE)\b/.test(raw)) return "Annual leave";
  if(/\b(EDT|STUDY|DEVELOPMENT|DEVELOP|SDT|SPA|TEACHING)\b/.test(raw)) return "Study / development";
  if(entry.entry_type==="off") return "OFF";

  if(entry.entry_type==="shift"){
    const start=entry.shift_start_min,end=entry.shift_end_min;
    const overnight=Number.isInteger(start)&&Number.isInteger(end)&&(end<=start||start>=19*60);
    if(overnight) return "Night";
    if(Number.isInteger(start)&&start>=12*60) return "Late / back";
    return "Day shift";
  }
  if(entry.entry_type==="busy") return "Busy / training";
  return "Unknown";
}

function magicWindowLabel(window){
  if(!window)return "No useful overlap";
  return `${window.name} · ${window.time} · ${window.free}/${window.total} free`;
}
function renderSocialPreferences(state){
  if(!$("#socialPreferences"))return;
  if(!$("#syncPreferencesNotice"))$("#socialPreferences").insertAdjacentHTML("beforeend",'<div id="syncPreferencesNotice" class="notice"><p>Review your saved device preferences, then save once to apply them across devices. Until then, shared availability uses default travel and recovery settings.</p><button class="btn" id="syncPreferencesNow" type="button">Save these preferences</button></div>');
  $("#syncPreferencesNotice").hidden=state.preferencesSynced===true;
  $("#syncPreferencesNow").onclick=()=>$("#socialCommuteBefore").dispatchEvent(new Event("change"));
  const p=state.socialPrefs||defaultSocialPrefs();
  $("#socialCommuteBefore").value=String(p.commuteBefore||0);
  $("#socialCommuteAfter").value=String(p.commuteAfter||0);
  $("#socialPostNightUntil").value=minutesToInputTime(p.postNightUntil||960);
  $("#socialMinWindow").value=String(p.minWindow||60);
  $("#socialPreferredPeriod").value=p.preferredPeriod||"any";
}
function wireSocialPreferences(state){
  const ids=["socialCommuteBefore","socialCommuteAfter","socialPostNightUntil","socialMinWindow","socialPreferredPeriod"];
  ids.forEach(id=>$("#"+id)?.addEventListener("change",async()=>{
    const prefs=normalizePreferences({commuteBefore:Number($("#socialCommuteBefore").value),commuteAfter:Number($("#socialCommuteAfter").value),postNightUntil:timeToMinutes($("#socialPostNightUntil").value),minWindow:Number($("#socialMinWindow").value),preferredPeriod:$("#socialPreferredPeriod").value});
    ids.forEach(key=>$("#"+key).disabled=true);
    try{
      const {error}=await state.supabase.rpc("save_my_preferences_v14",{p_preferences:prefs});
      if(error)throw error;
      state.socialPrefs=prefs;saveLocalSocialPrefs(state);await refreshAvailability(state);
      refreshAllScheduleViews(state);renderSocialPreferences(state);state.setStatus?.("Availability preferences saved across devices ✓");
    }catch(error){renderSocialPreferences(state);state.setStatus?.(error.message,true);}
    finally{ids.forEach(key=>$("#"+key).disabled=false);}
  }));
}
function renderMeetRangeTabs(state){
  document.querySelectorAll("#meetRangeTabs [data-meet-range]").forEach(btn=>btn.classList.toggle("active",Number(btn.dataset.meetRange)===Number(state.meetRangeDays)));
}
function wireMeetRangeTabs(state){
  document.querySelectorAll("#meetRangeTabs [data-meet-range]").forEach(btn=>btn.addEventListener("click",()=>{
    state.meetRangeDays=Number(btn.dataset.meetRange);
    localStorage.setItem("odoMeetRangeDays",String(state.meetRangeDays));
    renderMeetupSuggestions(state);
  }));
  renderMeetRangeTabs(state);
}

function mealBadge(name,status) {
  return `<span class="meal-badge ${status}">${name} ${name==="Breakfast"?"09:00":name==="Lunch"?"14:00":"20:00"} · ${status==="free"?"Free":status==="busy"?"Busy":"Unknown"}</span>`;
}

function mealBadgeWithOverride(state,memberId,day,mealKey,name,status) {
  const override=mealOverrideFor(state,memberId,day,mealKey);
  const time=name==="Breakfast"?"09:00":name==="Lunch"?"14:00":"20:00";
  const overrideText=override ? ` · Override: ${override.status==="available"?"available":"unavailable"}` : "";
  const title=override?.note ? ` title="${escapeAttr(override.note)}"` : "";
  return `<span class="meal-badge ${status} ${override?"has-override":""}"${title}>${name} ${time} · ${status==="free"?"Free":status==="busy"?"Busy":"Unknown"}${overrideText}</span>`;
}
function buildMeetupCandidates(state,daysAhead=60){
  return buildMagicHourCandidatesForMembers(state,circleWorkingMembers(state),daysAhead);
}

function wireMeetupFilters(state) {
  const holder=$("#meetupFilters");
  if(!holder) return;

  holder.querySelectorAll("[data-meetup-filter]").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.meetupFilter===state.meetupFilter);
    btn.addEventListener("click",()=>{
      state.meetupFilter=btn.dataset.meetupFilter;
      holder.querySelectorAll("[data-meetup-filter]").forEach(x=>x.classList.toggle("active",x===btn));
      renderMeetupSuggestions(state);
    });
  });
}

function nextWeekendDates() {
  const today=todayUtc();
  let saturday=new Date(today);
  while(saturday.getUTCDay()!==6) saturday=new Date(saturday.getTime()+86400000);
  const sunday=new Date(saturday.getTime()+86400000);
  return new Set([
    dateString(saturday.getUTCFullYear(),saturday.getUTCMonth(),saturday.getUTCDate()),
    dateString(sunday.getUTCFullYear(),sunday.getUTCMonth(),sunday.getUTCDate())
  ]);
}

function filterMeetupCandidates(state,arr) {
  if(state.meetupFilter==="dinner") return arr.filter(x=>x.name==="Dinner");

  if(state.meetupFilter==="saturday") {
    return arr.filter(x=>{
      const p=parseDate(x.day);
      return new Date(Date.UTC(p.y,p.m,p.d)).getUTCDay()===6;
    });
  }

  if(state.meetupFilter==="nextweekend") {
    const dates=nextWeekendDates();
    return arr.filter(x=>dates.has(x.day));
  }

  return arr;
}

function groupMeetupCandidatesByDay(items){
  const map=new Map();
  for(const x of items){
    if(!map.has(x.day))map.set(x.day,{day:x.day,breakfast:null,dinner:null,total:x.total});
    const g=map.get(x.day);const key=x.name==="Breakfast"?"breakfast":"dinner";
    const current=g[key];
    if(!current||x.score>current.score||x.free>current.free||x.duration>current.duration)g[key]=x;
  }
  return [...map.values()].map(g=>{
    const choices=[g.breakfast,g.dinner].filter(Boolean);
    const best=choices.slice().sort((a,b)=>b.score-a.score||b.free-a.free||b.duration-a.duration)[0]||null;
    return {...g,best,bestFree:best?.free||0,bestUnknown:best?.unknown??999,combinedFree:choices.reduce((s,x)=>s+x.free,0)};
  });
}

function renderMeetupSuggestions(state){
  const holder=$("#meetupSuggestions");if(!holder)return;
  const members=circleWorkingMembers(state);renderMeetRangeTabs(state);
  const preview=$("#weeklyPreviewCard");if(preview){preview.hidden=true;preview.innerHTML="";}
  if(members.length<2){holder.innerHTML='<div class="meet-empty-explainer"><strong>Meet needs at least two working members.</strong><span>Invite someone or check your circle’s member roles.</span></div>';renderGroupPolls(state);return;}
  const range=Number(state.meetRangeDays||14),all=buildMagicHourCandidatesForMembers(state,members,range);
  const useful=all.filter(x=>x.free>=Math.max(2,Math.ceil(x.total*.6)));
  const mode=state.meetResultMode||"all";
  const filtered=useful.filter(x=>mode==="all"||(mode==="everyone"?x.allFree:!x.allFree));
  const count=state.meetVisibleCount||6,shown=filtered.slice(0,count);
  holder.innerHTML=
    '<div class="meet-result-filters" aria-label="Availability filter">'+[['all','Top opportunities'],['everyone','Everyone free'],['close','Close enough']].map(([key,label])=>'<button class="btn btn-small" type="button" data-result-mode="'+key+'" aria-pressed="'+(mode===key)+'">'+label+'</button>').join('')+'</div>'+
    (state.availabilityError?'<div class="availability-warning" role="alert">Shared availability could not be refreshed. Reconnect and refresh before making plans.</div>':'')+
    (shown.length?shown.map(x=>'<article class="opportunity-row '+magicStrengthClass(x)+'"><div class="row-wrap between"><strong>'+escapeHtml(shortDashboardDate(x.day))+'</strong><span class="opportunity-count">'+x.free+'/'+x.total+' free</span></div><h3>'+escapeHtml(x.name+' · '+x.time)+'</h3><div class="row-wrap between">'+magicMemberAvatars(x,'tiny')+'<small>'+Math.round(x.duration/60*10)/10+'h'+(x.unknown?' · '+x.unknown+' unknown':'')+'</small></div><div class="row-wrap"><button class="btn btn-primary btn-small" type="button" data-create-meetup-event="'+x.day+'" data-meal="'+x.name+'" data-start-min="'+x.startMin+'" data-end-min="'+x.endMin+'">Make a plan</button><button class="btn btn-small" type="button" data-ask-date="'+x.day+'">Ask the group</button></div></article>').join(''):
    '<div class="meet-empty-explainer"><strong>No matching window in the next '+range+' days.</strong><span>Try another filter or a longer range. Missing rota stays unknown; viewers are excluded.</span></div>')+
    (filtered.length>shown.length?'<button class="btn" type="button" id="moreMeetResults">Show more opportunities</button>':'');
  holder.querySelectorAll('[data-result-mode]').forEach(button=>button.onclick=()=>{state.meetResultMode=button.dataset.resultMode;state.meetVisibleCount=6;renderMeetupSuggestions(state);});
  $("#moreMeetResults")?.addEventListener('click',()=>{state.meetVisibleCount=count+6;renderMeetupSuggestions(state);});
  holder.querySelectorAll('[data-create-meetup-event]').forEach(button=>button.onclick=()=>openEventDialogFromMeetup(state,{day:button.dataset.createMeetupEvent,name:button.dataset.meal,startMin:Number(button.dataset.startMin),endMin:Number(button.dataset.endMin)}));
  holder.querySelectorAll('[data-ask-date]').forEach(button=>button.onclick=async()=>{const group=groupMeetupCandidatesByDay(useful).find(x=>x.day===button.dataset.askDate);if(group)await createPollFromMeetupDate(state,group,all);});
  renderGroupPolls(state);
}

function meetupMealRowHtml(x){
  if(!x)return "";
  const allFree=x.allFree;
  const label=allFree?"Everyone free":x.closeEnough?"Close enough":"Possible";
  return `<div class="date-meal-row ${allFree?"all-free":""} ${magicStrengthClass(x)}">
    <div class="date-meal-head">
      <div class="meal-title-wrap">
        <span class="meal-icon" aria-hidden="true">${x.name==="Breakfast"?"🍳":"🍽"}</span>
        <div><strong>${escapeHtml(x.name)}</strong><small>${escapeHtml(x.time)} · ${Math.round(x.duration/60*10)/10}h</small></div>
      </div>
      <div class="meal-count"><strong>${x.free}/${x.total} free</strong><small>${escapeHtml(label)}${x.unknown?` · ${x.unknown} unknown`:""}</small></div>
    </div>
    <div class="meal-free-people">
      ${x.freeMembers.length?x.freeMembers.map(m=>`<span class="free-name-chip compact">${memberAvatarHtml(m,"tiny")}<span>${escapeHtml(m.name)}</span></span>`).join(""):`<span class="subtle">No one confirmed free</span>`}
    </div>
    ${x.busyMembers.length&&x.total<=8?`<div class="subtle meetup-unavailable">Not free: ${escapeHtml(x.busyMembers.map(m=>m.name).join(", "))}</div>`:""}
    <button class="btn btn-small meal-plan-btn" type="button" data-create-meetup-event="${x.day}" data-meal="${x.name}" data-start-min="${x.startMin}" data-end-min="${x.endMin}">
      Make a plan · ${escapeHtml(x.time)}
    </button>
  </div>`;
}

function meetupDateCardHtml(state,group){
  const choices=[group.breakfast,group.dinner].filter(Boolean);
  const best=group.best;
  const bestLabel=best?`${best.allFree?"Everyone":"Best"} · ${best.free}/${best.total} · ${best.time}`:"No useful window";
  const canAsk=choices.length>1||choices.some(x=>x.closeEnough&&!x.allFree);
  return `<article class="meet-date-card ${best?magicStrengthClass(best):""}">
    <button class="meet-date-card-head" type="button" data-meetup-day="${group.day}">
      <div><strong>${escapeHtml(shortDashboardDate(group.day))}</strong><small>Real shared availability</small></div>
      <span class="best-meal-badge">${escapeHtml(bestLabel)}</span>
    </button>
    <div class="date-meals-grid">${meetupMealRowHtml(group.breakfast)}${meetupMealRowHtml(group.dinner)}</div>
    ${canAsk?`<div class="date-card-footer"><button class="btn btn-small" type="button" data-ask-date="${group.day}">Ask group which time</button></div>`:""}
  </article>`;
}

function inputTimeToMinutes(value){const parts=String(value||"").split(":");if(parts.length!==2)return null;const h=Number(parts[0]),m=Number(parts[1]);if(!Number.isInteger(h)||!Number.isInteger(m)||h<0||h>23||m<0||m>59)return null;return h*60+m;}
function defaultPollDay(offset=1){const d=todayUtc();d.setUTCDate(d.getUTCDate()+offset);return dateString(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());}
function pollDraftRowHtml(i,day="",time="",label=""){return `<div class="poll-draft-row" data-poll-draft-row><input class="input" type="date" name="pollDay" value="${escapeAttr(day)}" required><input class="input" type="time" name="pollTime" value="${escapeAttr(time)}"><input class="input" name="pollLabel" maxlength="80" value="${escapeAttr(label)}" placeholder="Optional label"><button class="btn btn-tiny btn-danger" data-remove-poll-draft type="button">×</button></div>`;}
function renderPollDraftRows(rows){const holder=$("#pollDraftOptions");if(!holder)return;holder.innerHTML=rows.map((r,i)=>pollDraftRowHtml(i,r.day,r.time,r.label)).join("");holder.querySelectorAll("[data-remove-poll-draft]").forEach(btn=>btn.addEventListener("click",()=>{if(holder.querySelectorAll("[data-poll-draft-row]").length<=2)return;btn.closest("[data-poll-draft-row]").remove();}));}
function openPollDialog(state){
  if(!state.activeSharedCircleId)return state.setStatus?.("Join or create a circle first.",true);const dialog=$("#pollDialog");if(!dialog)return;$("#pollTitle").value="When should we meet?";$("#pollCircle").value=state.activeSharedCircleId;$("#pollChoiceMode").value="availability";renderPollDraftRows([{day:defaultPollDay(1),time:"",label:""},{day:defaultPollDay(2),time:"",label:""}]);setMsg($("#pollCreateMsg"),"");dialog.showModal();
}
function wirePollCreator(state){
  const dialog=$("#pollDialog"),form=$("#pollForm");if(!dialog||!form)return;
  $("#cancelPoll")?.addEventListener("click",()=>dialog.close());
  $("#addPollDraftOption")?.addEventListener("click",()=>{const holder=$("#pollDraftOptions");if(holder.querySelectorAll("[data-poll-draft-row]").length>=8)return setMsg($("#pollCreateMsg"),"Maximum 8 options.",true);holder.insertAdjacentHTML("beforeend",pollDraftRowHtml(holder.children.length,defaultPollDay(holder.children.length+1),"",""));const last=holder.lastElementChild;last.querySelector("[data-remove-poll-draft]").addEventListener("click",()=>last.remove());});
  form.addEventListener("submit",async e=>{e.preventDefault();const rows=[...$("#pollDraftOptions").querySelectorAll("[data-poll-draft-row]")];if(rows.length<2)return setMsg($("#pollCreateMsg"),"Add at least 2 options.",true);const options=rows.map(row=>{const day=row.querySelector('[name="pollDay"]').value;const time=row.querySelector('[name="pollTime"]').value;const label=row.querySelector('[name="pollLabel"]').value.trim();return {day,start_min:time?inputTimeToMinutes(time):null,label:label||null};});const btn=$("#savePoll");btn.disabled=true;const {error}=await state.supabase.rpc("create_flexible_poll_v13_2",{p_circle_id:$("#pollCircle").value,p_title:$("#pollTitle").value.trim(),p_choice_mode:$("#pollChoiceMode").value,p_options:options});btn.disabled=false;if(error)return setMsg($("#pollCreateMsg"),error.message,true);state.activeSharedCircleId=$("#pollCircle").value;localStorage.setItem(sharedCircleSelectionKey(state),state.activeSharedCircleId);await refreshSocialExtras(state);dialog.close();renderGroupPolls(state);switchMainTab(state,"events");state.setStatus("Poll created ✓");});
}

async function createPollFromMeetupDate(state,group,allCandidates){
  const seed=group.best||group.breakfast||group.dinner;if(seed)await createPollFromMeetup(state,seed,allCandidates);
}

async function shareMeetupSuggestion(state,x) {
  const names=humanNameList(x.freeMembers.map(m=>m.name));
  const text=`Could ${shortDashboardDate(x.day)} at ${x.time} work? ${x.free}/${x.total} are currently free${names?` (${names})`:""}. Check Our Days Off and let us know.`;
  try{
    if(navigator.share) await navigator.share({title:"Could this work?",text});
    else {await navigator.clipboard.writeText(text);state.setStatus("Suggestion copied ✓");}
  }catch(error){
    if(error?.name!=="AbortError"){
      try{await navigator.clipboard.writeText(text);state.setStatus("Suggestion copied ✓");}
      catch{window.prompt("Copy this message:",text);}
    }
  }
}

function humanNameList(names) {
  const clean=names.filter(Boolean);
  if(clean.length<=1) return clean[0]||"";
  if(clean.length===2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0,-1).join(", ")} and ${clean.at(-1)}`;
}
function mealAvailabilityDetails(state,day,min) {
  const free=[],busy=[],unknown=[];
  workingMembers(state).forEach(member=>{
    const status=personMealStatus(state,member.id,day,min);
    if(status==="free") free.push(member);
    else if(status==="busy") busy.push(member);
    else unknown.push(member);
  });
  return {free,busy,unknown};
}

function mealAvailability(state,day,min) {
  const d=mealAvailabilityDetails(state,day,min);
  return {free:d.free.length,busy:d.busy.length,unknown:d.unknown.length,known:d.free.length+d.busy.length};
}

function monthCoverage(state, date=todayUtc()) {
  const y=date.getUTCFullYear(), m=date.getUTCMonth();
  const daysInMonth=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  const prefix=`${y}-${String(m+1).padStart(2,"0")}-`;
  const members=workingMembers(state).map(member=>{
    const covered=new Set(state.daysOff.filter(x=>x.member_id===member.id&&x.day.startsWith(prefix)).map(x=>x.day)).size;
    return {...member,covered,total:daysInMonth,percent:Math.round((covered/daysInMonth)*100)};
  });
  const totalSlots=daysInMonth*Math.max(1,members.length);
  const coveredSlots=members.reduce((s,x)=>s+x.covered,0);
  return {
    label:new Intl.DateTimeFormat("en-GB",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(Date.UTC(y,m,1))),
    members,
    percent:members.length?Math.round((coveredSlots/totalSlots)*100):0
  };
}



function circleSelectionKey(state){
  return `odoCircle:${state.me?.group_id||state.group?.id||"group"}:${state.me?.id||"member"}`;
}
function availableCircles(state){
  const custom=(state.circleDefs||[]).map(x=>({
    key:x.circle_key,
    label:x.label,
    icon:x.icon||"◉",
    custom:true
  }));
  return [...PERSONAL_CIRCLES,...custom];
}
function circleLabel(key,state=null){
  const source=state?availableCircles(state):PERSONAL_CIRCLES;
  return source.find(x=>x.key===key)?.label||"All";
}
function memberCircleKeys(state,memberId){
  return (state.personalCircles||[])
    .filter(x=>x.target_member_id===memberId)
    .map(x=>x.circle_key);
}
function memberInCircle(state,member,circleKey=state.activeCircle){
  return !circleKey||circleKey==="all"||memberCircleKeys(state,member.id).includes(circleKey);
}
function circleWorkingMembers(state){return workingMembers(state);}

function circleMemberCount(state,key){
  if(key==="all") return state.members.length;
  return state.members.filter(m=>memberCircleKeys(state,m.id).includes(key)).length;
}
function personalCircleSummary(state,member){
  const keys=memberCircleKeys(state,member.id);
  return keys.length?keys.map(key=>circleLabel(key,state)).join(" · "):"Not placed in a personal circle";
}
function renderCircleSwitchers(state){
  document.querySelectorAll("[data-circle-switcher]").forEach(holder=>{
    const circles=discoverableSharedCircles(state);
    holder.innerHTML=circles.map(circle=>{
      const joined=isCircleJoined(state,circle.id);
      const pending=!joined&&!!myPendingCircleRequest(state,circle.id);
      const active=joined&&state.activeSharedCircleId===circle.id;
      const count=joined&&circle.member_count!==null&&circle.member_count!==undefined?`<small>${circle.member_count}</small>`:"";
      return `<button class="circle-chip ${active?"active":""} ${joined?"joined":"locked"} ${pending?"requested":""}" type="button" ${joined?`data-shared-circle-key="${circle.id}"`:`data-request-circle-join="${circle.id}"`} ${pending?"disabled":""}>
        <span>${escapeHtml(circle.icon||"◎")}</span><span>${escapeHtml(circle.name)}</span>${count}${!joined?`<small>${pending?"Pending":"🔒 Join"}</small>`:""}
      </button>`;
    }).join("");
    holder.querySelectorAll("[data-shared-circle-key]").forEach(btn=>btn.addEventListener("click",()=>setActiveSharedCircle(state,btn.dataset.sharedCircleKey)));
    wireCircleJoinActions(state,holder);
  });
}

async function setPersonalCircle(state,memberId,circleKey,enabled){
  if(!navigator.onLine) throw new Error("Reconnect to update personal circles.");
  const {error}=await state.supabase.rpc("set_personal_member_circle",{
    p_target_member_id:memberId,
    p_circle_key:circleKey,
    p_enabled:enabled
  });
  if(error) throw error;

  const exists=(state.personalCircles||[]).some(x=>x.target_member_id===memberId&&x.circle_key===circleKey);
  if(enabled&&!exists) state.personalCircles.push({target_member_id:memberId,circle_key:circleKey});
  if(!enabled) state.personalCircles=state.personalCircles.filter(x=>!(x.target_member_id===memberId&&x.circle_key===circleKey));

  saveOfflineSnapshot(state);
  renderCircleSwitchers(state);
  renderDashboard(state);
  renderMeetupSuggestions(state);
  renderRotaCalendar(state);
}

function renderCustomCircleList(state){
  const holder=$("#customCircleList");
  if(!holder) return;
  const custom=availableCircles(state).filter(x=>x.custom);
  holder.innerHTML=custom.length
    ? custom.map(circle=>`<div class="custom-circle-row">
        <span class="circle-chip static"><span>${escapeHtml(circle.icon||"◉")}</span><span>${escapeHtml(circle.label)}</span><small>${circleMemberCount(state,circle.key)}</small></span>
        <button class="btn btn-tiny" type="button" data-delete-custom-circle="${circle.key}">Delete</button>
      </div>`).join("")
    : `<div class="subtle">No custom circles yet.</div>`;

  holder.querySelectorAll("[data-delete-custom-circle]").forEach(btn=>btn.addEventListener("click",async()=>{
    const key=btn.dataset.deleteCustomCircle;
    const circle=availableCircles(state).find(x=>x.key===key);
    if(!circle||!window.confirm(`Delete “${circle.label}”? This only removes your private circle, not any members.`)) return;
    btn.disabled=true;
    const {error}=await state.supabase.rpc("delete_personal_circle",{p_circle_key:key});
    btn.disabled=false;
    if(error) return state.setStatus?.(error.message,true);
    if(state.activeCircle===key){
      state.activeCircle="all";
      localStorage.setItem(circleSelectionKey(state),"all");
    }
    await refreshExtras(state);
    renderCircleSwitchers(state);
        renderDashboard(state);
    renderMeetupSuggestions(state);
    renderRotaCalendar(state);
    state.setStatus?.("Circle deleted ✓");
  }));
}

function wireCustomCircleCreator(state){
  const form=$("#newCircleForm");
  if(!form) return;
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const name=$("#newCircleName").value.trim();
    const icon=$("#newCircleIcon").value.trim()||"⭐";
    if(!name) return setMsg($("#circleCreateMsg"),"Enter a circle name.",true);
    const button=form.querySelector('button[type="submit"]');
    button.disabled=true;
    setMsg($("#circleCreateMsg"),"Creating…");
    const {data,error}=await state.supabase.rpc("create_personal_circle",{p_label:name,p_icon:icon});
    button.disabled=false;
    if(error) return setMsg($("#circleCreateMsg"),error.message,true);
    $("#newCircleName").value="";
    await refreshExtras(state);
    renderCircleSwitchers(state);
        setMsg($("#circleCreateMsg"),"Circle created ✓");
  });
}

function renderPersonalCircleManager(state){
  const holder=$("#personalCircleManager");
  if(!holder) return;
  const choices=availableCircles(state).filter(x=>x.key!=="all");

  holder.innerHTML=state.members.map(member=>`
    <div class="personal-circle-member">
      <div class="member-identity">
        ${memberAvatarHtml(member,"sm")}
        <div><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(personalCircleSummary(state,member))}</small></div>
      </div>
      <div class="circle-toggle-grid">
        ${choices.map(circle=>{
          const checked=memberCircleKeys(state,member.id).includes(circle.key);
          return `<label class="circle-toggle ${checked?"selected":""}">
            <input type="checkbox" data-personal-circle-member="${member.id}" data-personal-circle-key="${circle.key}" ${checked?"checked":""}>
            <span>${circle.icon} ${escapeHtml(circle.label)}</span>
          </label>`;
        }).join("")}
      </div>
    </div>`).join("");

  holder.querySelectorAll("[data-personal-circle-member]").forEach(input=>input.addEventListener("change",async()=>{
    const oldValue=!input.checked;
    input.disabled=true;
    try{
      await setPersonalCircle(state,input.dataset.personalCircleMember,input.dataset.personalCircleKey,input.checked);
      state.setStatus?.("My circles updated ✓");
    }catch(error){
      input.checked=oldValue;
      state.setStatus?.(error.message||"Could not update your circles.",true);
    }finally{
      input.disabled=false;
    }
  }));
}
function mealAvailabilityDetailsForMembers(state,day,minute,members){
  const free=[],busy=[],unknown=[];
  members.forEach(member=>{
    const status=personMealStatus(state,member.id,day,minute);
    if(status==="free") free.push(member);
    else if(status==="busy") busy.push(member);
    else unknown.push(member);
  });
  return {free,busy,unknown};
}
function buildMeetupCandidatesForMembers(state,members,daysAhead=60){
  return buildMagicHourCandidatesForMembers(state,members,daysAhead);
}

function todayPersonStatus(state,member,day) {
  if(state.availability?.some(x=>x.member_id===member.id&&x.day===day))return sharedDaySummary(state,member.id,day);
  const overrides=["breakfast","lunch","dinner"].map(meal=>mealOverrideFor(state,member.id,day,meal)).filter(Boolean);
  if(overrides.length===3&&overrides.every(x=>x.status==="available")) return {label:"Free today",className:"free"};
  if(overrides.length===3&&overrides.every(x=>x.status==="unavailable")) return {label:"Unavailable",className:"busy"};
  const entry=entryFor(state,member.id,day);
  if(!entry) return {label:"Schedule unknown",className:"unknown"};
  if(entry.entry_type==="off") return {label:"OFF",className:"free"};
  if(entry.entry_type==="shift") return {label:entry.raw_value||personEntryLabel(entry),className:"working"};
  if(entry.entry_type==="busy") return {label:entry.raw_value||"Busy",className:"busy"};
  return {label:entry.raw_value||"Partial",className:"partial"};
}

function renderTodayStrip(state) {
  const holder=$("#todayStrip");
  if(!holder) return;
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  const working=state.todayView!=="off";
  document.querySelectorAll('[data-today-view]').forEach(button=>{
    button.setAttribute('aria-pressed',String(button.dataset.todayView===(working?'working':'off')));
    button.onclick=()=>{state.todayView=button.dataset.todayView;renderTodayStrip(state);};
  });
  holder.innerHTML=`<div class="today-people-grid">${circleWorkingMembers(state).map(member=>{
    const status=working?todayWorkingStatus(state,member,today):todayPersonStatus(state,member,today);
    const detail=working?status.detail:personDayReason(state,member.id,today)||"Today";
    return `<div class="today-person compact"><div class="member-identity">${memberAvatarHtml(member,"sm")}<div><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(detail)}</small></div></div><span class="today-status ${status.className}">${escapeHtml(status.label)}</span></div>`;
  }).join("")}</div>`;
}
function todayWorkingStatus(state,member,day){
  if(memberScheduleVisibility(state,member)==="freebusy")return {label:"Private",detail:"Shift hours are not shared",className:"unknown"};
  const entry=entryFor(state,member.id,day);
  if(entry?.entry_type==="shift"){
    const label=isOvernightShift(entry)?"Night shift":"Day shift";
    const detail=Number.isInteger(entry.shift_start_min)&&Number.isInteger(entry.shift_end_min)
      ? `${minutesToInputTime(entry.shift_start_min)}–${minutesToInputTime(entry.shift_end_min)}`
      : "Hours not recorded";
    return {label:Number.isInteger(entry.shift_start_min)&&Number.isInteger(entry.shift_end_min)?label:"Working",detail,className:"working"};
  }
  if(entry?.entry_type==="off")return {label:"Off",detail:"No shift scheduled today",className:"free"};
  if(entry?.entry_type==="busy")return {label:"Busy",detail:"No shift hours recorded",className:"busy"};
  return {label:"Unknown",detail:"Shift hours not available",className:"unknown"};
}
function nextOffForMember(state,memberId,daysAhead=90) {
  const start=todayUtc();
  for(let i=0;i<daysAhead;i++){
    const dt=new Date(start.getTime()+i*86400000);
    const day=dateString(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate());
    if(memberIsFullDayOff(state,{id:memberId},day)) return day;
  }
  return null;
}

function personDayReason(state,memberId,day) {
  if(state.availability?.some(x=>x.member_id===memberId&&x.day===day))return sharedDaySummary(state,memberId,day).label;
  const overrides=["breakfast","lunch","dinner"]
    .map(meal=>mealOverrideFor(state,memberId,day,meal))
    .filter(Boolean);

  const notedUnavailable=overrides.find(x=>x.status==="unavailable"&&x.note);
  if(notedUnavailable) return notedUnavailable.note;

  if(overrides.length===3 && overrides.every(x=>x.status==="available")) return "Marked free all day";

  const prev=entryFor(state,memberId,addDaysString(day,-1));
  if(prev?.entry_type==="shift"&&isOvernightShift(prev)) return "Post-night";

  const entry=entryFor(state,memberId,day);
  if(!entry) return "Rota not entered";
  if(entry.entry_type==="off") return "OFF / free all day";
  if(entry.entry_type==="shift") return "Working";
  if(entry.entry_type==="busy") return entry.raw_value||"Training / busy";
  if(entry.entry_type==="partial") return "Partial availability";
  return "";
}

async function setTodayAvailability(state,status,note) {
  const me=workingMembers(state).find(x=>x.id===state.me.id);
  if(!me) return;
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  state.setStatus?.("Saving availability…");

  for(const meal of ["breakfast","lunch","dinner"]){
    const {error}=await state.supabase.rpc("save_meal_override",{
      p_member_id:me.id,
      p_day:today,
      p_meal:meal,
      p_status:status,
      p_note:note
    });
    if(error){
      state.setStatus?.(error.message,true);
      return;
    }
  }
  await refreshExtras(state);
  renderRotaCalendar(state);
  renderDashboard(state);
  state.setStatus?.(status==="available"?"You’re marked free today ✓":"You’re marked unavailable today ✓");
}

async function remindMember(state,member) {
  const month=new Intl.DateTimeFormat("en-GB",{month:"long",year:"numeric",timeZone:"UTC"}).format(state.view);
  const text=`Hi ${member.name} 👋 Could you update your ${month} rota in Our Days Off? It’ll help us spot the best days to meet.`;
  try{
    if(navigator.share) await navigator.share({text});
    else {
      await navigator.clipboard.writeText(text);
      state.setStatus?.(`Reminder for ${member.name} copied ✓`);
    }
  }catch(error){
    if(error?.name!=="AbortError"){
      try{await navigator.clipboard.writeText(text);state.setStatus?.(`Reminder for ${member.name} copied ✓`);}
      catch{window.prompt("Copy reminder:",text);}
    }
  }
}

function goodDayEnabledKey(state){ return `goodDayAlerts:${state.me.group_id}:${state.me.id}`; }
function goodDaySeenKey(state){ return `goodDaySeen:${state.me.group_id}:${state.me.id}`; }
function goodDayAlertsEnabled(state){ return localStorage.getItem(goodDayEnabledKey(state))==="1"; }

function goodDayCandidates(state){
  const members=circleWorkingMembers(state),total=members.length,threshold=Math.max(2,Math.ceil(total*.8));
  return buildMagicHourCandidatesForMembers(state,members,30).filter(x=>x.free>=threshold&&x.unknown===0).sort((a,b)=>b.score-a.score||a.day.localeCompare(b.day)||a.startMin-b.startMin);
}

function updateGoodDayAlertButton(state) {
  const btn=$("#goodDayAlertsBtn");
  if(!btn) return;
  const enabled=goodDayAlertsEnabled(state) && ("Notification" in window) && Notification.permission==="granted";
  btn.textContent=enabled?"🔔 Good-day alerts on":"🔔 Good-day alerts";
  btn.classList.toggle("alert-enabled",enabled);
}

async function toggleGoodDayAlerts(state) {
  if(!("Notification" in window)){
    state.setStatus?.("Notifications aren’t supported in this browser.",true);
    return;
  }

  if(goodDayAlertsEnabled(state)){
    localStorage.setItem(goodDayEnabledKey(state),"0");
    updateGoodDayAlertButton(state);
    state.setStatus?.("Good-day alerts turned off.");
    return;
  }

  let permission=Notification.permission;
  if(permission!=="granted") permission=await Notification.requestPermission();
  if(permission!=="granted"){
    state.setStatus?.("Notification permission wasn’t enabled.",true);
    return;
  }

  localStorage.setItem(goodDayEnabledKey(state),"1");
  localStorage.setItem(goodDaySeenKey(state),JSON.stringify(goodDayCandidates(state).map(x=>`${x.day}:${x.startMin}:${x.endMin}`)));
  updateGoodDayAlertButton(state);
  state.setStatus?.("Good-day alerts are on ✓");
}

async function showFriendlyGoodDayNotification(state,candidate){
  const names=candidate.freeMembers.map(x=>x.name);
  const body=candidate.allFree?`Everyone is free ${candidate.time} on ${shortDashboardDate(candidate.day)} 🎉`:`${names.join(", ")} are free ${candidate.time} on ${shortDashboardDate(candidate.day)}.`;
  const options={body,icon:"./icon-192.png",badge:"./icon-192.png",tag:`magic-hour-${candidate.day}-${candidate.startMin}`};
  try{if("serviceWorker" in navigator){const reg=await navigator.serviceWorker.ready;await reg.showNotification("Magic Hour found ✨",options);}else new Notification("Magic Hour found ✨",options);}catch{}
}

async function checkGoodDayNotifications(state) {
  if(!goodDayAlertsEnabled(state) || !("Notification" in window) || Notification.permission!=="granted") return;

  const candidates=goodDayCandidates(state);
  let seen=[];
  try{seen=JSON.parse(localStorage.getItem(goodDaySeenKey(state))||"[]");}catch{}
  const seenSet=new Set(seen);
  const fresh=candidates.filter(x=>!seenSet.has(`${x.day}:${x.startMin}:${x.endMin}`));

  localStorage.setItem(goodDaySeenKey(state),JSON.stringify(candidates.map(x=>`${x.day}:${x.startMin}:${x.endMin}`)));
  if(fresh.length) await showFriendlyGoodDayNotification(state,fresh[0]);
}


function renderWeeklyPreview(state){
  const holder=$("#weeklyPreviewCard");if(!holder)return;
  const members=circleWorkingMembers(state);
  const range=Math.max(7,Number(state.meetRangeDays||14));
  const candidates=buildMagicHourCandidatesForMembers(state,members,range)
    .filter(x=>x.free>=Math.max(2,Math.ceil(x.total*.6)))
    .filter((x,i,a)=>a.findIndex(y=>y.day===x.day&&y.startMin===x.startMin&&y.endMin===x.endMin)===i)
    .slice(0,3);

  if(!candidates.length){
    holder.innerHTML=`<div><p class="eyebrow">Best shared windows</p><h3>Nothing strong yet</h3><p class="subtle">The sections below explain whether rota data is missing or there is simply no useful overlap.</p></div>`;
    return;
  }

  holder.innerHTML=`
    <div>
      <p class="eyebrow">Best shared windows</p>
      <h3>Top opportunities</h3>
      <p class="subtle">The strongest upcoming windows for this circle.</p>
    </div>
    <div class="weekly-preview-list">
      ${candidates.map(x=>`
        <button class="weekly-preview-row meet-window-row ${magicStrengthClass(x)}" type="button"
          data-best-window-day="${x.day}" data-best-window-start="${x.startMin}" data-best-window-end="${x.endMin}" data-best-window-name="${escapeAttr(x.name)}">
          <strong>${escapeHtml(shortDashboardDate(x.day))}</strong>
          <span>${escapeHtml(x.name)} · ${escapeHtml(x.time)}</span>
          <b>${x.free}/${x.total}</b>
          ${magicMemberAvatars(x,"tiny")}
        </button>`).join("")}
    </div>`;

  holder.querySelectorAll("[data-best-window-day]").forEach(btn=>btn.addEventListener("click",()=>{
    openEventDialogFromMeetup(state,{
      day:btn.dataset.bestWindowDay,
      name:btn.dataset.bestWindowName,
      startMin:Number(btn.dataset.bestWindowStart),
      endMin:Number(btn.dataset.bestWindowEnd)
    });
  }));
}

function renderDashboard(state){
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  const selectedWorkers=circleWorkingMembers(state);
  const candidates=buildMagicHourCandidatesForMembers(state,selectedWorkers,30).filter(x=>x.free>=Math.max(2,Math.ceil(x.total*.6)));
  const best=candidates[0]||null;
  const nextPlan=nextUpcomingEvent(state);
  const me=workingMembers(state).find(x=>x.id===state.me.id)||null;

  const greeting=$("#homeGreeting");if(greeting)greeting.textContent=`${timeGreeting()}, ${state.me.name} 👋`;
  const todayHeading=$("#todayHeading");if(todayHeading)todayHeading.textContent=shortDashboardDate(today);
  renderTodayStrip(state);

  const hero=$("#bestOpportunityHero");
  if(hero){
    if(best){
      const names=humanNameList(best.freeMembers.map(m=>m.name)),allFree=best.allFree;
      hero.innerHTML=`<div class="hero-badge">${allFree?"🎉 Everyone is free":"✨ Close enough"}</div>
        <div class="hero-main"><div><h2>${escapeHtml(shortDashboardDate(best.day))} · ${escapeHtml(best.name)}</h2><p><strong>${escapeHtml(best.time)}</strong> · ${escapeHtml(names||"No one confirmed yet")} ${best.free===1?"is":"are"} free.</p></div><div class="hero-score"><strong>${best.free}/${best.total}</strong><span>free</span></div></div>
        <div class="hero-avatars">${best.freeMembers.map(m=>memberAvatarHtml(m,"sm")).join("")}</div>
        <div class="hero-actions"><button class="btn btn-primary" id="heroPlanBtn" type="button">Make a plan</button><button class="btn" id="heroSeeMeetBtn" type="button">See Magic Hours</button></div>`;
      $("#heroPlanBtn")?.addEventListener("click",()=>openEventDialogFromMeetup(state,best));
      $("#heroSeeMeetBtn")?.addEventListener("click",()=>switchMainTab(state,"meetups"));
    }else{
      hero.innerHTML=`<div class="hero-badge">No useful overlap yet</div><div class="hero-main"><div><h2>Nothing strong in the next 30 days</h2><p>Add missing rotas or open Meet to see why.</p></div></div><button class="btn btn-primary" id="heroSeeMeetBtn" type="button">Open Meet</button>`;
      $("#heroSeeMeetBtn")?.addEventListener("click",()=>switchMainTab(state,"meetups"));
    }
  }

  const planCard=$("#nextPlanCard");
  if(planCard){
    planCard.innerHTML=nextPlan?`<div><p class="eyebrow">Next plan</p><h3>${eventIcon(nextPlan.category)} ${escapeHtml(nextPlan.title)}</h3><p class="subtle">${escapeHtml(shortDashboardDate(nextPlan.day))} · ${escapeHtml(eventTimeLabel(nextPlan))}${nextPlan.location?` · ${escapeHtml(nextPlan.location)}`:""}</p></div><button class="btn btn-small" id="openNextPlan" type="button">View plan</button>`:`<div><p class="eyebrow">Next plan</p><h3>Nothing planned yet</h3><p class="subtle">Turn a Magic Hour into something to look forward to.</p></div><button class="btn btn-small" id="emptyPlanBtn" type="button">+ Make a plan</button>`;
    $("#openNextPlan")?.addEventListener("click",()=>{state.expandedPlanId=nextPlan.id;switchMainTab(state,"events");renderUpcomingEvents(state);});
    $("#emptyPlanBtn")?.addEventListener("click",()=>openEventDialog(state,null,today));
  }

  const scheduleCard=$("#myScheduleCard");
  if(scheduleCard){
    if(me){
      const nextOff=nextOffForMember(state,me.id),nextShift=nextShiftForMember(state,me.id);
      const coverage=Array.from({length:14},(_,i)=>addDaysString(today,i)).filter(day=>entryFor(state,me.id,day)).length;
      scheduleCard.innerHTML=`<div><p class="eyebrow">My schedule</p><h3>${nextOff?`Next OFF · ${escapeHtml(shortDashboardDate(nextOff))}`:"No upcoming OFF found"}</h3><p class="subtle">${nextShift?`Next shift: ${escapeHtml(shortDashboardDate(nextShift.day))} · ${escapeHtml(personEntryLabel(nextShift.entry))}`:"No upcoming shift entered"}</p></div><span class="schedule-coverage">${coverage}/14 upcoming days entered · ${14-coverage} unknown. One schedule for every circle.</span><button class="btn btn-small" id="openMyCalendar" type="button">My calendar</button>`;
      $("#openMyCalendar")?.addEventListener("click",()=>{state.calendarView=me.id;switchMainTab(state,"calendar");renderRotaCalendar(state);});
    }else scheduleCard.innerHTML=`<div><p class="eyebrow">Your role</p><h3>Viewer</h3><p class="subtle">You can see availability, create plans and RSVP without editing rotas.</p></div>`;
  }
  if(state.me.is_owner)renderOwnerAttention(state);
}

function timeGreeting() {
  const h=new Date().getHours();
  if(h<12) return "Good morning";
  if(h<18) return "Good afternoon";
  return "Good evening";
}

function nextShiftForMember(state,memberId,daysAhead=90) {
  const start=todayUtc();
  for(let i=0;i<daysAhead;i++){
    const dt=new Date(start.getTime()+i*86400000);
    const day=dateString(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate());
    const entry=entryFor(state,memberId,day);
    if(entry?.entry_type==="shift") return {day,entry};
  }
  return null;
}

function renderOwnerAttention(state) {
  const el=$("#ownerAttention");
  if(!el) return;
  const coverage=monthCoverage(state);
  const missing=coverage.members.filter(x=>x.percent<80);
  if(!missing.length){el.hidden=true;return;}
  el.hidden=false;
  el.innerHTML=`<div><strong>Admin note</strong><span>${missing.length} ${missing.length===1?"rota looks":"rotas look"} incomplete this month: ${escapeHtml(humanNameList(missing.map(x=>x.name)))}</span></div><button class="btn btn-small" id="ownerOpenMembers" type="button">Review members</button>`;
  $("#ownerOpenMembers")?.addEventListener("click",()=>openMeSection(state,"admin"));
}
function wireDashboardActions(state) {
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  $("#quickAddEvent")?.addEventListener("click",()=>openEventDialog(state,null,today));
  $("#quickFreeToday")?.addEventListener("click",()=>setTodayAvailability(state,"available","Free today"));
  $("#quickUnavailableToday")?.addEventListener("click",()=>setTodayAvailability(state,"unavailable","Unavailable today"));
  $("#quickAvailability")?.addEventListener("click",()=>{
    const me=workingMembers(state).find(x=>x.id===state.me.id);
    if(me) openAvailabilityOverrideDialog(state,me,today);
  });
}
function nextUpcomingEvent(state) {
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  return [...activeCircleEvents(state)].filter(x=>x.day>=today).sort((a,b)=>a.day.localeCompare(b.day)||(a.start_min??9999)-(b.start_min??9999))[0]||null;
}

function openDayFromDashboard(state,day) {
  state.selectedDate=day;
  const p=parseDate(day);
  state.view=new Date(Date.UTC(p.y,p.m,1));
  state.calendarView="group";
  if($("#calendarViewSelect")) $("#calendarViewSelect").value="group";
  switchMainTab(state,"calendar",{keepScroll:true});
  renderRotaCalendar(state);
}

function shortDashboardDate(day) {
  const p=parseDate(day);
  return new Intl.DateTimeFormat("en-GB",{weekday:"short",day:"numeric",month:"short",timeZone:"UTC"}).format(new Date(Date.UTC(p.y,p.m,p.d)));
}
function personMealStatus(state,memberId,day,min){
  return personSocialStatusAt(state,{id:memberId},day,min);
}
function isOvernightShift(e){ return e?.entry_type==="shift"&&Number.isInteger(e.shift_start_min)&&Number.isInteger(e.shift_end_min)&&e.shift_end_min<=e.shift_start_min; }
function canEditMember(state,id){ return !!id&&state.me.role!=="viewer"&&(state.me.is_owner||state.me.id===id); }

function mealKeyFromMinute(min) {
  if(min===540) return "breakfast";
  if(min===840) return "lunch";
  if(min===1200) return "dinner";
  return null;
}

function setAvailabilitySelects(breakfast,lunch,dinner,note="") {
  $("#breakfastOverride").value=breakfast;
  $("#lunchOverride").value=lunch;
  $("#dinnerOverride").value=dinner;
  $("#availabilityOverrideNote").value=note;
}

function applyAvailabilityPreset(preset) {
  switch(preset) {
    case "postnight":
      setAvailabilitySelects("unavailable","auto","auto","Post-night");
      break;
    case "sleeping":
      setAvailabilitySelects("unavailable","unavailable","auto","Sleeping / resting");
      break;
    case "away":
      setAvailabilitySelects("unavailable","unavailable","unavailable","Away");
      break;
    case "family":
      setAvailabilitySelects("unavailable","unavailable","unavailable","Family plans");
      break;
    case "freeallday":
      setAvailabilitySelects("available","available","available","");
      break;
    case "auto":
      setAvailabilitySelects("auto","auto","auto","");
      break;
  }
}

function applyFreeAfterPreset(time) {
  const minute=timeToMinutes(time);
  if(minute===null) return;
  const statusFor=mealMinute=>mealMinute>=minute?"available":"unavailable";
  setAvailabilitySelects(
    statusFor(540),
    statusFor(840),
    statusFor(1200),
    `Free after ${time}`
  );
}

function memberInitials(member) {
  const custom=String(member?.calendar_initials||"").trim();if(custom)return custom.slice(0,3).toUpperCase();
  const parts=String(member?.name||"?").trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return "?";
  if(parts.length>1) return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();

  const name=parts[0].replace(/[^A-Za-z]/g,"");
  if(!name) return "?";
  if(name.length===1) return name.toUpperCase();

  const first=name[0].toUpperCase();
  const rest=name.slice(1);
  const consonant=rest.match(/[bcdfghjklmnpqrstvwxyz]/i)?.[0];
  const second=(consonant||name[1]).toUpperCase();
  return first+second;
}

function memberHue(member) {
  const key=String(member?.id||member?.name||"member");
  let hash=0;
  for(let i=0;i<key.length;i++) hash=((hash<<5)-hash)+key.charCodeAt(i);
  return Math.abs(hash)%360;
}

function memberAvatarHtml(member,size="sm") {
  const hue=memberHue(member);
  const initials=escapeHtml(memberInitials(member));
  const title=escapeAttr(member?.name||"Member");
  return `<span class="member-avatar avatar-${size}" style="--member-hue:${hue}" title="${title}" aria-hidden="true">${initials}</span>`;
}

function mealOverrideFor(state,memberId,day,meal) {
  return state.mealOverrides.find(x=>x.member_id===memberId&&x.day===day&&x.meal===meal)||null;
}

function wireAvailabilityOverrideDialog(state) {
  $("#cancelAvailabilityOverride").addEventListener("click",()=>$("#availabilityOverrideDialog").close());

  $("#availabilityPresetButtons")?.querySelectorAll("[data-availability-preset]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      applyAvailabilityPreset(btn.dataset.availabilityPreset);
      setMsg($("#availabilityOverrideMsg"),"Preset applied — review the meal settings, then Save.");
    });
  });

  $("#freeAfterPresetBtn")?.addEventListener("click",()=>{
    const time=$("#freeAfterTime").value;
    if(!time) return setMsg($("#availabilityOverrideMsg"),"Choose a time first.",true);
    applyFreeAfterPreset(time);
    setMsg($("#availabilityOverrideMsg"),`Free-after ${time} applied — review, then Save.`);
  });

  $("#availabilityOverrideForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const memberId=state.availabilityEditMemberId;
    const day=state.availabilityEditDate;
    const note=$("#availabilityOverrideNote").value.trim()||null;
    const save=$("#saveAvailabilityOverride");
    save.disabled=true;
    setMsg($("#availabilityOverrideMsg"),"Saving…");

    const items=[
      ["breakfast",$("#breakfastOverride").value],
      ["lunch",$("#lunchOverride").value],
      ["dinner",$("#dinnerOverride").value]
    ];

    for(const [meal,status] of items){
      const {error}=await state.supabase.rpc("save_meal_override",{
        p_member_id:memberId,
        p_day:day,
        p_meal:meal,
        p_status:status,
        p_note:status==="auto"?null:note
      });
      if(error){
        save.disabled=false;
        return setMsg($("#availabilityOverrideMsg"),error.message,true);
      }
    }

    await refreshExtras(state);
    save.disabled=false;
    $("#availabilityOverrideDialog").close();
    state.setStatus("Meetup availability updated.");
    renderRotaCalendar(state);
  });
}

function openAvailabilityOverrideDialog(state,member,day) {
  if(!canEditMember(state,member.id)) return;
  state.availabilityEditMemberId=member.id;
  state.availabilityEditDate=day;

  $("#availabilityOverrideDate").textContent=prettyDate(day);
  $("#availabilityOverridePerson").textContent=`Availability for: ${member.name}`;

  const b=mealOverrideFor(state,member.id,day,"breakfast");
  const l=mealOverrideFor(state,member.id,day,"lunch");
  const d=mealOverrideFor(state,member.id,day,"dinner");

  $("#breakfastOverride").value=b?.status||"auto";
  $("#lunchOverride").value=l?.status||"auto";
  $("#dinnerOverride").value=d?.status||"auto";

  const note=b?.note||l?.note||d?.note||"";
  $("#availabilityOverrideNote").value=note;
  setMsg($("#availabilityOverrideMsg"),"");
  $("#availabilityOverrideDialog").showModal();
}


function activeCircleEvents(state){return (state.events||[]).filter(e=>e.circle_id===state.activeSharedCircleId);}

function eventsForDay(state,day) {
  return activeCircleEvents(state).filter(e=>e.day===day).sort((a,b)=>(a.start_min??9999)-(b.start_min??9999));
}

function canEditEvent(state,event) {
  return state.me.is_owner || event.created_by_member_id===state.me.id;
}

function eventTimeLabel(event) {
  if(Number.isInteger(event.start_min)&&Number.isInteger(event.end_min))return `${windowTimeLabel(event.start_min,event.end_min%1440||1440)}${event.end_min>1440?" (+1 day)":""} · ${event.time_zone||"Europe/London"}`;
  return Number.isInteger(event.start_min) ? minutesToInputTime(event.start_min) : "Time not set";
}

function rsvpsForEvent(state,eventId) {
  return state.eventRsvps.filter(x=>String(x.event_id)===String(eventId));
}

function rsvpSummary(state,eventId) {
  const rows=rsvpsForEvent(state,eventId);
  return {
    going:rows.filter(x=>x.status==="going").length,
    maybe:rows.filter(x=>x.status==="maybe").length,
    cant:rows.filter(x=>x.status==="cant").length,
    my:rows.find(x=>x.member_id===state.me.id)?.status||null
  };
}


function eventRsvpMembers(state,eventId,status){
  const rows=rsvpsForEvent(state,eventId).filter(x=>x.status===status);
  return rows.map(row=>state.members.find(m=>m.id===row.member_id)).filter(Boolean);
}
function rsvpPeopleRowHtml(state,eventId,status,label,icon){
  const people=eventRsvpMembers(state,eventId,status);
  return `<div class="rsvp-people-row ${status}">
    <span class="rsvp-people-label">${icon} ${escapeHtml(label)}</span>
    <div class="rsvp-people-list">
      ${people.length
        ? people.map(m=>`<span class="rsvp-person-chip">${memberAvatarHtml(m,"tiny")}<span>${escapeHtml(m.name)}</span></span>`).join("")
        : `<span class="subtle">No one yet</span>`}
    </div>
  </div>`;
}
function eventNotesFor(state,eventId){
  return (state.eventNotes||[]).filter(x=>Number(x.event_id)===Number(eventId));
}
function eventNotesHtml(state,eventId){
  const notes=eventNotesFor(state,eventId);
  return `<div class="plan-community-notes">
    <div class="plan-notes-head"><strong>Notes from the group</strong><span>${notes.length?`${notes.length} note${notes.length===1?"":"s"}`:""}</span></div>
    ${notes.length?`<div class="plan-note-list">${notes.map(note=>{
      const member=state.members.find(m=>m.id===note.member_id);
      const canDelete=state.me.is_owner||note.member_id===state.me.id;
      return `<div class="plan-note-item">
        <div class="member-identity">${memberAvatarHtml(member||{name:"?"},"tiny")}<div><strong>${escapeHtml(member?.name||"Member")}</strong><span>${escapeHtml(note.body)}</span></div></div>
        ${canDelete?`<button class="note-delete-btn" type="button" data-delete-plan-note="${note.id}" aria-label="Delete note">×</button>`:""}
      </div>`;
    }).join("")}</div>`:""}
    <form class="plan-note-form" data-plan-note-form="${eventId}">
      <input class="input" name="planNote" maxlength="240" placeholder="Add a note for everyone…">
      <button class="btn btn-small" type="submit">Add note</button>
    </form>
  </div>`;
}


function locationOptionsForEvent(state,eventId){
  return (state.eventLocationOptions||[]).filter(x=>Number(x.event_id)===Number(eventId));
}
function locationVotesForEvent(state,eventId){
  return (state.eventLocationVotes||[]).filter(x=>Number(x.event_id)===Number(eventId));
}
function locationVotingHtml(state,event){
  const options=locationOptionsForEvent(state,event.id);const votes=locationVotesForEvent(state,event.id);const myVote=votes.find(v=>v.member_id===state.me.id)?.option_id||null;
  return `<div class="location-vote-box"><div class="row-wrap between"><strong>Where should we go / What should we do?</strong>${event.location?`<span class="subtle">Current: ${escapeHtml(event.location)}</span>`:`<span class="subtle">Vote or suggest</span>`}</div>
    ${options.length?`<div class="location-option-list">${options.map(option=>{const optionVotes=votes.filter(v=>Number(v.option_id)===Number(option.id));const names=optionVotes.map(v=>state.members.find(m=>m.id===v.member_id)?.name).filter(Boolean);const canDelete=option.created_by_member_id===state.me.id||event.created_by_member_id===state.me.id||canManageCircle(state,event.circle_id);return `<div class="location-option-row"><button class="location-vote-option ${Number(myVote)===Number(option.id)?"active":""}" type="button" data-location-vote="${option.id}"><span><strong>${escapeHtml(option.label)}</strong><small>${names.length?escapeHtml(names.join(", ")):"No votes yet"}</small></span><b>${optionVotes.length}</b></button>${canDelete?`<button class="location-delete-btn" type="button" data-delete-location-option="${option.id}" aria-label="Delete ${escapeAttr(option.label)}">×</button>`:""}</div>`;}).join("")}</div>`:""}
    <form class="location-suggest-form" data-location-suggest-event="${event.id}"><input class="input" name="locationSuggestion" maxlength="100" placeholder="Suggest a place or activity…"><button class="btn btn-small" type="submit">Suggest</button></form></div>`;
}
function sharePlanText(state,event){
  const going=eventRsvpMembers(state,event.id,"going").map(x=>x.name),maybe=eventRsvpMembers(state,event.id,"maybe").map(x=>x.name);const url=buildDeepLink("plan",event.id);
  return [`${eventIcon(event.category)} ${event.title}`,`${prettyDate(event.day)} · ${eventTimeLabel(event)}`,event.location?`📍 ${event.location}`:"",going.length?`✅ Going: ${going.join(", ")}`:"✅ Going: no one yet",maybe.length?`🤔 Maybe: ${maybe.join(", ")}`:"",event.note?`📝 ${event.note}`:"",`Open this plan in Our Days Off: ${url}`].filter(Boolean).join("\n");
}

async function sharePlan(state,event){
  const text=sharePlanText(state,event);
  try{
    if(navigator.share){await navigator.share({title:event.title,text});return;}
  }catch(error){if(error?.name==="AbortError")return;}
  try{await navigator.clipboard.writeText(text);state.setStatus?.("Plan copied — ready for WhatsApp ✓");}
  catch{window.prompt("Copy plan:",text);}
}

function eventIcon(category) {
  return ({
    dinner:"🍽",
    home:"🏠",
    coffee:"☕",
    breakfast:"🍳",
    party:"🎉",
    trip:"✈️",
    dayout:"🏞",
    other:"📌"
  })[category||"other"] || "📌";
}

function eventCardHtml(state,event,compact=false,showDate=false){
  const canEdit=canEditEvent(state,event),r=rsvpSummary(state,event.id),collapsible=!compact,expanded=!collapsible||Number(state.expandedPlanId)===Number(event.id);
  const summary=`<div class="plan-summary-copy"><span class="event-icon">${eventIcon(event.category)}</span><div><strong>${escapeHtml(event.title)}</strong><div class="event-meta">${showDate?`${escapeHtml(prettyDate(event.day))} · `:""}${escapeHtml(eventTimeLabel(event))}${event.location?` · ${escapeHtml(event.location)}`:""}</div><small>${escapeHtml(circleNameById(state,event.circle_id))} · ${r.going} going · ${r.maybe} maybe</small></div></div><span class="plan-expand-chevron">${expanded?"⌃":"⌄"}</span>`;
  return `<div class="event-card ${compact?"compact":""} ${collapsible?"collapsible-plan":""} ${expanded?"expanded":"collapsed"}" data-event-card="${event.id}">${collapsible?`<button class="plan-summary-button" type="button" data-toggle-plan="${event.id}" aria-expanded="${expanded}">${summary}</button>`:`<div class="plan-summary-static">${summary}</div>`}<div class="plan-card-body" ${expanded?"":"hidden"}><div class="row-wrap between"><div class="event-circle-badge">◎ ${escapeHtml(circleNameById(state,event.circle_id))}</div><div class="row-wrap"><button class="btn btn-small" type="button" data-share-plan="${event.id}">Share</button><button class="btn btn-small" type="button" data-calendar-event="${event.id}">Add to calendar</button>${canEdit?`<button class="btn btn-small" type="button" data-edit-event="${event.id}">Edit</button>`:""}</div></div>${event.note?`<div class="event-note"><strong>Plan details</strong><span>${escapeHtml(event.note)}</span></div>`:""}<div class="rsvp-people-groups">${rsvpPeopleRowHtml(state,event.id,"going","Going","✓")}${rsvpPeopleRowHtml(state,event.id,"maybe","Maybe","?")}${rsvpPeopleRowHtml(state,event.id,"cant","Can’t","×")}</div><div class="rsvp-actions"><button class="rsvp-btn ${r.my==="going"?"active":""}" type="button" data-rsvp-event="${event.id}" data-rsvp-status="going">✓ Going</button><button class="rsvp-btn ${r.my==="maybe"?"active":""}" type="button" data-rsvp-event="${event.id}" data-rsvp-status="maybe">? Maybe</button><button class="rsvp-btn ${r.my==="cant"?"active":""}" type="button" data-rsvp-event="${event.id}" data-rsvp-status="cant">× Can’t</button></div>${locationVotingHtml(state,event)}${eventNotesHtml(state,event.id)}</div></div>`;
}

function wireEventCardActions(state,container=document) {
  container.querySelectorAll("[data-toggle-plan]").forEach(btn=>{if(btn.dataset.wired)return;btn.dataset.wired="1";btn.addEventListener("click",()=>{const id=Number(btn.dataset.togglePlan);state.expandedPlanId=Number(state.expandedPlanId)===id?null:id;renderUpcomingEvents(state);});});
  container.querySelectorAll("[data-share-plan]").forEach(btn=>{
    if(btn.dataset.wired) return;
    btn.dataset.wired="1";
    btn.addEventListener("click",()=>{
      const event=state.events.find(x=>String(x.id)===btn.dataset.sharePlan);
      if(event) sharePlan(state,event);
    });
  });

  container.querySelectorAll("[data-location-vote]").forEach(btn=>{
    if(btn.dataset.wired) return;
    btn.dataset.wired="1";
    btn.addEventListener("click",async()=>{
      const optionId=Number(btn.dataset.locationVote);
      const option=state.eventLocationOptions.find(x=>Number(x.id)===optionId);
      if(!option) return;
      const {error}=await state.supabase.rpc("vote_event_location",{p_event_id:option.event_id,p_option_id:optionId});
      if(error) return state.setStatus?.(error.message,true);
      await refreshExtras(state);renderUpcomingEvents(state);renderDayDetails(state);
      state.setStatus?.("Location vote saved ✓");
    });
  });

  container.querySelectorAll("[data-location-suggest-event]").forEach(form=>{
    if(form.dataset.wired) return;
    form.dataset.wired="1";
    form.addEventListener("submit",async e=>{
      e.preventDefault();
      const input=form.querySelector('input[name="locationSuggestion"]');
      const label=input?.value.trim()||"";
      if(!label) return;
      const button=form.querySelector('button[type="submit"]');button.disabled=true;
      const {error}=await state.supabase.rpc("add_event_location_option",{p_event_id:Number(form.dataset.locationSuggestEvent),p_label:label});
      button.disabled=false;if(error)return state.setStatus?.(error.message,true);
      input.value="";await refreshExtras(state);renderUpcomingEvents(state);renderDayDetails(state);
      state.setStatus?.("Location suggested ✓");
    });
  });

  container.querySelectorAll("[data-delete-location-option]").forEach(btn=>{
    if(btn.dataset.wired)return;btn.dataset.wired="1";
    btn.addEventListener("click",async()=>{if(!window.confirm("Delete this location suggestion and its votes?"))return;const {error}=await state.supabase.rpc("delete_event_location_option_v13_2",{p_option_id:Number(btn.dataset.deleteLocationOption)});if(error)return state.setStatus?.(error.message,true);await refreshExtras(state);renderUpcomingEvents(state);renderDayDetails(state);state.setStatus?.("Location suggestion removed ✓");});
  });

  container.querySelectorAll("[data-calendar-event]").forEach(btn=>{
    if(btn.dataset.wired) return;
    btn.dataset.wired="1";
    btn.addEventListener("click",()=>{
      const event=state.events.find(x=>String(x.id)===btn.dataset.calendarEvent);
      if(event) exportEventToCalendar(event);
    });
  });

  container.querySelectorAll("[data-edit-event]").forEach(btn=>{
    if(btn.dataset.wired) return;
    btn.dataset.wired="1";
    btn.addEventListener("click",()=>{
      const event=state.events.find(x=>String(x.id)===btn.dataset.editEvent);
      if(event) openEventDialog(state,event,event.day);
    });
  });

  container.querySelectorAll("[data-plan-note-form]").forEach(form=>{
    if(form.dataset.wired) return;
    form.dataset.wired="1";
    form.addEventListener("submit",async e=>{
      e.preventDefault();
      const eventId=Number(form.dataset.planNoteForm);
      const input=form.querySelector('input[name="planNote"]');
      const body=input?.value.trim()||"";
      if(!body) return;
      const button=form.querySelector('button[type="submit"]');
      button.disabled=true;
      const {error}=await state.supabase.rpc("add_event_plan_note",{p_event_id:eventId,p_body:body});
      button.disabled=false;
      if(error) return state.setStatus?.(error.message,true);
      input.value="";
      await refreshExtras(state);
      renderUpcomingEvents(state);
      renderDayDetails(state);
      state.setStatus?.("Note added ✓");
    });
  });

  container.querySelectorAll("[data-delete-plan-note]").forEach(btn=>{
    if(btn.dataset.wired) return;
    btn.dataset.wired="1";
    btn.addEventListener("click",async()=>{
      const noteId=Number(btn.dataset.deletePlanNote);
      const {error}=await state.supabase.rpc("delete_event_plan_note",{p_note_id:noteId});
      if(error) return state.setStatus?.(error.message,true);
      await refreshExtras(state);
      renderUpcomingEvents(state);
      renderDayDetails(state);
      state.setStatus?.("Note removed.");
    });
  });

  container.querySelectorAll("[data-rsvp-event]").forEach(btn=>{
    if(btn.dataset.wired) return;
    btn.dataset.wired="1";
    btn.addEventListener("click",async()=>{
      const eventId=Number(btn.dataset.rsvpEvent);
      const current=rsvpSummary(state,eventId).my;
      const requested=btn.dataset.rsvpStatus;
      const status=current===requested?"clear":requested;
      btn.disabled=true;
      const {error}=await state.supabase.rpc("save_event_rsvp",{p_event_id:eventId,p_status:status});
      btn.disabled=false;
      if(error) return state.setStatus?.(error.message,true);
      await refreshExtras(state);
      renderUpcomingEvents(state);
      renderDayDetails(state);
      renderDashboard(state);
    });
  });
}

function renderUpcomingEvents(state) {
  const holder=$("#upcomingEvents");
  if(!holder) return;
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  const allPlans=activeCircleEvents(state);const future=allPlans.filter(x=>x.day>=today).sort((a,b)=>a.day.localeCompare(b.day)||(a.start_min??9999)-(b.start_min??9999));const past=allPlans.filter(x=>x.day<today).sort((a,b)=>b.day.localeCompare(a.day)||(b.start_min??0)-(a.start_min??0));const upcoming=[...future,...past];

  holder.innerHTML=upcoming.length
    ? upcoming.map(event=>eventCardHtml(state,event,false,true)).join("")
    : `<p class="subtle">No plans yet. When you find a good free day, turn it into something to look forward to.</p>`;

  wireEventCardActions(state,holder);
}
function wireEventDialog(state) {
  $("#cancelEvent").addEventListener("click",()=>$("#eventDialog").close());

  $("#planTypeGrid")?.querySelectorAll("[data-plan-category]").forEach(btn=>btn.addEventListener("click",()=>{
    $("#eventCategory").value=btn.dataset.planCategory;
    $("#planTypeGrid").querySelectorAll(".plan-type-btn").forEach(x=>x.classList.toggle("active",x===btn));
    if(!$("#eventTitle").value.trim() && btn.dataset.defaultTitle) $("#eventTitle").value=btn.dataset.defaultTitle;
  }));

  $("#eventForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const title=$("#eventTitle").value.trim();
    if(!title) return setMsg($("#eventMsg"),"Enter an event title.",true);

    const startMin=$("#eventTime").value ? timeToMinutes($("#eventTime").value) : null;
    const finish=$("#eventEndTime").value?timeToMinutes($("#eventEndTime").value):null;
    const endMin=finish===null?null:finish+(finish<=startMin?1440:0);
    const timeZone=$("#eventTimeZone").value.trim();
    if(finish!==null&&startMin===null)return setMsg($("#eventMsg"),"Choose a start time before an end time.",true);
    try{if(startMin!==null)planCalendarRange({day:$("#eventDate").value,start_min:startMin,end_min:endMin,time_zone:timeZone});}catch(error){return setMsg($("#eventMsg"),error.message,true);}
    const save=$("#saveEvent");
    save.disabled=true;
    setMsg($("#eventMsg"),"Saving…");

    const {data,error}=await state.supabase.rpc("save_circle_event_v14",{
      p_event_id:state.editEventId||null,
      p_circle_id:$("#eventCircle").value,
      p_day:$("#eventDate").value,
      p_title:title,
      p_start_min:startMin,
      p_end_min:endMin,
      p_time_zone:timeZone,
      p_location:$("#eventLocation").value.trim()||null,
      p_note:$("#eventNote").value.trim()||null,
      p_category:$("#eventCategory").value
    });

    save.disabled=false;
    if(error) return setMsg($("#eventMsg"),error.message,true);

    const savedLocation=$("#eventLocation").value.trim();
    if(savedLocation) localStorage.setItem(`lastEventLocation:${state.me.group_id}`,savedLocation);
    await refreshExtras(state);
    $("#eventDialog").close();
    state.setStatus(state.editEventId?"Plan updated ✓":"Plan created ✓");
    renderRotaCalendar(state);
    renderUpcomingEvents(state);
    renderDashboard(state);
  });

  $("#deleteEventBtn").addEventListener("click",async()=>{
    if(!state.editEventId) return;
    if(!window.confirm("Delete this plan?")) return;

    const {error}=await state.supabase.rpc("delete_group_event",{p_event_id:state.editEventId});
    if(error) return setMsg($("#eventMsg"),error.message,true);

    await refreshExtras(state);
    $("#eventDialog").close();
    state.setStatus("Plan deleted.");
    renderRotaCalendar(state);
    renderUpcomingEvents(state);
    renderDashboard(state);
  });
}

function openEventDialogFromMeetup(state,meetup){
  openEventDialog(state,null,meetup.day);
  const startMin=Number.isInteger(meetup.startMin)?meetup.startMin:(Number.isInteger(meetup.minute)?meetup.minute:timeToMinutes(meetup.time));
  const endMin=Number.isInteger(meetup.endMin)?meetup.endMin:null;
  $("#eventTitle").value=meetup.name||"Get together";
  $("#eventTime").value=Number.isInteger(startMin)?minutesToInputTime(startMin):"";
  $("#eventEndTime").value=Number.isInteger(endMin)?minutesToInputTime(endMin%1440):"";
  $("#eventCategory").value=(meetup.name||"").toLowerCase()==="dinner"?"dinner":(meetup.name||"").toLowerCase()==="breakfast"?"breakfast":"coffee";
  $("#planTypeGrid")?.querySelectorAll(".plan-type-btn").forEach(btn=>btn.classList.toggle("active",btn.dataset.planCategory===$("#eventCategory").value));
  if(Number.isInteger(startMin)&&Number.isInteger(endMin)){
    const range=windowTimeLabel(startMin,endMin);
    $("#eventNote").value=`Suggested shared window: ${range}`;
  }
  $("#eventLocation").focus();
}

function openEventDialog(state,event=null,defaultDay=null) {
  state.editEventId=event?.id||null;
  if(!$("#eventEndTime"))$("#eventTime").closest("label").insertAdjacentHTML("afterend",'<label class="field"><span>Ends (earlier time means next day)</span><input class="input" id="eventEndTime" type="time"></label><label class="field"><span>Time zone</span><input class="input" id="eventTimeZone" required placeholder="Europe/London"></label>');
  $("#eventEndTime").value=Number.isInteger(event?.end_min)?minutesToInputTime(event.end_min%1440):"";
  $("#eventTimeZone").value=event?.time_zone||Intl.DateTimeFormat().resolvedOptions().timeZone||"Europe/London";
  $("#eventDialogTitle").textContent=event?"Edit plan":"Make a plan";
  $("#eventCategory").value=event?.category||"other";
  if($("#eventCircle")) $("#eventCircle").value=event?.circle_id||state.activeSharedCircleId||joinedSharedCircles(state)[0]?.id||"";
  $("#planTypeGrid")?.querySelectorAll(".plan-type-btn").forEach(btn=>btn.classList.toggle("active",btn.dataset.planCategory===$("#eventCategory").value));
  $("#eventTitle").value=event?.title||"";
  $("#eventDate").value=event?.day||defaultDay||dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  $("#eventTime").value=Number.isInteger(event?.start_min)?minutesToInputTime(event.start_min):"";
  $("#eventLocation").value=event?.location||localStorage.getItem(`lastEventLocation:${state.me.group_id}`)||"";
  $("#eventNote").value=event?.note||"";
  $("#deleteEventBtn").hidden=!event||!canEditEvent(state,event);
  setMsg($("#eventMsg"),"");
  $("#eventDialog").showModal();
}

async function refreshExtras(state){
  await refreshAvailability(state);
  const [overridesRes,eventsRes,rsvpsRes,personalCirclesRes,circleDefsRes,eventNotesRes,compareSetsRes,locationOptionsRes,locationVotesRes,circlesRes,membershipsRes,joinRequestsRes]=await Promise.all([
    state.supabase.from("meal_availability_overrides").select("id, member_id, day, meal, status, note").eq("group_id",state.me.group_id),
    state.supabase.from("group_events").select("id, circle_id, title, day, start_min, end_min, time_zone, location, note, category, created_by_member_id, created_at, updated_at").eq("group_id",state.me.group_id).order("day").order("start_min"),
    state.supabase.from("event_rsvps").select("id, event_id, member_id, status, updated_at").eq("group_id",state.me.group_id),
    state.supabase.from("personal_member_circles").select("target_member_id,circle_key").eq("group_id",state.me.group_id),
    state.supabase.from("personal_circle_defs").select("circle_key,label,icon,created_at").eq("group_id",state.me.group_id).order("created_at"),
    state.supabase.from("event_plan_notes").select("id,event_id,member_id,body,created_at").eq("group_id",state.me.group_id).order("created_at"),
    Promise.resolve({data:[],error:null}),
    state.supabase.from("event_location_options").select("id,event_id,label,created_by_member_id,created_at").eq("group_id",state.me.group_id).order("created_at"),
    state.supabase.from("event_location_votes").select("id,event_id,option_id,member_id,created_at").eq("group_id",state.me.group_id),
    state.supabase.rpc("get_shared_circles_v13"),state.supabase.rpc("get_shared_circle_memberships_v13"),state.supabase.rpc("get_join_requests_v13")
  ]);
  for(const r of [overridesRes,eventsRes,rsvpsRes,personalCirclesRes,circleDefsRes,eventNotesRes,compareSetsRes,locationOptionsRes,locationVotesRes,circlesRes,membershipsRes]) if(r.error) throw r.error;
  state.mealOverrides=overridesRes.data||[];state.events=eventsRes.data||[];state.eventRsvps=rsvpsRes.data||[];state.personalCircles=personalCirclesRes.data||[];state.circleDefs=circleDefsRes.data||[];state.eventNotes=eventNotesRes.data||[];state.compareSets=compareSetsRes.data||[];state.eventLocationOptions=locationOptionsRes.data||[];state.eventLocationVotes=locationVotesRes.data||[];
  state.sharedCircles=circlesRes.data||[];state.sharedCircleMemberships=membershipsRes.data||[];state.joinRequests=joinRequestsRes.error?[]:(joinRequestsRes.data||[]);
  if(!joinedSharedCircles(state).some(x=>x.id===state.activeSharedCircleId)) state.activeSharedCircleId=joinedSharedCircles(state)[0]?.id||null;
  await refreshCircleSocial(state);saveOfflineSnapshot(state);
}

function wireScheduleDialog(state) {
  const dialog=$("#scheduleDialog"), form=$("#scheduleForm");
  form.querySelectorAll('input[name="entryType"]').forEach(r=>r.addEventListener("change",()=>{$("#shiftTimeFields").hidden=!(r.checked&&r.value==="shift");}));
  $("#repeatWeekly").addEventListener("change",()=>{$("#repeatWeeksField").hidden=!$("#repeatWeekly").checked;});
  $("#cancelSchedule").addEventListener("click",()=>dialog.close());

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const type=form.querySelector('input[name="entryType"]:checked')?.value||"off";
    const save=$("#saveSchedule"); save.disabled=true; setMsg($("#dialogMsg"),"Saving…");

    if(type==="clear"){
      const {error}=await state.supabase.rpc("clear_schedule_entry",{p_member_id:state.editMemberId,p_day:state.editDate});
      if(error){save.disabled=false;return setMsg($("#dialogMsg"),error.message,true);}
    }else{
      let start=null,end=null,raw=null;
      if(type==="shift"){
        start=timeToMinutes($("#shiftStart").value); end=timeToMinutes($("#shiftEnd").value);
        if(start===null||end===null){save.disabled=false;return setMsg($("#dialogMsg"),"Enter both shift times.",true);}
        raw=`${minutesToCompact(start)}-${minutesToCompact(end)}`;
      }
      const {error}=await state.supabase.rpc("save_schedule_entry",{
        p_member_id:state.editMemberId,p_day:state.editDate,p_entry_type:type,
        p_note:$("#scheduleNote").value.trim()||null,p_start_min:start,p_end_min:end,p_raw_value:raw,
        p_repeat_weeks:$("#repeatWeekly").checked?clampInt($("#repeatWeeks").value,2,12,4):1
      });
      if(error){save.disabled=false;return setMsg($("#dialogMsg"),error.message,true);}
    }
    save.disabled=false; await refreshRotaRows(state); dialog.close(); state.setStatus("Rota updated."); refreshAllScheduleViews(state);
  });
}

function openScheduleDialog(state,member,day) {
  if(!canEditMember(state,member.id)) return;
  state.editMemberId=member.id; state.editDate=day;
  const e=entryFor(state,member.id,day);
  $("#dialogDate").textContent=prettyDate(day); $("#dialogPerson").textContent=`Editing: ${member.name}`;
  $("#scheduleNote").value=e?.note||""; $("#repeatWeekly").checked=false; $("#repeatWeeksField").hidden=true; $("#repeatWeeks").value=4;
  let type=e?.entry_type||"clear"; if(!["off","shift","partial","busy"].includes(type)) type="clear";
  const radio=document.querySelector(`#scheduleDialog input[name="entryType"][value="${type}"]`); if(radio) radio.checked=true;
  $("#shiftTimeFields").hidden=type!=="shift";
  $("#shiftStart").value=e?.entry_type==="shift"&&Number.isInteger(e.shift_start_min)?minutesToInputTime(e.shift_start_min):"08:00";
  $("#shiftEnd").value=e?.entry_type==="shift"&&Number.isInteger(e.shift_end_min)?minutesToInputTime(e.shift_end_min):"17:00";
  setMsg($("#dialogMsg"),""); $("#scheduleDialog").showModal();
}

async function refreshRotaRows(state) {
  await refreshAvailability(state);
  const {data,error}=await state.supabase.rpc("get_group_schedule_visible_v14",scheduleQueryRange(state));
  if(error) throw error;
  state.daysOff=(data||[]).map(x=>({...x,note:x.note||"",source:x.source||"manual",import_file_name:x.import_file_name||"",
    entry_type:x.entry_type||(x.availability_type==="off"?"off":"partial"),
    shift_start_min:Number.isInteger(x.shift_start_min)?x.shift_start_min:null,
    shift_end_min:Number.isInteger(x.shift_end_min)?x.shift_end_min:null,raw_value:x.raw_value||""}));
  state.lastSyncedAt=new Date().toISOString();
  saveOfflineSnapshot(state);
  updateLastSyncedLabel(state);
}

let pdfJsPromise=null;
async function loadPdfJs(){
  if(!pdfJsPromise) pdfJsPromise=import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs").then(lib=>{
    lib.GlobalWorkerOptions.workerSrc="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs"; return lib;
  });
  return pdfJsPromise;
}

function wireFullRotaImport(state) {
  const fileInput=$("#rotaPdfFile"), preview=$("#rotaMappingPreview"), holder=$("#rotaMappings"), apply=$("#applyRotaImport");
  state.fullRotaAnalysis=null;

  $("#analyseRotaPdf").addEventListener("click",async()=>{
    const file=fileInput.files?.[0]; if(!file) return setMsg($("#rotaImportStatus"),"Choose a PDF first.",true);
    const btn=$("#analyseRotaPdf"); btn.disabled=true; preview.hidden=true; setMsg($("#rotaImportStatus"),"Reading whole rota locally…");
    try{
      const a=await analyseWholeRotaPdf(file,parseOffKeywords($("#rotaOffCodes").value)); state.fullRotaAnalysis=a;
      if(!a.headers.length||!a.entries.length) return setMsg($("#rotaImportStatus"),"Could not recognise DATE / DAY / staff columns.",true);
      $("#rotaPreviewTitle").textContent=`${a.headers.length} staff columns · ${a.dateCount} dates`;
      $("#rotaPreviewText").textContent=`${prettyDate(a.fromDate)} to ${prettyDate(a.toDate)} · ${file.name}`;
      const allowed=state.me.is_owner?workingMembers(state):workingMembers(state).filter(x=>x.id===state.me.id);
      holder.innerHTML=a.headers.map(name=>{
        const auto=bestRotaMemberMatch(name,allowed);
        return `<div class="mapping-row"><div><strong>${escapeHtml(name)}</strong><div class="subtle">${a.entries.filter(x=>x.pdfName===name).length} entries</div></div>
          <select class="select rota-map-select" data-pdf-name="${escapeAttr(name)}"><option value="">Do not import</option>${allowed.map(m=>`<option value="${m.id}" ${auto?.id===m.id?"selected":""}>${escapeHtml(m.name)}</option>`).join("")}</select></div>`;
      }).join("");
      const update=()=>{
        const selects=[...holder.querySelectorAll(".rota-map-select")].filter(x=>x.value), dup=findDuplicateValues(selects.map(x=>x.value));
        $("#rotaMappingSummary").textContent=dup.length?"Fix duplicate member mappings.":`${selects.length} column${selects.length===1?"":"s"} mapped`;
        apply.disabled=!selects.length||!!dup.length;
      };
      holder.querySelectorAll(".rota-map-select").forEach(x=>x.addEventListener("change",update)); update(); preview.hidden=false;
      setMsg($("#rotaImportStatus"),"Check the name mappings, then import.");
    }catch(err){console.error(err);setMsg($("#rotaImportStatus"),`Could not read PDF: ${err?.message||"unknown error"}`,true);}
    finally{btn.disabled=false;}
  });

  apply.addEventListener("click",async()=>{
    const a=state.fullRotaAnalysis; if(!a) return;
    const mapping=new Map([...holder.querySelectorAll(".rota-map-select")].filter(x=>x.value).map(x=>[x.dataset.pdfName,x.value]));
    const memberIds=[...new Set(mapping.values())];
    const entries=a.entries.filter(x=>mapping.has(x.pdfName)).map(x=>({
      member_id:mapping.get(x.pdfName),day:x.day,entry_type:x.entryType,start_min:x.startMin,end_min:x.endMin,raw_value:x.rawValue
    }));
    if(!await confirmImportChanges(state,entries,$("#rotaImportStatus")))return;
    apply.disabled=true; setMsg($("#rotaImportStatus"),`Saving ${entries.length} entries…`);
    const {data,error}=await state.supabase.rpc("apply_full_rota_import",{p_entries:entries,p_member_ids:memberIds,p_from_date:a.fromDate,p_to_date:a.toDate,p_file_name:a.fileName});
    apply.disabled=false; if(error) return setMsg($("#rotaImportStatus"),error.message,true);
    await refreshRotaRows(state); refreshAllScheduleViews(state); setMsg($("#rotaImportStatus"),`Done — ${data??entries.length} PDF entries saved. Manual overrides kept.`);
  });
}



let sheetJsPromise=null;
async function loadSheetJs(){
  if(window.XLSX) return window.XLSX;
  if(!sheetJsPromise){
    sheetJsPromise=new Promise((resolve,reject)=>{
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload=()=>resolve(window.XLSX);
      s.onerror=()=>reject(new Error("Could not load spreadsheet reader. Check your connection."));
      document.head.appendChild(s);
    });
  }
  return sheetJsPromise;
}

function normalizeSheetCell(v){
  if(v===null||v===undefined) return "";
  return String(v).trim();
}

async function analyseRotaSpreadsheet(file,offKeywords){
  const XLSX=await loadSheetJs();
  const bytes=await file.arrayBuffer();
  const wb=XLSX.read(bytes,{type:"array",cellDates:true});
  if(!wb.SheetNames.length) throw new Error("No worksheet found.");
  const ws=wb.Sheets[wb.SheetNames[0]];
  const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:""}).map(row=>row.map(normalizeSheetCell));

  let bestDateCol=-1,bestDateCount=0;
  const maxCols=Math.max(0,...rows.map(r=>r.length));
  for(let c=0;c<maxCols;c++){
    let count=0;
    for(const row of rows.slice(0,250)) if(parseRotaDate(row[c])) count++;
    if(count>bestDateCount){bestDateCount=count;bestDateCol=c;}
  }
  if(bestDateCol<0||bestDateCount<2) throw new Error("Could not find a date column.");

  const firstDataRow=rows.findIndex(row=>parseRotaDate(row[bestDateCol]));
  if(firstDataRow<0) throw new Error("Could not find dated rota rows.");

  let headerRow=Math.max(0,firstDataRow-1);
  let bestHeaderScore=-1;
  for(let r=Math.max(0,firstDataRow-4);r<firstDataRow;r++){
    const score=rows[r].filter((v,c)=>c!==bestDateCol&&v).length;
    if(score>bestHeaderScore){bestHeaderScore=score;headerRow=r;}
  }

  const header=rows[headerRow]||[];
  const headers=[];
  for(let c=0;c<maxCols;c++){
    if(c===bestDateCol) continue;
    const name=normalizeSheetCell(header[c]);
    if(!name) continue;
    if(/^(DAY|DATE|WEEK|WEEKDAY)$/i.test(name)) continue;
    headers.push({name,col:c});
  }
  if(!headers.length) throw new Error("Could not find staff columns above the dated rows.");

  const entries=[];
  const dateSet=new Set();
  for(let r=firstDataRow;r<rows.length;r++){
    const day=parseRotaDate(rows[r][bestDateCol]);
    if(!day) continue;
    dateSet.add(day);
    for(const h of headers){
      const raw=normalizeSheetCell(rows[r][h.col]);
      if(!raw) continue; // blank remains unknown
      const cl=classifyRotaValue(raw,offKeywords);
      entries.push({sheetName:h.name,day,rawValue:raw.slice(0,120),entryType:cl.type,startMin:cl.startMin,endMin:cl.endMin});
    }
  }
  const dates=[...dateSet].sort();
  return {
    fileName:file.name.slice(0,200),
    sheetName:wb.SheetNames[0],
    headers:headers.map(x=>x.name),
    entries,
    dateCount:dates.length,
    fromDate:dates[0]||null,
    toDate:dates.at(-1)||null
  };
}

function wireSpreadsheetRotaImport(state){
  const fileInput=$("#rotaSheetFile"),preview=$("#rotaSheetPreview"),holder=$("#rotaSheetMappings"),apply=$("#applyRotaSheet");
  if(!fileInput||!preview||!holder||!apply) return;
  state.sheetRotaAnalysis=null;

  $("#analyseRotaSheet")?.addEventListener("click",async()=>{
    const file=fileInput.files?.[0];
    if(!file) return setMsg($("#rotaSheetStatus"),"Choose an Excel or CSV file first.",true);
    const btn=$("#analyseRotaSheet");btn.disabled=true;preview.hidden=true;setMsg($("#rotaSheetStatus"),"Reading spreadsheet locally…");
    try{
      const a=await analyseRotaSpreadsheet(file,parseOffKeywords($("#rotaOffCodes").value));
      state.sheetRotaAnalysis=a;
      $("#rotaSheetPreviewTitle").textContent=`${a.headers.length} staff columns · ${a.dateCount} dates`;
      $("#rotaSheetPreviewText").textContent=`${a.sheetName} · ${prettyDate(a.fromDate)} to ${prettyDate(a.toDate)}`;
      const allowed=state.me.is_owner?workingMembers(state):workingMembers(state).filter(x=>x.id===state.me.id);
      holder.innerHTML=a.headers.map(name=>{
        const auto=bestRotaMemberMatch(name,allowed);
        return `<div class="mapping-row"><div><strong>${escapeHtml(name)}</strong><div class="subtle">${a.entries.filter(x=>x.sheetName===name).length} entries</div></div>
          <select class="select sheet-map-select" data-sheet-name="${escapeAttr(name)}"><option value="">Do not import</option>${allowed.map(m=>`<option value="${m.id}" ${auto?.id===m.id?"selected":""}>${escapeHtml(m.name)}</option>`).join("")}</select></div>`;
      }).join("");
      const update=()=>{
        const selects=[...holder.querySelectorAll(".sheet-map-select")].filter(x=>x.value);
        const dup=findDuplicateValues(selects.map(x=>x.value));
        $("#rotaSheetSummary").textContent=dup.length?"Fix duplicate member mappings.":`${selects.length} column${selects.length===1?"":"s"} mapped`;
        apply.disabled=!selects.length||!!dup.length;
      };
      holder.querySelectorAll(".sheet-map-select").forEach(x=>x.addEventListener("change",update));
      update();preview.hidden=false;setMsg($("#rotaSheetStatus"),"Check mappings, then import.");
    }catch(error){
      console.error(error);setMsg($("#rotaSheetStatus"),error?.message||"Could not read spreadsheet.",true);
    }finally{btn.disabled=false;}
  });

  apply.addEventListener("click",async()=>{
    const a=state.sheetRotaAnalysis;if(!a)return;
    const mapping=new Map([...holder.querySelectorAll(".sheet-map-select")].filter(x=>x.value).map(x=>[x.dataset.sheetName,x.value]));
    const memberIds=[...new Set(mapping.values())];
    const entries=a.entries.filter(x=>mapping.has(x.sheetName)).map(x=>({
      member_id:mapping.get(x.sheetName),day:x.day,entry_type:x.entryType,start_min:x.startMin,end_min:x.endMin,raw_value:x.rawValue
    }));
    if(!entries.length) return setMsg($("#rotaSheetStatus"),"Nothing mapped to import.",true);
    if(!await confirmImportChanges(state,entries,$("#rotaSheetStatus")))return;
    apply.disabled=true;setMsg($("#rotaSheetStatus"),`Saving ${entries.length} entries…`);
    const {data,error}=await state.supabase.rpc("apply_full_rota_import",{p_entries:entries,p_member_ids:memberIds,p_from_date:a.fromDate,p_to_date:a.toDate,p_file_name:`Spreadsheet: ${a.fileName}`});
    apply.disabled=false;if(error)return setMsg($("#rotaSheetStatus"),error.message,true);
    await refreshRotaRows(state);refreshAllScheduleViews(state);
    setMsg($("#rotaSheetStatus"),`Done — ${data??entries.length} spreadsheet entries saved ✓`);
  });
}


async function compressImageForAi(file){
  const bmp=await createImageBitmap(file),max=1500,scale=Math.min(1,max/Math.max(bmp.width,bmp.height)),w=Math.round(bmp.width*scale),h=Math.round(bmp.height*scale),canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;canvas.getContext("2d").drawImage(bmp,0,0,w,h);const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",.75));const data=await blob.arrayBuffer();let binary="";const bytes=new Uint8Array(data);for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return {mime:"image/jpeg",data:btoa(binary)};
}
async function callAiRotaBackend(state,files){
  const {data:{session}}=await state.supabase.auth.getSession();if(!session)throw new Error("Session expired.");const images=[];if(files.length>5)throw new Error("Choose at most five screenshots; no files have been uploaded.");for(const f of files)images.push(await compressImageForAi(f));if(images.reduce((n,x)=>n+x.data.length,0)>4200000)throw new Error("These screenshots are too large together. Crop them or upload fewer images at once.");const r=await fetch("/api/ai-rota",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${session.access_token}`},body:JSON.stringify({images})});const body=await r.json();if(!r.ok)throw new Error(body?.error||"AI rota import failed.");return body;
}
function aiRotaCodes(a){return [...new Set((a?.people||[]).flatMap(p=>p.entries||[]).map(e=>String(e.code||"").trim()).filter(Boolean))].sort();}
function defaultAiCodeDef(state,code,a){
  const saved=shiftDefFor(state,code);if(saved)return {kind:saved.kind,start:saved.start_min,end:saved.end_min};const upper=String(code).toUpperCase();const explicit=(a.people||[]).flatMap(p=>p.entries||[]).find(e=>String(e.code).trim()===code&&e.explicit_start&&e.explicit_end);if(explicit)return {kind:"working",start:timeToMinutes(explicit.explicit_start),end:timeToMinutes(explicit.explicit_end)};if(/^(OFF|REST|REST DAY|ZERO|ZERO DAY)$/.test(upper))return {kind:"off",start:null,end:null};if(/(STUDY|EDT|DEVELOP|TEACH)/.test(upper))return {kind:"development",start:null,end:null};if(/(A\/L|ANNUAL|LEAVE)/.test(upper))return {kind:"leave",start:null,end:null};return {kind:"working",start:null,end:null};
}
function renderAiRotaReview(state){
  const a=state.aiRotaAnalysis,review=$("#aiRotaReview");if(!a||!review)return;review.hidden=false;$("#aiRotaWarnings").innerHTML=(a.warnings||[]).length?`<div class="notice"><strong>AI notes</strong><br>${(a.warnings||[]).map(escapeHtml).join("<br>")}</div>`:"";const allowed=state.me.is_owner?workingMembers(state):workingMembers(state).filter(x=>x.id===state.me.id);$("#aiPersonMappings").innerHTML=(a.people||[]).map((p,i)=>{const auto=bestRotaMemberMatch(p.name,allowed);return `<div class="mapping-row"><div><strong>${escapeHtml(p.name||`Person ${i+1}`)}</strong><small>${(p.entries||[]).length} dated cells</small></div><select class="select ai-person-map" data-ai-person="${i}"><option value="">Do not import</option>${allowed.map(m=>`<option value="${m.id}" ${auto?.id===m.id?"selected":""}>${escapeHtml(m.name)}</option>`).join("")}</select></div>`;}).join("");
  $("#aiShiftDefinitions").innerHTML=aiRotaCodes(a).map(code=>{const d=defaultAiCodeDef(state,code,a);return `<div class="ai-shift-code-row" data-ai-code="${escapeAttr(code)}"><strong>${escapeHtml(code)}</strong><select class="select ai-code-kind"><option value="working" ${d.kind==="working"?"selected":""}>Working shift</option><option value="off" ${d.kind==="off"?"selected":""}>OFF</option><option value="development" ${d.kind==="development"?"selected":""}>Study / Development</option><option value="leave" ${d.kind==="leave"?"selected":""}>Annual leave</option><option value="busy" ${d.kind==="busy"?"selected":""}>Other busy</option></select><input class="input ai-code-start" type="time" value="${Number.isInteger(d.start)?minutesToInputTime(d.start):""}" aria-label="Start time"><input class="input ai-code-end" type="time" value="${Number.isInteger(d.end)?minutesToInputTime(d.end):""}" aria-label="Finish time"><label class="shift-save-check"><input type="checkbox" class="ai-code-save" checked> Remember</label></div>`;}).join("");
  const rows=(a.people||[]).flatMap((p,pi)=>(p.entries||[]).map((e,ei)=>({p,pi,e,ei}))).sort((x,y)=>x.e.date.localeCompare(y.e.date));$("#aiRotaEntries").innerHTML=rows.map(x=>`<label class="ai-entry-row confidence-${x.e.confidence}"><input type="checkbox" class="ai-entry-confirm" data-ai-person="${x.pi}" data-ai-entry="${x.ei}" ${x.e.confidence==="low"?"":"checked"}><span>${escapeHtml(x.e.date)}</span><span>${escapeHtml(x.p.name||"Person")}</span><strong>${escapeHtml(x.e.code||"blank")}</strong><small>${escapeHtml(x.e.confidence)} confidence</small></label>`).join("");
  document.querySelectorAll(".ai-code-kind").forEach(sel=>sel.addEventListener("change",()=>{const row=sel.closest(".ai-shift-code-row"),working=sel.value==="working";row.querySelector(".ai-code-start").disabled=!working;row.querySelector(".ai-code-end").disabled=!working;}));document.querySelectorAll(".ai-code-kind").forEach(x=>x.dispatchEvent(new Event("change")));
}
function readAiDefinitions(){const defs=new Map();document.querySelectorAll(".ai-shift-code-row").forEach(row=>{const code=row.dataset.aiCode,kind=row.querySelector(".ai-code-kind").value,start=timeToMinutes(row.querySelector(".ai-code-start").value),end=timeToMinutes(row.querySelector(".ai-code-end").value);defs.set(code,{code,kind,start,end,remember:row.querySelector(".ai-code-save").checked});});return defs;}
async function confirmImportChanges(state,entries,target){
  try{
    importChangeSummary(entries,state.daysOff);
    const {data:summary,error}=await state.supabase.rpc("preview_rota_import_v14",{p_entries:entries});if(error)throw error;
    return confirm(`Save rota changes?\n${summary.added} new · ${summary.replaced} replaced · ${summary.preserved} manual entries preserved.\nUnselected dates stay unchanged.`);
  }catch(error){setMsg(target,error.message,true);return false;}
}
function buildAiImportRows(state){
  const a=state.aiRotaAnalysis,defs=readAiDefinitions(),maps=new Map([...document.querySelectorAll(".ai-person-map")].map(x=>[Number(x.dataset.aiPerson),x.value]).filter(x=>x[1])),chosen=new Set([...document.querySelectorAll(".ai-entry-confirm:checked")].map(x=>`${x.dataset.aiPerson}:${x.dataset.aiEntry}`)),rows=[];
  for(let pi=0;pi<(a.people||[]).length;pi++){const mid=maps.get(pi);if(!mid)continue;for(let ei=0;ei<(a.people[pi].entries||[]).length;ei++){if(!chosen.has(`${pi}:${ei}`))continue;const e=a.people[pi].entries[ei],d=defs.get(String(e.code||"").trim());if(!d)continue;if(d.kind==="working"&&(!Number.isInteger(d.start)||!Number.isInteger(d.end)))throw new Error(`Add start and finish times for ${e.code}.`);rows.push({member_id:mid,day:e.date,entry_type:d.kind==="working"?"shift":d.kind==="off"?"off":"busy",start_min:d.kind==="working"?d.start:null,end_min:d.kind==="working"?d.end:null,raw_value:d.kind==="leave"?`ANNUAL LEAVE (${e.code})`:d.kind==="development"?`DEVELOPMENT (${e.code})`:e.code||d.kind});}}
  importChangeSummary(rows,state.daysOff);
  return {rows,memberIds:[...new Set(rows.map(x=>x.member_id))],defs};
}
let jspdfPromise=null;async function loadJsPdf(){if(window.jspdf)return window.jspdf;if(!jspdfPromise)jspdfPromise=new Promise((resolve,reject)=>{const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";s.onload=()=>resolve(window.jspdf);s.onerror=()=>reject(new Error("Could not load PDF generator."));document.head.appendChild(s);});return jspdfPromise;}
async function generateAiRotaPdf(state){
  const {rows}=buildAiImportRows(state);if(!rows.length)throw new Error("Select confirmed rows first.");const {jsPDF}=await loadJsPdf(),doc=new jsPDF({unit:"mm",format:"a4"}),byMember=new Map();rows.forEach(r=>{if(!byMember.has(r.member_id))byMember.set(r.member_id,[]);byMember.get(r.member_id).push(r);});let page=0;for(const [mid,items] of byMember){if(page++)doc.addPage();const m=state.members.find(x=>x.id===mid),name=m?.name||"Rota";doc.setFontSize(17);doc.text(`${name} Rota - App Upload`,15,16);doc.setFontSize(9);doc.setFont("courier","bold");doc.text(`DATE        DAY   ${name}`,15,25);doc.setFont("courier","normal");let y=31;for(const r of items.sort((a,b)=>a.day.localeCompare(b.day))){if(y>282){doc.addPage();y=18;}const dt=new Date(`${r.day}T00:00:00Z`),dateTxt=`${r.day.slice(8,10)}/${r.day.slice(5,7)}/${r.day.slice(0,4)}`,dayTxt=new Intl.DateTimeFormat("en-GB",{weekday:"short",timeZone:"UTC"}).format(dt),shift=r.entry_type==="shift"?`${minutesToCompact(r.start_min)}-${minutesToCompact(r.end_min)}`:r.entry_type==="off"?"OFF":r.raw_value;doc.text(`${dateTxt}  ${dayTxt.padEnd(5)} ${shift}`,15,y);y+=5;}}
  doc.save(`Our-Days-Off-AI-Rota.pdf`);
}
async function saveAiShiftDefinitions(state,defs){
  for(const d of defs.values()){
    if(!d.remember||!d.code)continue;
    const {error}=await state.supabase.rpc("upsert_my_shift_definition_v13_3",{p_code:d.code,p_kind:d.kind,p_start_min:d.kind==="working"?d.start:null,p_end_min:d.kind==="working"?d.end:null});
    if(error)throw error;
  }
  const {data,error}=await state.supabase.rpc("get_my_shift_definitions_v13_3");if(error)throw error;
  state.shiftDefinitions=data||[];renderShiftDictionary(state);wireShiftDictionary(state);
}
function wireAiRotaImport(state){
  $("#readRotaWithAi")?.addEventListener("click",async()=>{const files=[...($("#aiRotaImages").files||[])];if(!files.length)return setMsg($("#aiRotaStatus"),"Choose one or more screenshots.",true);const btn=$("#readRotaWithAi");btn.disabled=true;setMsg($("#aiRotaStatus"),"Reading screenshots with AI…");try{state.aiRotaAnalysis=await callAiRotaBackend(state,files);renderAiRotaReview(state);setMsg($("#aiRotaStatus"),"AI reading complete — confirm mappings, shift meanings and low-confidence rows.");}catch(e){setMsg($("#aiRotaStatus"),e.message,true);}finally{btn.disabled=false;}});
  $("#applyAiRota")?.addEventListener("click",async()=>{try{const {rows,memberIds,defs}=buildAiImportRows(state);if(!rows.length)throw new Error("No confirmed rows selected.");if(!await confirmImportChanges(state,rows,$("#aiRotaStatus")))return;const dates=rows.map(x=>x.day).sort();const btn=$("#applyAiRota");btn.disabled=true;await saveAiShiftDefinitions(state,defs);const {data:savedCount,error}=await state.supabase.rpc("apply_full_rota_import",{p_entries:rows,p_member_ids:memberIds,p_from_date:dates[0],p_to_date:dates.at(-1),p_file_name:"AI rota screenshots"});btn.disabled=false;if(error)throw error;await refreshRotaRows(state);refreshAllScheduleViews(state);setMsg($("#aiRotaStatus"),`Saved ${savedCount} rota entries; ${rows.length-Number(savedCount)} manual entries preserved ✓`);}catch(e){$("#applyAiRota").disabled=false;setMsg($("#aiRotaStatus"),e.message||String(e),true);}});
  $("#downloadAiRotaPdf")?.addEventListener("click",async()=>{try{await generateAiRotaPdf(state);}catch(e){setMsg($("#aiRotaStatus"),e.message,true);}});
}

async function loadTesseractJs(){
  if(window.Tesseract)return window.Tesseract;
  await new Promise((resolve,reject)=>{
    const s=document.createElement("script");
    s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload=resolve;s.onerror=()=>reject(new Error("Could not load OCR. Check your connection."));
    document.head.appendChild(s);
  });
  return window.Tesseract;
}

async function preprocessRotaImage(file){
  const bitmap=await createImageBitmap(file);
  const max=2400;
  let scale=Math.min(max/bitmap.width,max/bitmap.height);
  if(scale>1.8) scale=1.8;
  if(scale<1) scale=1;
  const w=Math.max(1,Math.round(bitmap.width*scale));
  const h=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement("canvas");
  canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0,w,h);
  const image=ctx.getImageData(0,0,w,h),d=image.data;

  // Grayscale + stronger contrast improves screenshots of spreadsheet-like rotas.
  for(let i=0;i<d.length;i+=4){
    const g=Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2]);
    const c=Math.max(0,Math.min(255,(g-128)*1.45+128));
    d[i]=d[i+1]=d[i+2]=c;
  }
  ctx.putImageData(image,0,0);
  return await new Promise(resolve=>canvas.toBlob(resolve,"image/png",1));
}

function normalizeOcrRotaText(text){
  return String(text||"")
    .replace(/[–—]/g,"-")
    .replace(/\bZERO HOURS?\b/gi,"OFF").replace(/\bZERO\b/gi,"OFF")
    .replace(/\bNIGHTS?\b/gi,"2000-0800")
    .replace(/\bDAY\s*XH\b/gi,"0800-1615")
    .replace(/\bST\s*16\b/gi,"0800-1615");
}

function splitOcrColumns(line){
  const clean=String(line||"").trim();
  if(clean.includes("|")) return clean.split("|").map(x=>x.trim());
  if(clean.includes("\t")) return clean.split(/\t+/).map(x=>x.trim());
  return clean.split(/\s{2,}/).map(x=>x.trim()).filter(Boolean);
}

function parseImageSingleText(text,offKeywords){
  const lines=normalizeOcrRotaText(text).split(/\r?\n/).map(x=>x.trim()).filter(Boolean),entries=[];
  for(let i=0;i<lines.length;i++){
    const dm=lines[i].match(/(\d{1,2}[\/.-]\d{1,2}[\/.-](?:\d{2}|\d{4}))/);
    if(!dm)continue;
    const day=parseRotaDate(dm[1]);if(!day)continue;
    let raw=lines[i].replace(dm[1],"").replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b/ig," ").trim();
    if(!raw&&i+1<lines.length&&!parseRotaDate(lines[i+1]))raw=lines[i+1].trim();
    if(!raw)continue;
    const cl=classifyRotaValue(raw,offKeywords);
    entries.push({day,rawValue:raw.slice(0,120),entryType:cl.type,startMin:cl.startMin,endMin:cl.endMin,confidence:"confirmed"});
  }
  const seen=new Set();
  return {mode:"single",headers:[],entries:entries.filter(x=>!seen.has(x.day)&&seen.add(x.day)).sort((a,b)=>a.day.localeCompare(b.day)),uncertainRows:[]};
}

function parseImageGridText(text,offKeywords){
  const lines=normalizeOcrRotaText(text).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const firstDateIdx=lines.findIndex(line=>/(\d{1,2}[\/.-]\d{1,2}[\/.-](?:\d{2}|\d{4}))/.test(line));
  if(firstDateIdx<0) return {mode:"grid",headers:[],entries:[],uncertainRows:["No dated row detected."]};

  let headerLine="";
  for(let i=Math.max(0,firstDateIdx-3);i<firstDateIdx;i++){
    if(splitOcrColumns(lines[i]).length>=2) headerLine=lines[i];
  }
  if(!headerLine&&firstDateIdx>0) headerLine=lines[firstDateIdx-1]||"";

  let headers=splitOcrColumns(headerLine)
    .filter(x=>x&&!/^(DATE|DAY|WEEK|WEEKDAY)$/i.test(x));

  // If OCR collapsed the header into single spaces, use simple one-word names as fallback.
  if(headers.length<2){
    headers=headerLine.split(/\s+/).filter(x=>x&&!/^(DATE|DAY|WEEK|WEEKDAY)$/i.test(x));
  }

  const entries=[],uncertainRows=[];
  for(let i=firstDateIdx;i<lines.length;i++){
    const dm=lines[i].match(/(\d{1,2}[\/.-]\d{1,2}[\/.-](?:\d{2}|\d{4}))/);
    if(!dm)continue;
    const day=parseRotaDate(dm[1]);if(!day)continue;

    let rest=lines[i].replace(dm[1],"").replace(/^\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b/i,"").trim();
    const cells=splitOcrColumns(rest);

    if(headers.length<2||cells.length!==headers.length){
      uncertainRows.push(`${dm[1]} — expected ${headers.length||"?"} cells, found ${cells.length}.`);
      continue; // never auto-import an uncertain row
    }

    cells.forEach((raw,idx)=>{
      if(!raw||raw==="-"||raw==="—") return; // blank/unknown
      const cl=classifyRotaValue(raw,offKeywords);
      entries.push({pdfName:headers[idx],day,rawValue:raw.slice(0,120),entryType:cl.type,startMin:cl.startMin,endMin:cl.endMin,confidence:"confirmed"});
    });
  }
  return {mode:"grid",headers,entries,uncertainRows};
}

function analyseImageRotaText(text,mode,offKeywords){
  if(mode==="single") return parseImageSingleText(text,offKeywords);
  if(mode==="grid") return parseImageGridText(text,offKeywords);
  const grid=parseImageGridText(text,offKeywords);
  if(grid.headers.length>=2&&grid.entries.length>=2) return grid;
  return parseImageSingleText(text,offKeywords);
}

function renderImageRotaParsePreview(state){
  const a=state.imageRotaAnalysis||{mode:"single",entries:[],headers:[],uncertainRows:[]};
  const holder=$("#rotaImagePreviewText"),apply=$("#applyRotaImage"),mapHolder=$("#rotaImageMappings");
  if(!holder||!apply||!mapHolder)return;

  $("#rotaImageModeResult").textContent=a.mode==="grid"?"Detected: department grid":"Detected: one-person rota";
  $("#rotaImageConfidence").textContent=a.uncertainRows.length?`${a.uncertainRows.length} row${a.uncertainRows.length===1?"":"s"} need review`:"No uncertain rows";
  $("#rotaImageConfidence").className=a.uncertainRows.length?"ocr-confidence warn":"ocr-confidence good";

  if(a.mode==="grid"){
    $("#rotaImageMemberField").hidden=true;
    const allowed=state.me.is_owner?workingMembers(state):workingMembers(state).filter(x=>x.id===state.me.id);
    mapHolder.innerHTML=a.headers.map(name=>{
      const auto=bestRotaMemberMatch(name,allowed);
      return `<div class="mapping-row"><div><strong>${escapeHtml(name)}</strong><div class="subtle">${a.entries.filter(x=>x.pdfName===name).length} confirmed cells</div></div>
        <select class="select image-map-select" data-image-name="${escapeAttr(name)}"><option value="">Do not import</option>${allowed.map(m=>`<option value="${m.id}" ${auto?.id===m.id?"selected":""}>${escapeHtml(m.name)}</option>`).join("")}</select></div>`;
    }).join("");
    const update=()=>{
      const selects=[...mapHolder.querySelectorAll(".image-map-select")].filter(x=>x.value);
      const dup=findDuplicateValues(selects.map(x=>x.value));
      apply.disabled=!a.entries.length||!!a.uncertainRows.length||!selects.length||!!dup.length;
    };
    mapHolder.querySelectorAll(".image-map-select").forEach(x=>x.addEventListener("change",update));
    update();
  }else{
    $("#rotaImageMemberField").hidden=false;
    mapHolder.innerHTML="";
    apply.disabled=!a.entries.length||!!a.uncertainRows.length;
  }

  const dates=[...new Set(a.entries.map(x=>x.day))].sort();
  const base=dates.length?`${a.entries.length} confirmed cells · ${prettyDate(dates[0])} to ${prettyDate(dates.at(-1))}`:"No confirmed rota rows yet.";
  holder.innerHTML=`${escapeHtml(base)}${a.uncertainRows.length?`<br><strong>Not imported until fixed:</strong> ${escapeHtml(a.uncertainRows.slice(0,6).join(" | "))}`:""}`;
}

function wireImageRotaImport(state){
  const fileInput=$("#rotaImageFile");
  if(!fileInput)return;
  state.imageRotaAnalysis=null;

  $("#rotaImageMode")?.addEventListener("change",()=>{
    $("#rotaImageMemberField").hidden=$("#rotaImageMode").value==="grid";
  });

  $("#readRotaImage")?.addEventListener("click",async()=>{
    const file=fileInput.files?.[0];
    if(!file)return setMsg($("#rotaImageStatus"),"Choose a screenshot/photo first.",true);
    const btn=$("#readRotaImage");btn.disabled=true;setMsg($("#rotaImageStatus"),"Cleaning image and reading rota locally…");
    try{
      const Tesseract=await loadTesseractJs();
      const cleanImage=await preprocessRotaImage(file);
      const result=await Tesseract.recognize(cleanImage,"eng",{
        logger:m=>{if(m.status==="recognizing text")setMsg($("#rotaImageStatus"),`Reading… ${Math.round((m.progress||0)*100)}%`);}
      });
      const text=normalizeOcrRotaText(result?.data?.text||"");
      $("#rotaImageText").value=text;
      $("#rotaImageReview").hidden=false;
      state.imageRotaAnalysis=analyseImageRotaText(text,$("#rotaImageMode").value,parseOffKeywords($("#rotaOffCodes").value));
      renderImageRotaParsePreview(state);
      setMsg($("#rotaImageStatus"),"OCR finished. Review anything uncertain before importing.");
    }catch(error){
      console.error(error);setMsg($("#rotaImageStatus"),error?.message||"Could not read image.",true);
    }finally{btn.disabled=false;}
  });

  $("#reparseRotaImage")?.addEventListener("click",()=>{
    state.imageRotaAnalysis=analyseImageRotaText($("#rotaImageText").value,$("#rotaImageMode").value,parseOffKeywords($("#rotaOffCodes").value));
    renderImageRotaParsePreview(state);
  });

  $("#applyRotaImage")?.addEventListener("click",async()=>{
    const a=state.imageRotaAnalysis;
    if(!a||!a.entries.length||a.uncertainRows.length) return setMsg($("#rotaImageStatus"),"Fix uncertain rows before importing.",true);

    let entries=[],memberIds=[];
    if(a.mode==="grid"){
      const mapHolder=$("#rotaImageMappings");
      const mapping=new Map([...mapHolder.querySelectorAll(".image-map-select")].filter(x=>x.value).map(x=>[x.dataset.imageName,x.value]));
      memberIds=[...new Set(mapping.values())];
      entries=a.entries.filter(x=>mapping.has(x.pdfName)).map(x=>({
        member_id:mapping.get(x.pdfName),day:x.day,entry_type:x.entryType,start_min:x.startMin,end_min:x.endMin,raw_value:x.rawValue
      }));
    }else{
      const memberId=$("#rotaImageMember").value;
      if(!memberId) return;
      memberIds=[memberId];
      entries=a.entries.map(x=>({member_id:memberId,day:x.day,entry_type:x.entryType,start_min:x.startMin,end_min:x.endMin,raw_value:x.rawValue}));
    }
    if(!entries.length) return setMsg($("#rotaImageStatus"),"Nothing mapped to import.",true);

    const dates=[...new Set(entries.map(x=>x.day))].sort();
    if(!await confirmImportChanges(state,entries,$("#rotaImageStatus")))return;
    const btn=$("#applyRotaImage");btn.disabled=true;setMsg($("#rotaImageStatus"),`Saving ${entries.length} confirmed cells…`);
    const {data,error}=await state.supabase.rpc("apply_full_rota_import",{
      p_entries:entries,p_member_ids:memberIds,p_from_date:dates[0],p_to_date:dates.at(-1),
      p_file_name:`Image: ${fileInput.files?.[0]?.name||"rota screenshot"}`
    });
    btn.disabled=false;if(error)return setMsg($("#rotaImageStatus"),error.message,true);
    await refreshRotaRows(state);refreshAllScheduleViews(state);
    setMsg($("#rotaImageStatus"),`Done — ${data??entries.length} confirmed image entries saved ✓`);
  });
}

async function analyseWholeRotaPdf(file,offKeywords) {
  const pdfjs=await loadPdfJs(), bytes=new Uint8Array(await file.arrayBuffer()), pdf=await pdfjs.getDocument({data:bytes}).promise;
  const entries=[],headers=[],headerSet=new Set();

  for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){
    const page=await pdf.getPage(pageNo), content=await page.getTextContent();
    const items=content.items.filter(i=>String(i.str||"").trim()).map(i=>({text:String(i.str).trim(),x:Number(i.transform?.[4]||0),y:Number(i.transform?.[5]||0),width:Math.max(0,Number(i.width||0))}));
    const lines=groupPdfItemsIntoLines(items,2.4);
    const header=lines.find(line=>{const u=line.items.map(x=>x.text.toUpperCase());return u.includes("DATE")&&u.includes("DAY");});
    if(!header) continue;
    const hi=[...header.items].sort((a,b)=>a.x-b.x), u=hi.map(x=>x.text.toUpperCase()), di=u.indexOf("DAY");
    if(di<0) continue;
    const cells=hi.slice(di+1); if(!cells.length) continue;
    cells.forEach(c=>{if(!headerSet.has(c.text)){headerSet.add(c.text);headers.push(c.text);}});
    const centers=cells.map(c=>c.x+c.width/2), gaps=centers.slice(1).map((x,i)=>x-centers[i]).filter(x=>x>2), gap=median(gaps)||40;
    const bounds=centers.map((c,i)=>({left:i? (centers[i-1]+c)/2:c-gap/2,right:i===centers.length-1?c+gap/2:(c+centers[i+1])/2}));

    lines.forEach(line=>{
      const dc=line.items.find(i=>parseRotaDate(i.text)), day=dc?parseRotaDate(dc.text):null; if(!day) return;
      cells.forEach((cell,idx)=>{
        const b=bounds[idx], raw=line.items.filter(i=>{const c=i.x+i.width/2;return c>=b.left&&c<b.right;})
          .sort((a,b)=>a.x-b.x).map(i=>i.text).filter(t=>!parseRotaDate(t)&&!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(t)).join(" ").trim();
        if(!raw) return;
        const cl=classifyRotaValue(raw,offKeywords);
        entries.push({pdfName:cell.text,day,rawValue:raw.slice(0,120),entryType:cl.type,startMin:cl.startMin,endMin:cl.endMin});
      });
    });
  }
  const dates=[...new Set(entries.map(x=>x.day))].sort();
  return {fileName:file.name.slice(0,200),headers,entries,dateCount:dates.length,fromDate:dates[0]||null,toDate:dates.at(-1)||null};
}

function classifyRotaValue(raw,offKeywords){
  if(offKeywords.includes(normalizeOffCode(raw))) return {type:"off",startMin:null,endMin:null};
  const m=String(raw).match(/(?:^|\s)(\d{1,2})(?::?(\d{2}))\s*[-–—]\s*(\d{1,2})(?::?(\d{2}))(?:\s|$|\()/);
  if(m){const sh=+m[1],sm=+m[2],eh=+m[3],em=+m[4];if(sh<=23&&eh<=23&&sm<=59&&em<=59)return {type:"shift",startMin:sh*60+sm,endMin:eh*60+em};}
  return {type:"busy",startMin:null,endMin:null};
}

function groupPdfItemsIntoLines(items,tolerance=2.4){
  const sorted=[...items].sort((a,b)=>b.y-a.y||a.x-b.x),lines=[];
  sorted.forEach(item=>{
    let best=null,dist=Infinity;
    lines.forEach(line=>{const d=Math.abs(line.y-item.y);if(d<=tolerance&&d<dist){best=line;dist=d;}});
    if(!best){best={y:item.y,items:[]};lines.push(best);}
    best.items.push(item);best.y=best.items.reduce((s,x)=>s+x.y,0)/best.items.length;
  });
  lines.forEach(l=>l.items.sort((a,b)=>a.x-b.x)); return lines.sort((a,b)=>b.y-a.y);
}

function bestRotaMemberMatch(pdfName,members){
  const p=normalizeRotaName(pdfName);
  if(!p)return null;
  return members.map(m=>{const full=normalizeRotaName(m.name),tokens=m.name.toLowerCase().split(/\s+/).map(normalizeRotaName).filter(Boolean);
    let score=p===full?100:tokens.includes(p)?95:(full.startsWith(p)||full.endsWith(p))?85:0;return {...m,score};})
    .filter(x=>x.score).sort((a,b)=>b.score-a.score)[0]||null;
}
function findDuplicateValues(v){return [...new Set(v.filter((x,i)=>v.indexOf(x)!==i))];}
function median(v){if(!v.length)return 0;const a=[...v].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function parseOffKeywords(v){return String(v||"").split(",").map(normalizeOffCode).filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);}
function normalizeOffCode(v){return String(v||"").toUpperCase().replace(/[^A-Z0-9]+/g," ").trim().replace(/\s+/g," ");}
function normalizeRotaName(v){return String(v||"").toLowerCase().replace(/[^a-z0-9]+/g,"");}
function parseRotaDate(v){const m=String(v||"").trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/);if(!m)return null;
  const d=+m[1],mo=+m[2];let y=+m[3];if(y<100)y+=2000;const dt=new Date(Date.UTC(y,mo-1,d));
  if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return null;return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;}

function entryFor(state,id,day){return state.daysOff.find(x=>x.member_id===id&&x.day===day)||null;}
function workingMembers(state){
  const ids=sharedCircleMemberIds(state);return state.members.filter(m=>ids.has(m.id)&&(circleMembership(state,state.activeSharedCircleId,m.id)?.member_type||"working")==="working");
}

function viewerMembers(state){
  const ids=sharedCircleMemberIds(state);return state.members.filter(m=>ids.has(m.id)&&circleMembership(state,state.activeSharedCircleId,m.id)?.member_type==="viewer");
}

function addMonths(date,n){return new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+n,1));}
function addDaysString(day,n){const p=parseDate(day),dt=new Date(Date.UTC(p.y,p.m,p.d+n));return dateString(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate());}
function dateString(y,m,d){return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;}
function parseDate(s){const [y,mo,d]=s.split("-").map(Number);return {y,m:mo-1,d};}
function prettyDate(s){const p=parseDate(s);return new Intl.DateTimeFormat("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(Date.UTC(p.y,p.m,p.d)));}
function todayUtc(){const n=new Date();return new Date(Date.UTC(n.getFullYear(),n.getMonth(),n.getDate()));}
function timeToMinutes(v){const m=String(v||"").match(/^(\d{2}):(\d{2})$/);if(!m)return null;const h=+m[1],mi=+m[2];return h<=23&&mi<=59?h*60+mi:null;}
function minutesToInputTime(v){return Number.isInteger(v)?`${String(Math.floor(v/60)).padStart(2,"0")}:${String(v%60).padStart(2,"0")}`:"00:00";}
function minutesToCompact(v){return Number.isInteger(v)?`${String(Math.floor(v/60)).padStart(2,"0")}${String(v%60).padStart(2,"0")}`:"";}
function clampInt(v,min,max,f){const n=parseInt(v,10);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):f;}

function renderOwnerList(state){
  const h=$("#ownerList");if(!h)return;
  renderMemberActivitySummary(state);
  h.innerHTML=state.members.map(m=>{
    const activity=state.memberActivity.find(x=>x.member_id===m.id)||{};
    const activityLabel=softActivityLabel(activity.last_active_at);
    const scheduleLabel=m.role==="viewer"?"No rota needed":softScheduleFreshness(activity.last_schedule_update_at);
    return `<div class="owner-row owner-row-v4 member-admin-row">
      <div class="member-admin-main">
        <div class="member-identity">${memberAvatarHtml(m,"sm")}<div><strong>${escapeHtml(m.name)}</strong><div class="subtle">${m.role==="viewer"?"Viewer":"Working member"}${m.is_owner?" · Owner":""} · ${m.user_id?"Joined":"Waiting to join"}</div></div></div>
        <div class="activity-pills"><span class="activity-pill ${activityLabel.className}">${escapeHtml(activityLabel.label)}</span><span class="activity-pill schedule">${escapeHtml(scheduleLabel)}</span></div>
      </div>
      <div class="row-wrap owner-actions"><button class="btn btn-small" data-view-member="${m.id}" type="button">View</button><button class="btn btn-small" data-remind-admin="${m.id}" type="button">Remind</button><button class="btn btn-small" data-rename="${m.id}" type="button">Rename</button>${m.user_id&&!m.is_owner?`<button class="btn btn-small" data-reset="${m.id}" type="button">Reset access</button>`:""}${!m.is_owner?`<button class="btn btn-small btn-danger" data-remove="${m.id}" type="button">Remove</button>`:""}</div>
    </div>`;
  }).join("");

  h.querySelectorAll("[data-view-member]").forEach(b=>b.addEventListener("click",()=>{const m=state.members.find(x=>x.id===b.dataset.viewMember);if(m)openMemberAdminDialog(state,m);}));
  h.querySelectorAll("[data-remind-admin]").forEach(b=>b.addEventListener("click",()=>{const m=state.members.find(x=>x.id===b.dataset.remindAdmin);if(m)remindMember(state,m);}));
  h.querySelectorAll("[data-rename]").forEach(b=>b.addEventListener("click",async()=>{const m=state.members.find(x=>x.id===b.dataset.rename),n=window.prompt("New name:",m.name);if(!n?.trim())return;const{error}=await state.supabase.rpc("rename_member",{p_member_id:m.id,p_new_name:n.trim()});if(error)return state.setStatus(error.message,true);await loadGroup(state);renderMain(state);}));
  h.querySelectorAll("[data-reset]").forEach(b=>b.addEventListener("click",async()=>{const m=state.members.find(x=>x.id===b.dataset.reset);if(!window.confirm(`Reset ${m.name}'s device access?`))return;const{error}=await state.supabase.rpc("reset_member_access",{p_member_id:m.id});if(error)return state.setStatus(error.message,true);await loadGroup(state);renderMain(state);}));
  h.querySelectorAll("[data-remove]").forEach(b=>b.addEventListener("click",async()=>{const m=state.members.find(x=>x.id===b.dataset.remove);if(!window.confirm(`Remove ${m.name}?`))return;const{error}=await state.supabase.rpc("remove_member",{p_member_id:m.id});if(error)return state.setStatus(error.message,true);await loadGroup(state);renderMain(state);}));
}

function renderMemberActivitySummary(state) {
  const el=$("#memberActivitySummary");
  if(!el||!state.me.is_owner) return;
  const joined=state.members.filter(m=>m.user_id).length;
  const weekAgo=Date.now()-7*86400000;
  const activeWeek=state.memberActivity.filter(x=>x.last_active_at&&new Date(x.last_active_at).getTime()>=weekAgo).length;
  const coverage=monthCoverage(state);
  const incomplete=coverage.members.filter(x=>x.percent<80).length;
  el.innerHTML=`<div><strong>${joined}/${state.members.length}</strong><span>joined</span></div><div><strong>${activeWeek}</strong><span>active this week</span></div><div><strong>${incomplete}</strong><span>rotas need attention</span></div>`;
}

function softActivityLabel(value) {
  if(!value) return {label:"No activity yet",className:"inactive"};
  const age=Date.now()-new Date(value).getTime();
  if(age<5*60*1000) return {label:"● Active now",className:"online"};
  if(age<24*60*60*1000) return {label:"Active today",className:"recent"};
  if(age<7*24*60*60*1000) return {label:"Active this week",className:"recent"};
  return {label:"Inactive 7+ days",className:"inactive"};
}

function softScheduleFreshness(value) {
  if(!value) return "Schedule update not recorded";
  const age=Date.now()-new Date(value).getTime();
  if(age<24*60*60*1000) return "Schedule updated today";
  if(age<7*24*60*60*1000) return "Schedule updated this week";
  if(age<30*24*60*60*1000) return "Schedule updated this month";
  return "Schedule may be out of date";
}

async function refreshMemberActivity(state) {
  if(!state.me.is_owner) return;
  const {data,error}=await state.supabase.rpc("get_group_activity_owner");
  if(error) throw error;
  state.memberActivity=data||[];
}
async function subscribeRealtime(state){
  if(state.realtimeChannel)await state.supabase.removeChannel(state.realtimeChannel);

  state.realtimeChannel=state.supabase.channel(`rota-${state.me.group_id}`)
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"group_activity_feed",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshRotaRows(state);await refreshSocialExtras(state);refreshAllScheduleViews(state);renderRecentActivity(state);await checkGoodDayNotifications(state);state.setStatus?.("Group updated.");}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"group_polls",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshSocialExtras(state);renderGroupPolls(state);await notifyPollIfWanted(state);state.setStatus?.("Polls updated.");}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"group_poll_votes",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshSocialExtras(state);renderGroupPolls(state);}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"meal_availability_overrides",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshExtras(state);refreshAllScheduleViews(state);await checkGoodDayNotifications(state);state.setStatus?.("Availability updated.");}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"group_events",filter:`group_id=eq.${state.me.group_id}`},async(payload)=>{
      try{
        const previousIds=new Set(state.events.map(x=>String(x.id)));
        await refreshExtras(state);
        renderRotaCalendar(state);renderUpcomingEvents(state);renderDashboard(state);
        const newPlan=state.events.find(x=>!previousIds.has(String(x.id)));
        if(newPlan&&newPlan.created_by_member_id!==state.me.id) await notifyNewPlanIfWanted(state,newPlan);
        state.setStatus?.("Plans updated.");
      }catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"event_rsvps",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshExtras(state);renderUpcomingEvents(state);renderDayDetails(state);renderDashboard(state);state.setStatus?.("RSVP updated.");}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"event_plan_notes",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshExtras(state);renderUpcomingEvents(state);renderDayDetails(state);state.setStatus?.("Plan notes updated.");}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"event_location_options",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshExtras(state);renderUpcomingEvents(state);renderDayDetails(state);}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"event_location_votes",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      try{await refreshExtras(state);renderUpcomingEvents(state);renderDayDetails(state);}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"members",filter:`group_id=eq.${state.me.group_id}`},async()=>{
      await loadGroup(state);if(!joinedSharedCircles(state).length)renderPendingAccess(state);else renderMain(state);
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"shared_circle_memberships"},async()=>{
      try{await loadGroup(state);if(!joinedSharedCircles(state).length)renderPendingAccess(state);else renderMain(state);}catch{}
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"circle_join_requests"},async()=>{
      try{const {data}=await state.supabase.rpc("get_join_requests_v13");state.joinRequests=data||[];renderJoinRequestsAdmin(state);}catch{}
    })
    .subscribe(status=>{
      const e=$("#connection");if(!e)return;
      e.textContent=status==="SUBSCRIBED"?"● Live":"Live sync reconnecting…";
    });
}
function buildInviteUrl(state){
  const url=new URL(window.location.href);url.search="";url.hash="";
  const handle=state.members.find(x=>x.id===state.me.id)?.public_handle;
  if(handle) url.searchParams.set("ref",handle);
  return url.toString();
}

function isStandaloneApp() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone===true;
}


function groupTypeLabel(type) {
  return ({shiftworkers:"Shift-working friends",friends:"Friends",family:"Family",team:"Team / club",community:"Community"})[type]||"Shared availability";
}


function normalizePollRows(rows){
  const map=new Map();
  for(const row of rows||[]){
    if(!map.has(row.poll_id)){
      map.set(row.poll_id,{
        id:row.poll_id,title:row.title,created_at:row.poll_created_at,closed:row.closed,choice_mode:row.choice_mode||"availability",circle_id:row.circle_id||null,
        created_by_member_id:row.created_by_member_id,creator_name:row.creator_name,options:[]
      });
    }
    const poll=map.get(row.poll_id);
    let option=poll.options.find(x=>x.id===row.option_id);
    if(!option && row.option_id){
      option={id:row.option_id,day:row.option_day,start_min:row.option_start_min,label:row.option_label,sort_order:row.option_sort_order,votes:[]};
      poll.options.push(option);
    }
    if(option && row.vote_member_id){
      option.votes.push({member_id:row.vote_member_id,member_name:row.vote_member_name,status:row.vote_status});
    }
  }
  return [...map.values()].map(p=>({...p,options:p.options.sort((a,b)=>a.sort_order-b.sort_order)}));
}

async function refreshSocialExtras(state){
  const [feedRes,pollsRes]=state.activeSharedCircleId?await Promise.all([
    state.supabase.rpc("get_group_feed_v13",{p_circle_id:state.activeSharedCircleId,p_limit:20}),
    state.supabase.rpc("get_circle_polls_v13",{p_circle_id:state.activeSharedCircleId})
  ]):[{data:[],error:null},{data:[],error:null}];
  if(feedRes.error) throw feedRes.error;if(pollsRes.error) throw pollsRes.error;
  state.groupFeed=feedRes.data||[];state.groupPolls=normalizePollRows(pollsRes.data||[]);
}

function activityFeedText(item){
  const actor=item.actor_name||"Someone";
  const meta=item.meta||{};
  switch(item.kind){
    case "schedule_updated": return `${actor} updated ${meta.subject_name&&meta.subject_name!==actor?`${meta.subject_name}’s`:"their"} schedule`;
    case "availability_updated": return `${actor} updated availability`;
    case "plan_created": return `${actor} created ${meta.title||"a plan"}`;
    case "rsvp_updated": return `${actor} responded ${humanRsvp(meta.status)} to ${meta.title||"a plan"}`;
    case "poll_created": return `${actor} asked the group to choose a date`;
    default: return `${actor} updated the group`;
  }
}
function activityFeedIcon(kind){
  return ({schedule_updated:"📋",availability_updated:"🕐",plan_created:"✨",rsvp_updated:"✓",poll_created:"🗳"})[kind]||"•";
}
function renderRecentActivity(state){
  const holder=$("#recentActivity");
  if(!holder) return;
  const items=(state.groupFeed||[]).slice(0,3);
  holder.innerHTML=items.length?items.map(item=>`<div class="activity-feed-row">
    <span class="activity-feed-icon">${activityFeedIcon(item.kind)}</span>
    <div><strong>${escapeHtml(activityFeedText(item))}</strong><small>${escapeHtml(relativeTime(item.created_at))}</small></div>
  </div>`).join(""):`<div class="soft-empty">Group activity will appear here as people update schedules and make plans.</div>`;
}
function relativeTime(value){
  if(!value) return "";
  const ms=Date.now()-new Date(value).getTime();
  if(ms<60_000) return "Just now";
  if(ms<3_600_000) return `${Math.max(1,Math.floor(ms/60_000))} min ago`;
  if(ms<86_400_000) return `${Math.floor(ms/3_600_000)} hr ago`;
  if(ms<7*86_400_000) return `${Math.floor(ms/86_400_000)} days ago`;
  return new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"short"}).format(new Date(value));
}
function humanRsvp(status){return status==="going"?"going":status==="maybe"?"maybe":"can’t make it";}

function pollOptionLabel(option){
  const date=shortDashboardDate(option.day);
  const time=Number.isInteger(option.start_min)?minutesToInputTime(option.start_min):"";
  return `${date}${time?` · ${time}`:""}${option.label?` · ${option.label}`:""}`;
}
function pollVoteCounts(option){
  const c={works:0,maybe:0,cant:0};
  (option.votes||[]).forEach(v=>{if(c[v.status]!==undefined)c[v.status]++;});
  return c;
}
function renderGroupPolls(state){
  const holder=$("#groupPolls");if(!holder)return;const polls=(state.groupPolls||[]).slice(0,8);
  holder.innerHTML=polls.length?polls.map(poll=>{const canManage=poll.created_by_member_id===state.me.id||canManageCircle(state,poll.circle_id||state.activeSharedCircleId);return `<article class="poll-card ${poll.closed?"closed":""}">
    <div class="row-wrap between"><div><div class="row-wrap"><strong>${escapeHtml(poll.title)}</strong>${poll.closed?`<span class="poll-closed-badge">Closed</span>`:""}</div><small>Asked by ${escapeHtml(poll.creator_name||"a circle member")} · ${poll.choice_mode==="single"?"Pick one":"Availability"}</small></div>${canManage?`<div class="poll-admin-actions">${!poll.closed?`<button class="btn btn-tiny" data-add-poll-option="${poll.id}" type="button">+ Option</button><button class="btn btn-tiny" data-close-poll="${poll.id}" type="button">Close</button>`:""}<button class="btn btn-tiny btn-danger" data-delete-poll="${poll.id}" type="button">Delete</button></div>`:""}</div>
    <div class="poll-options">${poll.options.map(option=>{const counts=pollVoteCounts(option);const mine=(option.votes||[]).find(v=>v.member_id===state.me.id)?.status||"";const voterNames=(option.votes||[]).map(v=>v.member_name).filter(Boolean);return `<div class="poll-option"><div class="row-wrap between"><strong>${escapeHtml(pollOptionLabel(option))}</strong><div class="row-wrap">${poll.choice_mode==="single"?`<span class="poll-score">${option.votes?.length||0} vote${option.votes?.length===1?"":"s"}</span>`:`<span class="poll-score">✓ ${counts.works} · ? ${counts.maybe} · × ${counts.cant}</span>`}${canManage&&!poll.closed&&poll.options.length>2?`<button class="poll-option-delete" data-delete-poll-option="${poll.id}:${option.id}" type="button">×</button>`:""}</div></div>
      ${!poll.closed?(poll.choice_mode==="single"?`<div class="poll-vote-buttons"><button class="poll-vote ${mine==="works"?"active":""}" data-poll-vote="${poll.id}:${option.id}:${mine==="works"?"clear":"works"}" type="button">${mine==="works"?"✓ Selected":"Vote"}</button></div>`:`<div class="poll-vote-buttons"><button class="poll-vote ${mine==="works"?"active":""}" data-poll-vote="${poll.id}:${option.id}:works" type="button">✓ Works</button><button class="poll-vote ${mine==="maybe"?"active":""}" data-poll-vote="${poll.id}:${option.id}:maybe" type="button">? Maybe</button><button class="poll-vote ${mine==="cant"?"active":""}" data-poll-vote="${poll.id}:${option.id}:cant" type="button">× Can’t</button></div>`):""}
      ${option.votes?.length?`<div class="poll-voter-list">${option.votes.map(v=>`<span>${memberAvatarHtml(state.members.find(m=>m.id===v.member_id)||{id:v.member_id,name:v.member_name},"tiny")} ${escapeHtml(v.member_name)}${poll.choice_mode==="single"?"":` · ${v.status==="works"?"works":v.status==="maybe"?"maybe":"can’t"}`}</span>`).join("")}</div>`:""}
      ${canManage?`<button class="btn btn-small plan-from-poll-btn" type="button" data-plan-from-poll="${poll.id}:${option.id}">Create plan from this option</button>`:""}</div>`;}).join("")}</div>
  </article>`;}).join(""):`<div class="soft-empty">No open date/time question. Use “Ask group which time” from a Meet result when needed.</div>`;

  holder.querySelectorAll("[data-poll-vote]").forEach(btn=>btn.addEventListener("click",async()=>{if(!navigator.onLine)return state.setStatus("Reconnect to vote in a poll.",true);const [pollId,optionId,status]=btn.dataset.pollVote.split(":");btn.disabled=true;const {error}=await state.supabase.rpc("vote_group_poll",{p_poll_id:pollId,p_option_id:optionId,p_status:status});btn.disabled=false;if(error)return state.setStatus(error.message,true);await refreshSocialExtras(state);renderGroupPolls(state);state.setStatus("Vote saved ✓");}));
  holder.querySelectorAll("[data-close-poll]").forEach(btn=>btn.addEventListener("click",async()=>{const {error}=await state.supabase.rpc("close_group_poll",{p_poll_id:btn.dataset.closePoll});if(error)return state.setStatus(error.message,true);await refreshSocialExtras(state);renderGroupPolls(state);state.setStatus("Poll closed ✓");}));
  holder.querySelectorAll("[data-delete-poll]").forEach(btn=>btn.addEventListener("click",async()=>{if(!window.confirm("Delete this poll and all its votes?"))return;const {error}=await state.supabase.rpc("delete_group_poll_v13_2",{p_poll_id:btn.dataset.deletePoll});if(error)return state.setStatus(error.message,true);await refreshSocialExtras(state);renderGroupPolls(state);state.setStatus("Poll deleted ✓");}));
  holder.querySelectorAll("[data-add-poll-option]").forEach(btn=>btn.addEventListener("click",async()=>{const day=window.prompt("Add date (YYYY-MM-DD):",dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate()));if(!day)return;const time=window.prompt("Time (HH:MM) — leave blank for whole date:","");const label=window.prompt("Optional label:","")||"";const start=time&&/^\\d{1,2}:\\d{2}$/.test(time)?inputTimeToMinutes(time):null;const {error}=await state.supabase.rpc("add_group_poll_option_v13_2",{p_poll_id:btn.dataset.addPollOption,p_day:day,p_start_min:start,p_label:label||null});if(error)return state.setStatus(error.message,true);await refreshSocialExtras(state);renderGroupPolls(state);}));
  holder.querySelectorAll("[data-delete-poll-option]").forEach(btn=>btn.addEventListener("click",async()=>{const [pollId,optionId]=btn.dataset.deletePollOption.split(":");const {error}=await state.supabase.rpc("delete_group_poll_option_v13_2",{p_poll_id:pollId,p_option_id:optionId});if(error)return state.setStatus(error.message,true);await refreshSocialExtras(state);renderGroupPolls(state);}));
  holder.querySelectorAll("[data-plan-from-poll]").forEach(btn=>btn.addEventListener("click",async()=>{const [pollId,optionId]=btn.dataset.planFromPoll.split(":");const poll=(state.groupPolls||[]).find(p=>p.id===pollId);const title=window.prompt("Plan title:",poll?.title||"Our plan");if(!title)return;const {error}=await state.supabase.rpc("create_plan_from_poll_v13_2",{p_poll_id:pollId,p_option_id:optionId,p_title:title});if(error)return state.setStatus(error.message,true);await loadGroup(state);renderMain(state);switchMainTab(state,"events");state.setStatus("Plan created from poll ✓");}));
}

async function createPollFromMeetup(state,seed,allCandidates){
  if(!navigator.onLine)return state.setStatus("Reconnect to ask the group.",true);
  const alternatives=allCandidates.filter(x=>x.day>=seed.day&&x.free>0).sort((a,b)=>b.score-a.score||a.day.localeCompare(b.day)).filter((x,i,a)=>a.findIndex(y=>y.day===x.day&&y.startMin===x.startMin)===i).slice(0,3);
  if(!alternatives.length)return state.setStatus("No useful alternatives found.",true);
  const options=alternatives.map(x=>({day:x.day,start_min:x.startMin,label:`${x.name} ${x.time}`}));
  const title="Which time works best?";
  const {error}=await state.supabase.rpc("create_circle_poll_v13",{p_circle_id:state.activeSharedCircleId,p_title:title,p_options:options});
  if(error)return state.setStatus(error.message,true);
  await refreshSocialExtras(state);renderGroupPolls(state);switchMainTab(state,"meetups");state.setStatus("Question added to Meet ✓");
}

async function notifyPollIfWanted(state){
  const prefs=getNotificationPrefs(state);
  if(!prefs.polls) return;
  const poll=(state.groupPolls||[])[0];
  if(!poll) return;
  const key=`odoPollSeen:${state.me.group_id}:${state.me.id}:${poll.id}`;
  if(localStorage.getItem(key)) return;
  localStorage.setItem(key,"1");
  if(poll.created_by_member_id!==state.me.id) await showBrowserNotification("The group has a new poll 🗳",poll.title,`poll-${poll.id}`);
}


function wireAppearanceSettings(state){
  const holder=$("#themeChoiceGrid");
  if(!holder) return;
  const selectTheme=theme=>{
    const chosen=applyAppTheme(theme,true);
    holder.querySelectorAll("[data-theme-choice]").forEach(btn=>btn.classList.toggle("active",btn.dataset.themeChoice===chosen));
    setMsg($("#appearanceMsg"),`${APP_THEMES.find(x=>x.key===chosen)?.label||"Theme"} colours applied ✓`);
  };
  const current=normaliseAppTheme(localStorage.getItem("odoAppTheme")||"ocean");
  applyAppTheme(current,false);
  holder.querySelectorAll("[data-theme-choice]").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.themeChoice===current);
    btn.addEventListener("click",()=>selectTheme(btn.dataset.themeChoice));
  });
}

function wirePrivacySettings(state){
  const select=$("#scheduleVisibilitySelect");
  if(!select) return;
  const me=state.members.find(m=>m.id===state.me.id);
  select.value=me?.schedule_visibility||"shifts";
  const explain=()=>{
    const text={
      freebusy:"Others see your available windows, without shift labels, notes or imported rota details. Availability boundaries may suggest when you are working.",
      shifts:"Others can see shift times and OFF days, but not rota notes or detailed labels.",
      details:"Others can see the full rota information stored in this group."
    }[select.value];
    $("#privacyExplainer").innerHTML=`<strong>What your circle sees</strong><p>${escapeHtml(text)}</p><div class="privacy-preview">${select.value==="freebusy"?"Available 17:00–22:00 · no shift details":select.value==="shifts"?"08:00–17:00 · no notes or import details":"08:00–17:00 · rota label and note"}</div><small>Illustrative preview. Only members of your circles can see shared information.</small>`;
  };
  explain();
  select.addEventListener("change",async()=>{
    if(!navigator.onLine) return setMsg($("#privacyMsg"),"Reconnect to change privacy settings.",true);
    const {error}=await state.supabase.rpc("set_my_schedule_visibility",{p_visibility:select.value});
    if(error) return setMsg($("#privacyMsg"),error.message,true);
    const member=state.members.find(m=>m.id===state.me.id); if(member) member.schedule_visibility=select.value;
    await refreshRotaRows(state);
    explain();setMsg($("#privacyMsg"),"Privacy setting saved ✓");
  });
}

async function renderInviteQr(state){
  const canvas=$("#inviteQrCanvas");if(!canvas)return;const url=buildInviteUrl(state);
  try{if(window.QRCode?.toCanvas){await new Promise((resolve,reject)=>window.QRCode.toCanvas(canvas,url,{width:176,margin:1,errorCorrectionLevel:"M"},err=>err?reject(err):resolve()));}else{const ctx=canvas.getContext("2d");ctx.clearRect(0,0,canvas.width,canvas.height);ctx.font="14px sans-serif";ctx.fillText("QR unavailable",35,88);}}catch{}
}

function onboardingKey(state){return `odoWelcome:${state.me.id}:v12`;}
function wireWelcomeGuide(state){
  const dialog=$("#welcomeGuideDialog");
  if(!dialog||localStorage.getItem(onboardingKey(state))) return;
  setTimeout(()=>{if(!dialog.open)dialog.showModal();},250);
  const finish=()=>{localStorage.setItem(onboardingKey(state),"1");dialog.close();};
  $("#welcomeExploreBtn")?.addEventListener("click",finish);
  $("#welcomeAddScheduleBtn")?.addEventListener("click",()=>{finish();switchMainTab(state,"more");setTimeout(()=>$("#rotaImportSection")?.scrollIntoView({behavior:"smooth",block:"start"}),80);});
  $("#welcomeMeetBtn")?.addEventListener("click",()=>{finish();switchMainTab(state,"meetups");});
}

function openMemberAdminDialog(state,member){
  if(!state.me.is_owner) return;
  const dialog=$("#memberAdminDialog"),body=$("#memberAdminDialogBody");
  if(!dialog||!body) return;
  const activity=state.memberActivity.find(x=>x.member_id===member.id)||{};
  const a=softActivityLabel(activity.last_active_at);
  const s=member.role==="viewer"?"No rota needed":softScheduleFreshness(activity.last_schedule_update_at);
  const coverage=monthCoverage(state).members.find(x=>x.id===member.id);
  $("#memberAdminDialogTitle").textContent=member.name;
  body.innerHTML=`<div class="member-detail-grid">
    <div><span>Role</span><strong>${member.is_owner?"Owner":member.role==="viewer"?"Viewer":"Working member"}</strong></div>
    <div><span>Access</span><strong>${member.user_id?"Joined":"Waiting to join"}</strong></div>
    <div><span>Activity</span><strong>${escapeHtml(a.label)}</strong></div>
    <div><span>Schedule</span><strong>${escapeHtml(s)}</strong></div>
    ${coverage?`<div><span>This month</span><strong>${coverage.covered}/${coverage.total} days entered</strong></div>`:""}
    <div><span>Schedule sharing</span><strong>${escapeHtml(member.schedule_visibility||"shifts")}</strong></div>
  </div>
  <div class="notice">Activity status is admin-only. Normal members and viewers cannot see this information.</div>`;
  dialog.showModal();
}

function updateLastSyncedLabel(state){
  const el=$("#lastSyncedLabel");if(!el)return;
  el.textContent=state.lastSyncedAt?`Last synced ${relativeTime(state.lastSyncedAt)}`:"Not synced yet";
}

function notificationPrefsKey(state){ return `odoNotifPrefs:${state.me.group_id}:${state.me.id}`; }
function getNotificationPrefs(state){
  let prefs={goodDays:false,newPlans:false,planReminders:false,polls:false};
  try{prefs={...prefs,...JSON.parse(localStorage.getItem(notificationPrefsKey(state))||"{}")};}catch{}
  // Migrate the v11 good-day opt-in.
  if(localStorage.getItem(`goodDayAlerts:${state.me.group_id}:${state.me.id}`)==="1") prefs.goodDays=true;
  return prefs;
}
function saveNotificationPrefs(state,prefs){localStorage.setItem(notificationPrefsKey(state),JSON.stringify(prefs));}

function wireNotificationSettings(state){
  const prefs=getNotificationPrefs(state);
  const map={notifyGoodDays:"goodDays",notifyNewPlans:"newPlans",notifyPlanReminders:"planReminders",notifyPolls:"polls"};
  Object.entries(map).forEach(([id,key])=>{
    const input=$("#"+id); if(!input) return;
    input.checked=!!prefs[key];
    input.addEventListener("change",async()=>{
      if(input.checked){
        const ok=await ensureNotificationPermission();
        if(!ok){input.checked=false;setMsg($("#notificationMsg"),"Notification permission wasn’t enabled.",true);return;}
      }
      const next=getNotificationPrefs(state); next[key]=input.checked; saveNotificationPrefs(state,next);
      if(key==="goodDays"){
        localStorage.setItem(goodDayEnabledKey(state),input.checked?"1":"0");
        if(input.checked) localStorage.setItem(goodDaySeenKey(state),JSON.stringify(goodDayCandidates(state).map(x=>`${x.day}:${x.startMin}:${x.endMin}`)));
      }
      setMsg($("#notificationMsg"),"Notification preference saved ✓");
    });
  });
}
async function ensureNotificationPermission(){
  if(!("Notification" in window)) return false;
  if(Notification.permission==="granted") return true;
  if(Notification.permission==="denied") return false;
  return (await Notification.requestPermission())==="granted";
}
async function showBrowserNotification(title,body,tag){
  if(!("Notification" in window)||Notification.permission!=="granted") return;
  const options={body,icon:"./icon-192.png",badge:"./icon-192.png",tag};
  try{
    if("serviceWorker" in navigator){const reg=await navigator.serviceWorker.ready;await reg.showNotification(title,options);}
    else new Notification(title,options);
  }catch{}
}
async function notifyNewPlanIfWanted(state,plan){
  const prefs=getNotificationPrefs(state); if(!prefs.newPlans) return;
  await showBrowserNotification("New plan 🎉",`${plan.title} · ${shortDashboardDate(plan.day)}${Number.isInteger(plan.start_min)?` · ${minutesToInputTime(plan.start_min)}`:""}`,`plan-${plan.id}`);
}
async function checkPlanReminder(state){
  const prefs=getNotificationPrefs(state); if(!prefs.planReminders) return;
  const today=dateString(todayUtc().getUTCFullYear(),todayUtc().getUTCMonth(),todayUtc().getUTCDate());
  const plan=activeCircleEvents(state).filter(x=>x.day===today).sort((a,b)=>(a.start_min??9999)-(b.start_min??9999))[0];
  if(!plan) return;
  const key=`odoPlanReminder:${state.me.group_id}:${state.me.id}:${plan.id}:${today}`;
  if(localStorage.getItem(key)) return;
  localStorage.setItem(key,"1");
  await showBrowserNotification("You have a plan today",`${plan.title}${Number.isInteger(plan.start_min)?` · ${minutesToInputTime(plan.start_min)}`:""}${plan.location?` · ${plan.location}`:""}`,`plan-reminder-${plan.id}-${today}`);
}
async function checkSmartNotifications(state){
  const prefs=getNotificationPrefs(state);
  if(prefs.goodDays){localStorage.setItem(goodDayEnabledKey(state),"1");await checkGoodDayNotifications(state);}
  await checkPlanReminder(state);
  if(prefs.polls) await notifyPollIfWanted(state);
}

async function touchMemberActivity(state){
  if(!state.me||!navigator.onLine) return;
  try{await state.supabase.rpc("touch_member_activity",{p_app_version:APP_VERSION});}catch{}
}
function setupActivityHeartbeat(state){
  if(state.activityTimer) clearInterval(state.activityTimer);
  const ping=()=>{if(document.visibilityState==="visible"&&navigator.onLine) touchMemberActivity(state);};
  state.activityTimer=setInterval(ping,180000);
  if(!state.foregroundRefreshWired){state.foregroundRefreshWired=true;document.addEventListener("visibilitychange",async()=>{if(document.visibilityState==="visible"&&navigator.onLine){ping();try{await loadGroup(state);renderMain(state);}catch{state.setStatus?.("Could not refresh. Availability may be outdated.",true);}checkSmartNotifications(state);}});}
}

function offlineSnapshotKey(state){return `odoSnapshot:${state.user?.id||"local"}`;}
function saveOfflineSnapshot(state){

  if(!state.me||!state.group) return;
  try{localStorage.setItem(offlineSnapshotKey(state),JSON.stringify({version:14,availability:state.availability,savedAt:new Date().toISOString(),me:state.me,group:state.group,members:state.members,daysOff:state.daysOff,mealOverrides:state.mealOverrides,personalCircles:state.personalCircles,circleDefs:state.circleDefs,sharedCircles:state.sharedCircles,sharedCircleMemberships:state.sharedCircleMemberships,activeSharedCircleId:state.activeSharedCircleId,joinRequests:state.joinRequests,events:state.events,eventRsvps:state.eventRsvps,eventNotes:state.eventNotes,eventLocationOptions:state.eventLocationOptions,eventLocationVotes:state.eventLocationVotes,compareSets:state.compareSets,personalScheduleProfileId:state.personalScheduleProfileId,groupFeed:state.groupFeed,groupPolls:state.groupPolls,shiftDefinitions:state.shiftDefinitions,lastSyncedAt:state.lastSyncedAt}));}catch{}
}
function loadOfflineSnapshot(state){

  try{
    const snap=JSON.parse(localStorage.getItem(offlineSnapshotKey(state))||"null");
    if(!snap?.me||!snap?.group||snap.version!==14||Date.now()-Date.parse(snap.savedAt)>15*60*1000){localStorage.removeItem(offlineSnapshotKey(state));return false;}
    state.availability=snap.availability||[];
    state.me=snap.me;state.group=snap.group;state.members=snap.members||[];state.daysOff=snap.daysOff||[];state.mealOverrides=snap.mealOverrides||[];state.personalCircles=snap.personalCircles||[];state.circleDefs=snap.circleDefs||[];state.sharedCircles=snap.sharedCircles||[];state.sharedCircleMemberships=snap.sharedCircleMemberships||[];const offlineJoined=new Set(state.sharedCircleMemberships.filter(x=>x.member_id===state.me.id).map(x=>x.circle_id));const wantedCircle=snap.activeSharedCircleId||localStorage.getItem(sharedCircleSelectionKey(state));state.activeSharedCircleId=offlineJoined.has(wantedCircle)?wantedCircle:(state.sharedCircles.find(c=>offlineJoined.has(c.id))?.id||null);state.joinRequests=snap.joinRequests||[];state.activeCircle="all";state.events=snap.events||[];state.eventRsvps=snap.eventRsvps||[];state.eventNotes=snap.eventNotes||[];state.eventLocationOptions=snap.eventLocationOptions||[];state.eventLocationVotes=snap.eventLocationVotes||[];state.compareSets=snap.compareSets||[];state.personalScheduleProfileId=snap.personalScheduleProfileId||null;state.calendarCompareIds=loadCalendarCompareSelection(state);state.groupFeed=snap.groupFeed||[];state.groupPolls=snap.groupPolls||[];state.shiftDefinitions=snap.shiftDefinitions||[];state.lastSyncedAt=snap.lastSyncedAt||snap.savedAt||null;state.memberActivity=[];
    return true;
  }catch{return false;}
}
function setupNetworkAwareness(state){
  if(state.networkWired) return; state.networkWired=true;
  window.addEventListener("offline",()=>{state.offlineMode=true;updateNetworkUI(state);state.setStatus?.("Offline — viewing a recent snapshot. Reconnect to confirm availability.");});
  window.addEventListener("online",async()=>{
    state.offlineMode=false;updateNetworkUI(state);state.setStatus?.("Back online — refreshing…");
    try{await touchMemberActivity(state);await loadGroup(state);renderMain(state);setupActivityHeartbeat(state);await subscribeRealtime(state);state.setStatus?.("Back online · Synced ✓");}catch{state.setStatus?.("Back online, but sync needs another try.",true);}
  });
}
function updateNetworkUI(state){
  const b=$("#networkBanner"); if(!b) return;
  const offline=state.offlineMode||!navigator.onLine;
  b.hidden=!offline;
  b.textContent=offline?"You’re offline — viewing saved data. Changes that need the server are disabled until you reconnect.":"";
  updateLastSyncedLabel(state);
}

function markUpdateReady(reg){updateRegistration=reg;window.__odoUpdateReady=true;showPendingUpdateBanner();}
function showPendingUpdateBanner(){const b=$("#updateBanner");if(b)b.hidden=!window.__odoUpdateReady;}
async function checkForAppUpdate(state){
  if(!("serviceWorker" in navigator)) return state.setStatus?.("App updates aren’t supported in this browser.",true);
  try{
    const reg=await navigator.serviceWorker.getRegistration();
    if(!reg) return state.setStatus?.("No installed app service worker found.",true);
    updateRegistration=reg;await reg.update();
    if(reg.waiting){markUpdateReady(reg);state.setStatus?.("Update ready.");}
    else state.setStatus?.("You’re on the latest available version ✓");
  }catch(error){state.setStatus?.("Couldn’t check for updates.",true);}
}
function applyAppUpdate(){
  const waiting=updateRegistration?.waiting;
  if(waiting) waiting.postMessage({type:"SKIP_WAITING"});
  else window.location.reload();
}
async function registerServiceWorkerWithUpdates(){
  if(!("serviceWorker" in navigator)) return;
  try{
    const reg=await navigator.serviceWorker.register("./sw.js");
    updateRegistration=reg;
    if(reg.waiting) markUpdateReady(reg);
    reg.addEventListener("updatefound",()=>{
      const worker=reg.installing;if(!worker)return;
      worker.addEventListener("statechange",()=>{if(worker.state==="installed"&&navigator.serviceWorker.controller)markUpdateReady(reg);});
    });
    navigator.serviceWorker.addEventListener("controllerchange",()=>{if(updateReloading)return;updateReloading=true;window.location.reload();});
    setTimeout(()=>reg.update().catch(()=>{}),2500);
  }catch{}
}

async function installApp(state) {
  if(isStandaloneApp()) {
    state.setStatus?.("This app is already installed.");
    return;
  }

  if(deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice=await deferredInstallPrompt.userChoice.catch(()=>null);
    if(choice?.outcome==="accepted") state.setStatus?.("App installed.");
    else state.setStatus?.("Installation cancelled.");
    return;
  }

  const ua=navigator.userAgent||"";
  const isiOS=/iPhone|iPad|iPod/i.test(ua);
  if(isiOS) {
    window.alert("To install on iPhone/iPad: open this site in Safari → tap Share → Add to Home Screen.");
  } else {
    window.alert("To install: open your browser menu and choose Install app or Add to Home screen.");
  }
}

function icsEscape(value) {
  return String(value||"")
    .replace(/\\/g,"\\\\")
    .replace(/\n/g,"\\n")
    .replace(/,/g,"\\,")
    .replace(/;/g,"\\;");
}

function icsDate(day) {
  return day.replaceAll("-","");
}

function icsDateTime(day,startMin) {
  const p=parseDate(day);
  const h=Math.floor(startMin/60);
  const m=startMin%60;
  return `${String(p.y).padStart(4,"0")}${String(p.m+1).padStart(2,"0")}${String(p.d).padStart(2,"0")}T${String(h).padStart(2,"0")}${String(m).padStart(2,"0")}00`;
}

function addMinutesToDayAndTime(day,startMin,delta) {
  const p=parseDate(day);
  const dt=new Date(Date.UTC(p.y,p.m,p.d,0,startMin+delta,0));
  return {
    day:dateString(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate()),
    minute:dt.getUTCHours()*60+dt.getUTCMinutes()
  };
}

async function exportEventToCalendar(event) {
  const uid=`our-days-off-${event.id}-${event.day}@local`;
  const now=new Date();
  const stamp=`${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}T${String(now.getUTCHours()).padStart(2,"0")}${String(now.getUTCMinutes()).padStart(2,"0")}${String(now.getUTCSeconds()).padStart(2,"0")}Z`;

  let dateLines="";
  if(Number.isInteger(event.start_min)) {
    const range=planCalendarRange(event);
    dateLines=`DTSTART:${range.start}\r\nDTEND:${range.end}`;
  } else {
    const next=addDaysString(event.day,1);
    dateLines=`DTSTART;VALUE=DATE:${icsDate(event.day)}\r\nDTEND;VALUE=DATE:${icsDate(next)}`;
  }

  const description=[event.note||"", "Created from Our Days Off"].filter(Boolean).join("\n");
  const ics=[
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Our Days Off//Shared Rota//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    dateLines,
    `SUMMARY:${icsEscape(`${eventIcon(event.category)} ${event.title}`)}`,
    event.location?`LOCATION:${icsEscape(event.location)}`:"",
    description?`DESCRIPTION:${icsEscape(description)}`:"",
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n");

  const fileName=`${String(event.title||"event").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase()||"event"}.ics`;
  const blob=new Blob([ics],{type:"text/calendar;charset=utf-8"});
  const file=new File([blob],fileName,{type:"text/calendar"});

  try {
    if(navigator.canShare?.({files:[file]}) && navigator.share) {
      await navigator.share({files:[file],title:event.title});
      return;
    }
  } catch(error) {
    if(error?.name==="AbortError") return;
  }

  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function normalizeCode(s){return String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,12);}
function setMsg(el,text,error=false){if(el){el.textContent=text;el.style.color=error?"var(--danger)":"";}}
function $(sel){return document.querySelector(sel);}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function escapeAttr(v){return escapeHtml(v);}
function showFatal(error){console.error(error);$app.innerHTML=`<section class="setup card"><h1>Couldn’t start the app</h1><p class="notice error">${escapeHtml(error?.message||String(error))}</p><p class="subtle">Check your connection and make sure the latest database upgrade has been run, then refresh.</p></section>`;}

window.addEventListener("load",()=>registerServiceWorkerWithUpdates());

async function refreshAvailability(state){
  const requestId=state.availabilityRequestId=(state.availabilityRequestId||0)+1;
  const queryRange=scheduleQueryRange(state);
  const [availability,prefs]=await Promise.all([
    state.supabase.rpc("get_availability_v14",queryRange),
    state.supabase.rpc("get_my_preferences_v14")
  ]);
  if(requestId!==state.availabilityRequestId)return;
  state.availability=availability.error?[]:(availability.data||[]);
  state.availabilityError=availability.error?.message||null;
  if(!prefs.error){state.socialPrefs=prefs.data?normalizePreferences(prefs.data):loadLocalSocialPrefs();state.preferencesSynced=!!prefs.data;}
}

function scheduleQueryRange(state){
  const today=new Date(),view=state.view||today;
  const from=new Date(Math.min(today.getTime(),view.getTime()));from.setDate(from.getDate()-35);
  const to=new Date(Math.max(today.getTime(),view.getTime()));to.setDate(to.getDate()+95);
  if((to-from)/86400000>180){from.setTime(view.getTime());from.setDate(1);from.setDate(from.getDate()-7);to.setTime(from.getTime()+100*86400000);}
  const day=d=>d.toISOString().slice(0,10);
  return {p_from:day(from),p_to:day(to)};
}
