import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../netlify/functions/ai-rota.mjs';

test('AI endpoint rejects unsupported methods without upstream calls',async()=>{
  const result=await handler(new Request('https://test.invalid/api/ai-rota'));
  assert.equal(result.status,405);
});
test('AI endpoint rejects missing bearer token',async()=>{
  process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='test';
  const result=await handler(new Request('https://test.invalid/api/ai-rota',{method:'POST',body:'{}'}));
  assert.equal(result.status,401);
});
test('AI endpoint validates every image and never silently truncates a batch',async()=>{
  process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='test';process.env.OPENAI_API_KEY='unit-test-only';
  const oldFetch=globalThis.fetch;let calls=[];
  globalThis.fetch=async url=>{calls.push(url);return new Response(JSON.stringify(url.includes('/auth/')?{id:'demo'}:[{id:'demo'}]),{status:200});};
  try{
    const req=images=>new Request('https://test.invalid/api/ai-rota',{method:'POST',headers:{authorization:'Bearer demo'},body:JSON.stringify({images})});
    assert.equal((await handler(req(Array(6).fill({mime:'image/png',data:'YQ=='})))).status,400);
    assert.equal((await handler(req([{mime:'image/png',data:'invalid base64'}]))).status,400);
    assert.equal(calls.some(x=>x.includes('api.openai.com')),false);
  }finally{globalThis.fetch=oldFetch;delete process.env.OPENAI_API_KEY;}
});
test('AI endpoint rejects invented calendar dates in provider output',async()=>{
  process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='test';process.env.OPENAI_API_KEY='unit-test-only';
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async url=>new Response(JSON.stringify(url.includes('api.openai.com')?{output_text:JSON.stringify({people:[{name:'Alex',entries:[{date:'2030-02-31',code:'OFF',confidence:'high'}]}],warnings:[]})}:url.includes('/auth/')?{id:'demo'}:[{id:'demo'}]),{status:200});
  try{
    const result=await handler(new Request('https://test.invalid/api/ai-rota',{method:'POST',headers:{authorization:'Bearer demo'},body:JSON.stringify({images:[{mime:'image/png',data:'YQ=='}]})}));
    assert.equal(result.status,502);
  }finally{globalThis.fetch=oldFetch;delete process.env.OPENAI_API_KEY;}
});
