import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../public');
const config={"SUPABASE_URL":"https://nzammlxedwlmecihxizc.supabase.co","SUPABASE_PUBLISHABLE_KEY":"sb_publishable_Dc_MsZ9bpQYIuG0bq9Vbtg_PO0G07sh"};
http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 res.setHeader('cache-control','no-store');
 if(pathname==='/config.js'){res.setHeader('content-type','text/javascript');res.end('window.APP_CONFIG='+JSON.stringify(config)+';');return;}
 const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 let body=fs.readFileSync(file);
 if(path.extname(file)==='.html')body=body.toString().replace('<body>','<body><div style="padding:8px;text-align:center;background:#713f12;color:white">STAGING — test accounts and data only</div>');
 const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 res.setHeader('content-type',mime[path.extname(file)]||'text/plain');res.end(body);
}).listen(4174,'127.0.0.1',()=>console.log('Staging app: http://127.0.0.1:4174'));

