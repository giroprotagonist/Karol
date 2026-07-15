#!/usr/bin/env python3
"""Build self-contained HTML library page with embedded data."""
import json

with open('/tmp/karol-library-slim.json') as f:
    data = json.load(f)

json_str = json.dumps(data, ensure_ascii=False, separators=(',', ':'))

html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Karol Library — {data['c']} Videos</title>
<style>
:root{{--bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a26;--text:#e4e4ec;--t2:#8888a0;--accent:#8b5cf6;--green:#10b981;--amber:#f59e0b;--border:#222233;--radius:8px}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}}
header{{background:var(--bg2);border-bottom:1px solid var(--border);padding:12px 20px;position:sticky;top:0;z-index:10}}
header h1{{font-size:1.1rem;font-weight:700;margin-bottom:4px}}
.stats{{font-size:.78rem;color:var(--t2);display:flex;gap:14px;flex-wrap:wrap}}
.stats b{{color:var(--accent)}}
.controls{{padding:12px 20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--border);background:var(--bg2);position:sticky;top:68px;z-index:9}}
.controls input,.controls select{{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:var(--radius);font-size:.82rem}}
.controls input{{flex:1;min-width:180px;max-width:400px}}
.controls select{{min-width:100px}}
.filter-btn{{padding:6px 14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg3);color:var(--t2);cursor:pointer;font-size:.8rem;transition:all .15s}}
.filter-btn.active{{background:var(--accent);color:#fff;border-color:var(--accent)}}
.view-btn{{padding:6px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg3);color:var(--t2);cursor:pointer;font-size:.78rem;margin-left:auto}}
.view-btn.active{{background:var(--accent);color:#fff;border-color:var(--accent)}}
.count{{font-size:.78rem;color:var(--t2);margin-left:auto;white-space:nowrap}}
.list-view{{padding:0 20px 40px}}
.list-row{{display:grid;grid-template-columns:48px 1fr 180px 60px 60px 100px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:.82rem;cursor:pointer;transition:background .1s}}
.list-row:hover{{background:var(--bg2)}}
.list-row img{{width:40px;height:40px;border-radius:4px;object-fit:cover;background:var(--bg3)}}
.list-row .title{{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.list-row .artist{{color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.list-row .year{{color:var(--amber);text-align:center}}
.list-row .dur{{color:var(--t2);text-align:center}}
.badge{{display:inline-block;padding:1px 7px;border-radius:10px;font-size:.68rem;font-weight:600;justify-self:center}}
.badge-k{{background:rgba(139,92,246,.15);color:var(--accent)}}
.badge-s{{background:rgba(16,185,129,.1);color:var(--green)}}
.grid-view{{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding:12px 20px 40px}}
.grid-card{{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:border-color .15s,transform .1s}}
.grid-card:hover{{border-color:var(--accent);transform:translateY(-2px)}}
.grid-card img{{width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--bg3)}}
.grid-card .info{{padding:10px}}
.grid-card .title{{font-size:.82rem;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:4px}}
.grid-card .meta{{font-size:.72rem;color:var(--t2);display:flex;gap:8px;align-items:center}}
.grid-card .badge{{margin-left:auto}}
.grid-card .thumb-link{{display:block}}
.sort-link{{cursor:pointer;color:var(--t2);font-size:.72rem;padding:2px 4px;border-radius:3px;user-select:none}}
.sort-link:hover,.sort-link.active{{color:var(--accent)}}
.sort-link.active::after{{content:'▾';margin-left:2px;font-size:.6rem}}
.sort-link.active.asc::after{{content:'▴'}}
.empty{{text-align:center;padding:60px 20px;color:var(--t2)}}
a{{color:var(--accent);text-decoration:none}}
@media(max-width:700px){{.list-row{{grid-template-columns:36px 1fr 60px 60px}} .list-row .artist,.list-row .badge{{display:none}}}}
</style>
</head>
<body>
<header>
<h1>Karol Video Library</h1>
<div class="stats">
<span>Library: <b id="statTotal">{data['c']}</b></span>
<span>Karaoke: <b id="statKar" style="color:var(--accent)">{data['k']}</b></span>
<span>Songs: <b id="statSng" style="color:var(--green)">{data['s']}</b></span>
</div>
</header>
<div class="controls" id="controls">
<input type="text" id="search" placeholder="Search {data['c']} videos…" autofocus>
<button class="filter-btn active" data-filter="all">All</button>
<button class="filter-btn" data-filter="karaoke">Karaoke</button>
<button class="filter-btn" data-filter="song">Songs</button>
<select id="sort">
<option value="year">Year</option>
<option value="title">Title</option>
<option value="artist">Artist</option>
<option value="duration">Duration</option>
</select>
<button class="view-btn active" id="viewList">List</button>
<button class="view-btn" id="viewGrid">Grid</button>
<span class="count" id="resultCount"></span>
</div>
<div id="listView" class="list-view"></div>
<div id="gridView" class="grid-view" style="display:none"></div>
<script>
var D={json_str};
var videos=D.v;
var total=D.c;
var filters={{tag:'all',search:'',sort:'year',asc:false,view:'list'}};
var elSearch=document.getElementById('search');
var filterBtns=document.querySelectorAll('[data-filter]');

// ── Rendering ──
function timeStr(s){{var m=Math.floor(s/60);var sec=Math.floor(s%60);return m+':'+String(sec).padStart(2,'0')}}

function render() {{
var result=videos.slice();
// Filter tag
if(filters.tag==='karaoke') result=result.filter(function(v){{return v.g==='karaoke'}});
if(filters.tag==='song') result=result.filter(function(v){{return v.g==='song'||v.g==='music'}});
// Filter search
var q=filters.search.toLowerCase().trim();
if(q) result=result.filter(function(v){{return v.t.toLowerCase().indexOf(q)>=0||v.a.toLowerCase().indexOf(q)>=0}});
// Sort
var sa=filters.sort;
var asc=filters.asc;
result.sort(function(a,b){{
var cmp=0;
if(sa==='title') cmp=a.t.toLowerCase().localeCompare(b.t.toLowerCase());
else if(sa==='artist') cmp=a.a.toLowerCase().localeCompare(b.a.toLowerCase());
else if(sa==='year') cmp=(parseInt(a.y)||0)-(parseInt(b.y)||0);
else if(sa==='duration') cmp=(a.d||0)-(b.d||0);
return asc?cmp:-cmp;
}});
document.getElementById('resultCount').textContent='Showing '+result.length+' of '+total;
renderList(result);
renderGrid(result);
}}

function ytLink(id){{return 'https://www.youtube.com/watch?v='+id}}

function thumbUrl(id){{return 'https://i.ytimg.com/vi/'+id+'/mqdefault.jpg'}}

function renderList(result) {{
var html='<div class="list-row" style="color:var(--t2);font-size:.72rem"><span></span>'+
'<span class="sort-link'+ (filters.sort==='title'?' active'+(filters.asc?' asc':''):'')+'" data-sort="title">Title</span>'+
'<span class="sort-link'+ (filters.sort==='artist'?' active'+(filters.asc?' asc':''):'')+'" data-sort="artist">Artist</span>'+
'<span class="sort-link'+ (filters.sort==='year'?' active'+(filters.asc?' asc':''):'')+'" data-sort="year">Year</span>'+
'<span class="sort-link'+ (filters.sort==='duration'?' active'+(filters.asc?' asc':''):'')+'" data-sort="duration">Dur</span>'+
'<span>Type</span></div>';
for(var i=0;i<result.length;i++){{
var v=result[i];
html+='<a class="list-row" href="'+ytLink(v.id)+'" target="_blank">'+
'<img src="'+thumbUrl(v.id)+'" loading="lazy" alt="">'+
'<span class="title">'+esc(v.t)+'</span>'+
'<span class="artist">'+esc(v.a||'—')+'</span>'+
'<span class="year">'+(v.y||'—')+'</span>'+
'<span class="dur">'+timeStr(v.d)+'</span>'+
(v.g==='karaoke'?'<span class="badge badge-k">K</span>':'<span class="badge badge-s">S</span>')+
'</a>';
}}
if(!result.length) html='<div class="empty">No videos found matching your search.</div>';
document.getElementById('listView').innerHTML=html;
}}

function renderGrid(result) {{
var html='';
for(var i=0;i<result.length;i++){{
var v=result[i];
html+='<a class="grid-card" href="'+ytLink(v.id)+'" target="_blank">'+
'<img src="'+thumbUrl(v.id)+'" loading="lazy" alt="">'+
'<div class="info">'+
'<div class="title">'+esc(v.t)+'</div>'+
'<div class="meta">'+
'<span>'+esc(v.a||'—')+'</span>'+
'<span>•</span>'+
'<span>'+timeStr(v.d)+'</span>'+
(v.g==='karaoke'?'<span class="badge badge-k">K</span>':'<span class="badge badge-s">S</span>')+
'</div></div></a>';
}}
if(!result.length) html='<div class="empty">No videos found matching your search.</div>';
document.getElementById('gridView').innerHTML=html;
}}

function esc(s){{var d=document.createElement('div');d.textContent=s;return d.innerHTML}}

// ── Events ──
elSearch.oninput=function(){{filters.search=this.value;render()}};
filterBtns.forEach(function(b){{b.onclick=function(){{filterBtns.forEach(function(x){{x.classList.remove('active')}});this.classList.add('active');filters.tag=this.dataset.filter;render()}}}});
document.getElementById('sort').onchange=function(){{filters.sort=this.value;render()}};
document.getElementById('viewList').onclick=function(){{filters.view='list';document.getElementById('listView').style.display='block';document.getElementById('gridView').style.display='none';this.classList.add('active');document.getElementById('viewGrid').classList.remove('active')}};
document.getElementById('viewGrid').onclick=function(){{filters.view='grid';document.getElementById('listView').style.display='none';document.getElementById('gridView').style.display='grid';this.classList.add('active');document.getElementById('viewList').classList.remove('active')}};
document.addEventListener('click',function(e){{
var s=e.target.closest('.sort-link');
if(!s) return;
var col=s.dataset.sort;
if(col===filters.sort) filters.asc=!filters.asc;
else {{filters.sort=col;filters.asc=false}}
render();
}});

// Keyboard shortcut: / to focus search
document.addEventListener('keydown',function(e){{if(e.key==='/'&&document.activeElement!==elSearch){{e.preventDefault();elSearch.focus()}}}});

render();
</script>
</body>
</html>'''

import os
out_path = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/karol-library.html'
with open(out_path, 'w') as f:
    f.write(html)

size = os.path.getsize(out_path)
print(f'Wrote {size/1024/1024:.1f} MB to {out_path}')
