const jsonHeaders={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:jsonHeaders});

async function verifySupabaseUser(req){
  const supabaseUrl=process.env.SUPABASE_URL;
  const anonKey=process.env.SUPABASE_PUBLISHABLE_KEY;
  if(!supabaseUrl||!anonKey) throw new Error("AI rota backend is missing Supabase environment variables.");
  const auth=req.headers.get("authorization")||"";
  if(!/^Bearer\s+\S+/i.test(auth)) return null;
  const base=supabaseUrl.replace(/\/$/,"");
  const r=await fetch(`${base}/auth/v1/user`,{headers:{apikey:anonKey,authorization:auth}});
  if(!r.ok) return null;
  const user=await r.json();
  const profile=await fetch(`${base}/rest/v1/rpc/get_my_profile`,{method:"POST",headers:{apikey:anonKey,authorization:auth,"content-type":"application/json"},body:"{}"});
  if(!profile.ok) return null;
  const profileData=await profile.json();
  if(!profileData||(Array.isArray(profileData)&&!profileData.length)) return null;
  return user;
}

function imageDataUrl(item){
  const mime=String(item?.mime||"").toLowerCase();
  const data=String(item?.data||"");
  if(!/^image\/(jpeg|png|webp)$/.test(mime)||!data||data.length>4_200_000||data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return `data:${mime};base64,${data}`;
}

function extractOutputText(response){
  if(typeof response?.output_text==="string"&&response.output_text.trim()) return response.output_text;
  for(const item of response?.output||[]){
    for(const c of item?.content||[]){
      if(c?.type==="output_text"&&typeof c.text==="string") return c.text;
    }
  }
  return "";
}

export default async (req)=>{
  if(req.method!=="POST") return reply(405,{error:"POST required."});
  try{
    const user=await verifySupabaseUser(req);
    if(!user) return reply(401,{error:"Your Our Days Off session could not be verified."});
    const apiKey=process.env.OPENAI_API_KEY;
    if(!apiKey) return reply(503,{error:"AI rota import has not been enabled on this deployment yet."});
    if(Number(req.headers.get('content-length'))>6_000_000)return reply(413,{error:'These screenshots are too large. Upload fewer images.'});
    const textBody=await req.text();
    if(textBody.length>6_000_000)return reply(413,{error:'These screenshots are too large. Upload fewer images.'});
    let body;try{body=JSON.parse(textBody);}catch{return reply(400,{error:'Invalid request data.'});}
    if(!Array.isArray(body?.images)||body.images.length<1||body.images.length>5)return reply(400,{error:'Upload between one and five screenshots.'});
    const images=body.images.map(imageDataUrl);
    if(images.some(x=>!x))return reply(400,{error:'Every screenshot must be a valid JPEG, PNG or WebP image.'});
    if(body.images.reduce((sum,x)=>sum+x.data.length,0)>4_200_000)return reply(413,{error:'These screenshots are too large together. Crop them or upload fewer images.'});

    const prompt=`You are extracting a staff rota from screenshots for a scheduling app. Read only what is visibly supported by the images. Do not infer or invent shift times. Preserve shift codes exactly as shown (for example AM, LD, LATE, NIGHT, EDT). A blank cell should be returned as code \"\" with confidence low only when it is clearly part of a dated/person cell; do not call blank OFF unless the image explicitly says OFF/REST/LEAVE or an equivalent code. Detect staff names/columns and dates. If a shift cell contains an explicit time range, also return explicit_start and explicit_end in HH:MM 24-hour format. Confidence is high only when the date, person column and code are clearly readable; medium when likely; low when uncertain. Include short warnings for cropped headers, unclear dates, ambiguous alignment, or missing year. Use ${new Date().getFullYear()} only when a visible month/day clearly belongs to that year from the screenshot context; otherwise warn rather than inventing. Return structured JSON only.`;

    const schema={
      type:"object",additionalProperties:false,
      properties:{
        title:{type:"string"},
        people:{type:"array",items:{type:"object",additionalProperties:false,properties:{
          name:{type:"string"},
          entries:{type:"array",items:{type:"object",additionalProperties:false,properties:{
            date:{type:"string",pattern:"^\\d{4}-\\d{2}-\\d{2}$"},
            code:{type:"string"},
            explicit_start:{type:["string","null"]},
            explicit_end:{type:["string","null"]},
            confidence:{type:"string",enum:["high","medium","low"]}
          },required:["date","code","explicit_start","explicit_end","confidence"]}}
        },required:["name","entries"]}},
        warnings:{type:"array",items:{type:"string"}}
      },required:["title","people","warnings"]
    };

    const content=[{type:"input_text",text:prompt},...images.map(image_url=>({type:"input_image",image_url}))];
    const model=process.env.OPENAI_ROTA_MODEL||"gpt-5.6-terra";
    const r=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      signal:AbortSignal.timeout(90000),
      headers:{"content-type":"application/json",authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model,input:[{role:"user",content}],text:{format:{type:"json_schema",name:"rota_extract",strict:true,schema}},store:false})
    });
    const raw=await r.json();
    if(!r.ok) return reply(502,{error:"AI rota reading is temporarily unavailable. Please try again later."});
    const text=extractOutputText(raw);
    if(!text) return reply(502,{error:"AI returned no rota data."});
    let parsed;
    try{parsed=JSON.parse(text);}catch{ return reply(502,{error:"AI returned unreadable structured data."}); }
    if(!Array.isArray(parsed.people)||parsed.people.length>100||!Array.isArray(parsed.warnings))return reply(502,{error:'AI returned an invalid rota. Try a clearer screenshot.'});
    let entries=0;
    for(const person of parsed.people){
      if(typeof person.name!=='string'||!Array.isArray(person.entries))return reply(502,{error:'AI returned invalid person mappings.'});
      entries+=person.entries.length;
      for(const entry of person.entries){
        const date=new Date(`${entry.date}T00:00:00Z`);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==entry.date||typeof entry.code!=='string'||!['high','medium','low'].includes(entry.confidence))return reply(502,{error:'AI returned an invalid date or shift. Review a clearer screenshot.'});
      }
    }
    if(entries>10000)return reply(502,{error:'Too many rota entries. Import a shorter date range.'});
    return reply(200,{...parsed,model});
  }catch(error){
    return reply(500,{error:error?.message||"AI rota import failed."});
  }
};
