// Local-only visual fixture: real candidate components, synthetic events, no APIs.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const names = ['pending-reasons', 'SyncPendingDetails', 'SyncRunReport'];
const modules = names.map(name => {
  const file = path.join(root, 'apps/web/src/components/sync', name + (name === 'pending-reasons' ? '.ts' : '.tsx'));
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.React}}).outputText;
  return `modules[${JSON.stringify('./'+name)}]=function(module,exports,require){${code}};`;
}).join('\n');
const bundle = `const modules={},cache={};function require(id){if(id==='react')return React;if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;} ${modules}
const events=[{action:'professional_cleanup_pending',message:'Homologação: leitura divergente; remoção não enviada.'},{action:'managed_scope_pending',message:'Homologação: resultado ainda não confirmado.'}];
let attempts=0;const fail=new URLSearchParams(location.search).has('error');
const loadEvents=async()=>{await new Promise(r=>setTimeout(r,600));if(fail&&attempts++===0)throw Error('synthetic');return events;};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
React.createElement(require('./SyncPendingDetails').SyncPendingDetails,{startedAt:'2026-09-19T22:00:00Z',source:'Homologação local',loadEvents}),
React.createElement(require('./SyncRunReport').SyncRunReport,{report:{version:2,categories:{},stages:[],agendas:{professional_cleanup_pending:2,managed_scope_pending:1},errors:0,warnings:3}})));
`;
const assets = {'/react.js':path.join(root,'node_modules/react/umd/react.development.js'),'/react-dom.js':path.join(root,'node_modules/react-dom/umd/react-dom.development.js')};
const cssDir = path.join(root,'apps/web/.next/static/css');
const server=http.createServer((req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle);}
 if(assets[req.url]){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(assets[req.url]));}
 if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end(fs.readdirSync(cssDir).filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(path.join(cssDir,f),'utf8')).join('\n'));}
 if(req.url==='/'||req.url==='/?error=1'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Homologação local — limpeza pendente</title><link rel="stylesheet" href="/style.css"><body style="padding:24px;background:#f8fafc"><h1 style="margin-bottom:20px">Homologação local — dados fictícios</h1><main id="root"></main><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/bundle.js"></script></body></html>');}
 res.writeHead(404);res.end();
});
server.listen(5417,'127.0.0.1',()=>console.log('Visual fixture: http://127.0.0.1:5417'));
