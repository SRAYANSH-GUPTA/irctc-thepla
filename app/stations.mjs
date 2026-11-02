import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect} from '../scripts/lib/cdp.mjs';
import {DEBUG} from './browser.mjs';

const catalogPath=fileURLToPath(new URL('../data/stations.json',import.meta.url));
const source='https://www.irctc.co.in/eticketing/protected/mapps1/stationData';
const norm=s=>String(s||'').trim().replace(/\s+/g,' ').toUpperCase();
const clean=s=>typeof s==='string'?s.trim().slice(0,140):'';

export function sanitizeStations(rows){
  if(!Array.isArray(rows)||rows.length>30000)throw Error('The IRCTC station list has an unexpected format.');
  const unique=new Map();
  for(const row of rows){
    if(!row||typeof row!=='object')continue;
    const code=norm(row.sc),name=clean(row.en);
    if(!/^[A-Z0-9]{1,8}$/.test(code)||!name)continue;
    unique.set(code,{code,name,hindi:clean(row.hi),city:clean(row.ec),state:clean(row.se),aliases:clean(row.tg)});
  }
  if(!unique.size)throw Error('The IRCTC station list is empty.');
  return [...unique.values()];
}

export class StationCatalog {
  constructor({path=catalogPath,data}={}){
    this.path=path;this.refreshing=null;
    try{this.data=data||JSON.parse(readFileSync(path,'utf8'));}catch{this.data={stations:[],fetchedAt:null,source};}
  }
  metadata(){return {total:this.data.stations.length,fetchedAt:this.data.fetchedAt,source};}
  search(query){
    const q=norm(query).slice(0,100);
    const ranked=this.data.stations.map(s=>{
      const name=norm(s.name),code=s.code;
      const rank=!q?5:code===q?0:code.startsWith(q)?1:name.startsWith(q)?2:name.includes(q)?3:norm([s.city,s.hindi,s.state,s.aliases].join(' ')).includes(q)?4:99;
      return {s,rank};
    }).filter(r=>r.rank<99).sort((a,b)=>a.rank-b.rank||a.s.name.localeCompare(b.s.name)).slice(0,15);
    return {...this.metadata(),stations:ranked.map(({s})=>s)};
  }
  resolve(query){
    const q=norm(query),code=q.match(/\(([A-Z0-9]{1,8})\)$/)?.[1]||q;
    const matches=this.data.stations.filter(s=>s.code===code||norm(s.name)===q);
    if(matches.length!==1)throw Error('Choose an exact station from the suggestions, or enter its official code.');
    return matches[0].code;
  }
  refresh(){
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.fetchFromBrowser().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
  async fetchFromBrowser(){
    const c=await connect(DEBUG);
    let rows;
    try{
      // Only the observed public station catalog is read. No cookies, login
      // tokens, passenger records, or account storage is copied.
      rows=await c.evaluate(()=>{
        const raw=localStorage.getItem('nget-spa.station-list-new');
        if(!raw)return null;
        const rows=JSON.parse(raw);
        if(!Array.isArray(rows)||rows.length>30000)return null;
        return rows.map(r=>({sc:r.sc,en:r.en,hi:r.hi,ec:r.ec,se:r.se,tg:r.tg}));
      });
    }finally{c.close();}
    if(!rows)throw Error('Open the IRCTC search page once to load its stations, then refresh this list.');
    const next={source,fetchedAt:new Date().toISOString(),stations:sanitizeStations(rows)};
    await mkdir(dirname(this.path),{recursive:true});
    await writeFile(this.path+'.tmp',JSON.stringify(next)+'\n');
    await rename(this.path+'.tmp',this.path);this.data=next;
    return this.metadata();
  }
}
