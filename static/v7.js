/* TimeSave Social V7 – visual editor, multi-day tarot plans, and editable queue.
   No third-party upload SDK is loaded. The browser paints the exact JPG it saves. */
'use strict';
let studioImage=null, studioImageUrl=null, studioBusy=false, currentStudioId='',calendarMediaKey='';
let v209StudioTextLayers = [];
let v209ActiveImgLayer = -1;
let v209ImgHitBoxes = [];

function v209MakeImgTextLayer(yPct = 49) {
  return {
    text: '',
    font: $('studioFont')?.value || 'Georgia',
    size: 54,
    color: '#ffffff',
    box: 'glass',
    align: 'center',
    x: 50,
    y: yPct,
  };
}

function v209LoadImgLayerToInputs() {
  const editor = $('v209ImgTextEditor');
  const layer = v209StudioTextLayers[v209ActiveImgLayer];
  if ($('v209ImgLayerCount')) {
    $('v209ImgLayerCount').textContent = v209StudioTextLayers.length + (v209StudioTextLayers.length === 1 ? ' Textfeld' : ' Textfelder');
  }
  if (!layer) {
    if (editor) editor.hidden = true;
    v209RenderImgLayerChips();
    paintStudio();
    return;
  }
  if (editor) editor.hidden = false;
  if ($('v209ImgActiveLabel')) $('v209ImgActiveLabel').textContent = 'Textfeld ' + (v209ActiveImgLayer + 1) + ' bearbeiten';
  if ($('studioText')) $('studioText').value = layer.text || '';
  if ($('v209ImgCharCount')) $('v209ImgCharCount').textContent = '(' + (layer.text || '').length + ' / 2000 Zeichen)';
  if ($('studioFontSize')) $('studioFontSize').value = String(layer.size ?? 54);
  if ($('studioAlign')) $('studioAlign').value = layer.align || 'center';
  if ($('studioColor')) $('studioColor').value = layer.color || '#ffffff';
  if ($('studioBox')) $('studioBox').value = layer.box || 'glass';
  if ($('studioX')) $('studioX').value = String(layer.x ?? 50);
  if ($('studioY')) $('studioY').value = String(layer.y ?? 49);
  v209RenderImgLayerChips();
  paintStudio();
}

function v209SyncImgLayerFromInputs() {
  const layer = v209StudioTextLayers[v209ActiveImgLayer];
  if (!layer) { paintStudio(); return; }
  layer.text = $('studioText')?.value || '';
  layer.font = $('studioFont')?.value || 'Georgia';
  layer.size = +($('studioFontSize')?.value || 54);
  layer.align = $('studioAlign')?.value || 'center';
  layer.color = $('studioColor')?.value || '#ffffff';
  layer.box = $('studioBox')?.value || 'glass';
  layer.x = +($('studioX')?.value || 50);
  layer.y = +($('studioY')?.value || 49);
  if ($('v209ImgCharCount')) $('v209ImgCharCount').textContent = '(' + layer.text.length + ' / 2000 Zeichen)';
  v209RenderImgLayerChips();
  paintStudio();
}

function v209RenderImgLayerChips() {
  const root = $('v209ImgLayerList');
  if (!root) return;
  root.innerHTML = v209StudioTextLayers.map((l, idx) => {
    const snippet = (l.text || '').trim().slice(0, 16);
    return `<button type="button" class="v177-layer-chip ${idx === v209ActiveImgLayer ? 'active' : ''}" data-img-layer="${idx}">Text ${idx + 1}${snippet ? ': ' + esc(snippet) : ''}</button>`;
  }).join('');
  root.querySelectorAll('[data-img-layer]').forEach(btn => {
    btn.addEventListener('click', () => {
      v209ActiveImgLayer = Number(btn.dataset.imgLayer);
      v209LoadImgLayerToInputs();
    });
  });
}

function v209AddStudioTextLayer() {
  const offsets = [49, 24, 74, 36, 62];
  const yDefault = offsets[v209StudioTextLayers.length % offsets.length];
  v209StudioTextLayers.push(v209MakeImgTextLayer(yDefault));
  v209ActiveImgLayer = v209StudioTextLayers.length - 1;
  v209LoadImgLayerToInputs();
  setTimeout(() => $('studioText')?.focus(), 20);
}

function v209DuplicateStudioTextLayer() {
  const cur = v209StudioTextLayers[v209ActiveImgLayer];
  if (!cur) return;
  const copy = { ...cur, y: Math.min(87, (cur.y ?? 49) + 10) };
  v209StudioTextLayers.push(copy);
  v209ActiveImgLayer = v209StudioTextLayers.length - 1;
  v209LoadImgLayerToInputs();
}

function v209RemoveStudioTextLayer() {
  if (!v209StudioTextLayers.length) return;
  v209StudioTextLayers.splice(v209ActiveImgLayer, 1);
  v209ActiveImgLayer = v209StudioTextLayers.length ? Math.max(0, v209ActiveImgLayer - 1) : -1;
  v209LoadImgLayerToInputs();
}
const studioDimensions={story:[1080,1920],portrait:[1080,1350],square:[1080,1080]};
const editorNames=['Frage & Kartenrückseiten','Karte 1 & Deutung','Karte 2 & Deutung','Karte 3 & Deutung'];
const prevNav=nav;
nav=function(id){
  prevNav(id);
  if(id==='studio'){
    $('pageTitle').textContent='Design Studio';
    if(!$('studioSource').value){const source=chosen||$('composerMedia').value;if(source)openStudio(source)}
    else paintStudio();
  }
  if(id==='tarot' && !$('calendarDays').children.length)buildCalendar();
};
const prevRenderMediaChoices=renderMediaChoices;
renderMediaChoices=function(){
  prevRenderMediaChoices();
  const select=$('studioSource');
  const old=select.value||currentStudioId;
  select.innerHTML='<option value="">– Originalbild auswählen –</option>'+media.filter(m=>m.mime.startsWith('image/'))
     .map(m=>`<option value="${esc(m.id)}">${esc(m.original_name)}</option>`).join('');
  if(media.some(m=>m.id===old))select.value=old;
  showComposerPreview();
  syncCalendarOptions();
};

function showComposerPreview(){
  const mid=$('composerMedia').value;
  const image=$('composerPreview');
  image.hidden=true;
  if(!mid||!media.some(m=>m.id===mid && m.mime.startsWith('image/')))return;
  const requestId=mid;
  fetch('/api/media/'+requestId,{headers:{'X-Admin-Token':auth}})
    .then(r=>r.ok?r.blob():Promise.reject(Error('Bild fehlt')))
    .then(b=>{
      if($('composerMedia').value!==requestId)return;
      const url=URL.createObjectURL(b);
      image.onload=()=>URL.revokeObjectURL(url);
      image.src=url; image.hidden=false;
    }).catch(()=>{});
}

function openStudio(id){
  if(!id||!media.some(m=>m.id===id&&m.mime.startsWith('image/'))){
    toast('Bitte zuerst im Bilder-Fundus ein JPG-/PNG-Bild auswählen.',true);
    nav('library');return;
  }
  nav('studio');
  $('studioSource').value=id;
  studioChoose();
}
async function studioChoose(){
  const id=$('studioSource').value;
  if(!id){studioImage=null;currentStudioId='';paintStudio();return}
  try{
    const response=await fetch('/api/media/'+id,{headers:{'X-Admin-Token':auth}});
    if(!response.ok)throw Error('Bild konnte nicht geladen werden');
    const objectURL=URL.createObjectURL(await response.blob());
    const img=new Image();
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=objectURL});
    if(studioImageUrl)URL.revokeObjectURL(studioImageUrl);
    studioImageUrl=objectURL;
    studioImage=img;
    currentStudioId=id;
    paintStudio();
  }catch(e){toast(e.message,true)}
}
function studioControls(){
  const id=name=>$(name).value;
  return {kind:id('studioFormat'),fit:id('studioFit'),
    text:id('studioText').trim(),font:id('studioFont'),size:+id('studioFontSize'),
    color:id('studioColor'),box:id('studioBox'),align:id('studioAlign'),x:+id('studioX'),y:+id('studioY')};
}
function wrapCanvasText(ctx,text,maxWidth){
  const all=[];
  text.split(/\r?\n/).forEach(p=>{
    if(!p.trim()){all.push('');return}
    let line='';
    p.split(/\s+/).forEach(word=>{
      let proposed=line?line+' '+word:word;
      if(line&&ctx.measureText(proposed).width>maxWidth){all.push(line);line=word}
      else line=proposed;
    });
    all.push(line);
  });
  return all.slice(0,65);
}
function paintStudio(forExport=false){
  const canvas=$('studioCanvas'); if(!canvas)return;
  const opt=studioControls();
  const [w,h]=studioDimensions[opt.kind]||studioDimensions.story;
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#1b162c';ctx.fillRect(0,0,w,h);
  const img=studioImage;
  const look=$('studioLook')?.value||'original';
  const looks={original:'',clean:'contrast(1.07) saturate(1.16) brightness(1.03)',vivid:'saturate(1.38) contrast(1.07)',warm:'sepia(.23) saturate(1.20) brightness(1.07)',cinema:'contrast(1.18) saturate(.92) brightness(.97)',soft:'brightness(1.08) contrast(.94) saturate(1.06)',cool:'hue-rotate(12deg) saturate(1.15)',mono:'grayscale(1) contrast(1.10)'};
  const v203Fine = (typeof window.v203StudioFilterString === 'function') ? window.v203StudioFilterString() : '';
  const combinedFilter = [looks[look]||'', v203Fine].filter(Boolean).join(' ') || 'none';
  if(img){
    ctx.filter=combinedFilter;
    const coverScale=Math.max(w/img.width,h/img.height);
    const containScale=Math.min(w/img.width,h/img.height);
    const drawScaled=(scale)=>{
      const sw=img.width*scale,sh=img.height*scale;
      ctx.drawImage(img,(w-sw)/2,(h-sh)/2,sw,sh);
    };
    if(opt.fit==='blur'){
      ctx.save();ctx.filter='blur(70px) brightness(.68)';drawScaled(coverScale*1.12);ctx.restore();
      drawScaled(containScale);
    }else if(opt.fit==='contain') drawScaled(containScale);
    else drawScaled(coverScale);
  }else{
    ctx.textAlign='center';ctx.font='52px Georgia';ctx.fillStyle='#ddc8ff';
    ctx.fillText('Wähle ein Bild aus dem Fundus',w/2,h/2);
  }
  ctx.filter='none';
  const v203Vig = Number($('v203Vignette')?.value || 0);
  if(v203Vig > 0){
    const vg = ctx.createRadialGradient(w/2, h/2, Math.min(w,h)*0.28, w/2, h/2, Math.max(w,h)*0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(8,12,26,' + (v203Vig/100 * 0.72).toFixed(3) + ')');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }
  const tint=$('studioTint')?.value||'none';
  const tints={violet:['rgba(40,17,79,0)','rgba(70,26,116,.48)'],rose:['rgba(100,21,91,0)','rgba(134,42,93,.36)'],gold:['rgba(74,30,3,0)','rgba(182,97,18,.29)'],teal:['rgba(9,53,56,0)','rgba(4,115,110,.34)']};
  if(tints[tint]){const g=ctx.createLinearGradient(0,h*.16,0,h);g.addColorStop(0,tints[tint][0]);g.addColorStop(1,tints[tint][1]);ctx.fillStyle=g;ctx.fillRect(0,0,w,h)}
  const decor=$('studioDecor')?.value||'none';
  ctx.save();
  if(decor==='line'){
    ctx.strokeStyle='rgba(255,237,204,.88)';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(w*.09,h*.105);ctx.lineTo(w*.91,h*.105);ctx.moveTo(w*.09,h*.895);ctx.lineTo(w*.91,h*.895);ctx.stroke();
  }else if(decor==='stars'){
    const points=[[.13,.13,18],[.82,.16,23],[.87,.81,18],[.19,.86,27],[.72,.89,14],[.27,.22,12]];
    ctx.fillStyle='rgba(255,230,187,.92)';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='35px Georgia';
    points.forEach(([x,y,size])=>{ctx.font=size*2+'px Georgia';ctx.fillText('✦',w*x,h*y)});
  }
  ctx.restore();
  v209ImgHitBoxes = [];
  const activeFontFamily = $('studioFont')?.value || 'Georgia';
  v209StudioTextLayers.forEach((layer, idx) => {
    const rawText = (layer.text || '').trim();
    if (!rawText) return;
    ctx.save();
    let fSize = Number(layer.size || 54);
    const maxWidth = w * 0.82;
    ctx.font = `bold ${fSize}px "${activeFontFamily}", Arial, sans-serif`;
    let lines = wrapCanvasText(ctx, rawText, maxWidth);
    // Auto-scale down gently if very long text (500+ chars) would exceed 86% of canvas height
    while (lines.length * fSize * 1.26 > h * 0.84 && fSize > 22) {
      fSize = Math.max(22, fSize - 3);
      ctx.font = `bold ${fSize}px "${activeFontFamily}", Arial, sans-serif`;
      lines = wrapCanvasText(ctx, rawText, maxWidth);
    }
    ctx.textBaseline = 'middle';
    const lineHeight = fSize * 1.26;
    const totalHeight = lines.length * lineHeight;
    const boxW = w * 0.90;
    const boxH = Math.min(h * 0.92, totalHeight + fSize * 1.35);
    const centerX = w * (layer.x ?? 50) / 100;
    const centerY = h * (layer.y ?? 49) / 100;
    const left = Math.max(12, Math.min(w - boxW - 12, centerX - boxW / 2));
    const top = Math.max(12, Math.min(h - boxH - 12, centerY - boxH / 2));
    v209ImgHitBoxes.push({ idx, left, top, right: left + boxW, bottom: top + boxH });
    if (layer.box !== 'none') {
      ctx.fillStyle = layer.box === 'light' ? 'rgba(255,251,249,.82)' : 'rgba(15,11,38,.74)';
      ctx.beginPath(); ctx.roundRect(left, top, boxW, boxH, 28); ctx.fill();
    }
    if (!forExport && idx === v209ActiveImgLayer) {
      ctx.strokeStyle = 'rgba(245, 196, 81, 0.85)';
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 8]);
      ctx.beginPath(); ctx.roundRect(left, top, boxW, boxH, 28); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = layer.color || '#ffffff';
    ctx.shadowColor = layer.box === 'none' ? 'rgba(0,0,0,.85)' : 'rgba(0,0,0,.28)';
    ctx.shadowBlur = layer.box === 'none' ? 13 : 5;
    ctx.textAlign = layer.align || 'center';
    const tx = layer.align === 'left' ? left + 48 : layer.align === 'right' ? left + boxW - 48 : left + boxW / 2;
    const firstY = top + (boxH - totalHeight) / 2 + lineHeight / 2;
    lines.forEach((line, i) => ctx.fillText(line, tx, firstY + lineHeight * i, maxWidth));
    ctx.restore();
  });
  const signature=$('studioSignature')?.value.trim()||'';
  if(signature){ctx.save();ctx.font='700 31px Arial,sans-serif';ctx.textAlign='center';
    ctx.fillStyle='rgba(255,255,255,.95)';ctx.shadowColor='rgba(0,0,0,.85)';ctx.shadowBlur=12;
    ctx.fillText('✦ '+signature+' ✦',w/2,h*.948,w*.85);ctx.restore();}
  if(!forExport && opt.kind==='story'){
    ctx.save();ctx.strokeStyle='rgba(245,239,255,.55)';ctx.setLineDash([14,12]);ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(24,240);ctx.lineTo(w-24,240);ctx.moveTo(24,h-300);ctx.lineTo(w-24,h-300);ctx.stroke();
    ctx.restore();
  }
  $('fontOut').textContent=opt.size;$('xOut').textContent=opt.x;$('yOut').textContent=opt.y;
}
$('studioCanvas').addEventListener('pointerdown',ev=>{
  if(!v209StudioTextLayers.length)return;
  const canvas=$('studioCanvas'),rect=canvas.getBoundingClientRect();
  const cx=(ev.clientX-rect.left)/rect.width*canvas.width;
  const cy=(ev.clientY-rect.top)/rect.height*canvas.height;
  for(let i=v209ImgHitBoxes.length-1;i>=0;i--){
    const b=v209ImgHitBoxes[i];
    if(cx>=b.left && cx<=b.right && cy>=b.top && cy<=b.bottom){
      if(v209ActiveImgLayer!==b.idx){
        v209ActiveImgLayer=b.idx;
        v209LoadImgLayerToInputs();
      }
      break;
    }
  }
  if(v209ActiveImgLayer<0)return;
  ev.currentTarget.setPointerCapture(ev.pointerId);
  moveStudioText(ev);
});
$('studioCanvas').addEventListener('pointermove',ev=>{
  if(ev.buttons===1 && ev.currentTarget.hasPointerCapture(ev.pointerId))moveStudioText(ev);
});
function moveStudioText(event){
  const layer=v209StudioTextLayers[v209ActiveImgLayer];
  if(!layer)return;
  const canvas=$('studioCanvas'),rect=canvas.getBoundingClientRect();
  const px=Math.max(12,Math.min(88,Math.round((event.clientX-rect.left)/rect.width*100)));
  const py=Math.max(13,Math.min(87,Math.round((event.clientY-rect.top)/rect.height*100)));
  layer.x=px; layer.y=py;
  $('studioX').value=px;$('studioY').value=py;paintStudio();
}
async function saveStudio(continuePlanning){
  if(studioBusy)return;
  try{
    if(!studioImage)throw Error('Bitte zuerst ein Bild im Designer auswählen.');
    studioBusy=true;
    const bar=$('v184ImageBar'), info=$('v184ImageInfo');
    bar.hidden=false; bar.value=5; info.textContent='5% · Bild wird vorbereitet …';
    await new Promise(resolve=>setTimeout(resolve,0));
    paintStudio(true);
    bar.value=20; info.textContent='20% · JPG wird erzeugt …';
    const canvas=$('studioCanvas');
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.92));
    if(!blob)throw Error('Das fertige Bild konnte nicht erzeugt werden.');
    const format=$('studioFormat').value;
    const name='TimeSave_Social_'+(format==='story'?'Story':format==='portrait'?'Beitrag_4x5':'Beitrag_Quadrat')+'_'+Date.now()+'.jpg';
    const fd=new FormData();fd.append('file',blob,name);
    bar.value=35; info.textContent='35% · JPG wird übertragen …';
    const out=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('POST','/api/media'); xhr.setRequestHeader('X-Admin-Token',auth);
      xhr.upload.onprogress=ev=>{
        if(ev.lengthComputable){bar.value=35+Math.floor(55*ev.loaded/ev.total); info.textContent=bar.value+'% · JPG wird übertragen …';}
      };
      xhr.upload.onload=()=>{bar.value=90; info.textContent='90% · Bild wird gespeichert …';};
      xhr.onload=()=>{let body={};try{body=JSON.parse(xhr.responseText)}catch{};
        if(xhr.status>=200&&xhr.status<300&&body.id)resolve(body);else reject(new Error(typeof body.detail==='string'?body.detail:'Export fehlgeschlagen (HTTP '+xhr.status+')'));};
      xhr.onerror=()=>reject(new Error('Netzwerkfehler beim Bildexport.'));
      xhr.onabort=()=>reject(new Error('Bildexport abgebrochen.'));
      xhr.send(fd);
    });
    bar.value=100; info.textContent='100% · Bild erfolgreich gespeichert.';
    chosen=out.id;
    await refresh();
    $('composerMedia').value=out.id;
    $('postCaption').value=$('studioCaption').value;
    if(continuePlanning){
      nav('composer');showComposerPreview();
      toast('Fertiges Design gespeichert. Jetzt Plattformen und Termin wählen.');
    }else{
      nav('library');toast('Neues JPG im Bilder-Fundus gespeichert. Dein Original bleibt erhalten.');
    }
  }catch(e){if($('v184ImageInfo')) $('v184ImageInfo').textContent='⚠ '+e.message;toast(e.message,true)}
  finally{studioBusy=false;paintStudio()}
}

// Each calendar row is an independently editable day, with 4 independent images.
function buildCalendar(){
  const total=Number($('calDays').value);
  if(!Number.isInteger(total)||total<1||total>60){toast('Bitte 1–60 Tage wählen.',true);return}
  const start=$('calStart').value;
  if(!start){toast('Bitte zuerst einen Starttermin eingeben.',true);return}
  const opt='<option value="">— Bild auswählen —</option>'+media.filter(m=>m.mime.startsWith('image/'))
    .map(m=>`<option value="${esc(m.id)}">${esc(m.original_name)}</option>`).join('');
  const src=new Date(start);
  const rows=Array.from({length:total},(_,d)=>{
    const date=new Date(src.getTime());date.setDate(date.getDate()+d);
    const label=date.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'});
    const slots=editorNames.map((title,i)=>`<div class="calendar-slot"><span class="slot-bubble">${i+1}</span><div><label>${esc(title)}</label><select data-day="${d}" data-pos="${i}" class="calendar-image">${opt}</select></div><div><label>Deutung / Caption (optional)</label><input maxlength="2200" data-caption-day="${d}" data-caption-pos="${i}" placeholder="Text (oder bereits im Bild)"></div></div>`).join('');
    return `<details class="calendar-day" ${d===0?'open':''}><summary><b>Tag ${d+1}</b> · ${label}<span class="calendar-day-state" id="calState${d}">0 / 4 Bilder</span></summary><div>${slots}</div></details>`;
  }).join('');
  $('calendarDays').innerHTML=rows;
  $('calCount').textContent=total+' Tage × 4 Bilder = '+(total*4)+' Dateien';
  $('calendarDays').querySelectorAll('select.calendar-image').forEach(el=>el.addEventListener('change',updateCalendarProgress));
  calendarMediaKey=media.filter(m=>m.mime.startsWith('image/')).map(m=>m.id).join('|');
  updateCalendarProgress();
}
function syncCalendarOptions(){
  const selects=$('calendarDays').querySelectorAll('select.calendar-image');
  if(!selects.length)return;
  const pictures=media.filter(m=>m.mime.startsWith('image/'));
  const nextKey=pictures.map(m=>m.id).join('|');
  if(nextKey===calendarMediaKey)return;
  const options='<option value="">— Bild auswählen —</option>'+pictures.map(m=>`<option value="${esc(m.id)}">${esc(m.original_name)}</option>`).join('');
  selects.forEach(sel=>{const old=sel.value;sel.innerHTML=options;if(pictures.some(m=>m.id===old))sel.value=old});
  calendarMediaKey=nextKey;updateCalendarProgress();
}
function updateCalendarProgress(){
  for(const day of $('calendarDays').querySelectorAll('.calendar-day')){
    const filled=Array.from(day.querySelectorAll('select.calendar-image')).filter(x=>x.value).length;
    day.querySelector('.calendar-day-state').textContent=filled+' / 4 Bilder';
    day.classList.toggle('ready',filled===4);
  }
}
function autoFillCalendar(){
  const count=$('calendarDays').querySelectorAll('select.calendar-image').length;
  if(!count){toast('Bitte zuerst „Tage vorbereiten“ klicken.',true);return}
  const images=media.filter(m=>m.mime.startsWith('image/')).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  if(images.length<count){toast('Für diesen Zeitraum benötigst du '+count+' verschiedene Bilder. Im Fundus sind erst '+images.length+'.',true);return}
  const picked=images.slice(-count);
  $('calendarDays').querySelectorAll('select.calendar-image').forEach((el,i)=>el.value=picked[i].id);
  updateCalendarProgress();toast('Bilder chronologisch zugeordnet. Bitte jede Tages-Reihenfolge kontrollieren!');
}
async function submitCalendar(){
  try{
    const rows=Array.from($('calendarDays').querySelectorAll('.calendar-day'));
    if(!rows.length)throw Error('Bitte zuerst deine Tage vorbereiten.');
    if(!confirm('Jetzt '+rows.length+' Tage mit jeweils vier Karten pro Plattform einplanen?'))return;
    const days=rows.map((row,idx)=>{
      const mids=Array.from(row.querySelectorAll('.calendar-image')).map(el=>el.value);
      if(mids.some(x=>!x))throw Error('Tag '+(idx+1)+': Noch nicht alle vier Bilder ausgewählt.');
      const captions=Array.from(row.querySelectorAll('[data-caption-day]')).map(el=>el.value);
      return {media_ids:mids,captions};
    });
    const payload={days,targets:chosenTargets('fourTargets'),start_at:$('calStart').value,gap_minutes:Number($('calGap').value)};
    const result=await json('/api/plan/calendar',payload);
    await refresh();nav('queue');toast(result.days+' Tage erfolgreich geplant: '+result.count+' Aufträge mit Karten-Reihenfolge.');
  }catch(e){toast(e.message,true)}
}

function toLocalInput(iso){
  const date=new Date(iso);
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function editJob(id){
  const job=jobs.find(j=>j.id===id);
  if(!job||job.status!=='scheduled'){toast('Nur geplante Aufträge sind bearbeitbar.',true);return}
  $('editJobId').value=id;
  $('editMedia').innerHTML=mediaOptions();$('editMedia').value=job.media_id;
  $('editCaption').value=job.caption||'';
  $('editFormat').value=job.format;
  $('editDue').value=toLocalInput(job.due_at);
  $('editDue').disabled=!!job.series_id;
  $('editNote').textContent=job.series_id
    ?'🔒 Termin gesperrt: Diese Veröffentlichung gehört zu einer Tarot-Viererfolge. Bild, Beschreibung und Format bleiben bearbeitbar.'
    :'Du kannst das Bild, die Beschreibung, das Format und den Termin vor der Veröffentlichung ändern.';
  $('jobEditor').showModal();
}
async function saveJobEdit(){
  try{
    const id=$('editJobId').value;
    const job=jobs.find(j=>j.id===id);
    const payload={media_id:$('editMedia').value,caption:$('editCaption').value,
      due_at:job.series_id?job.due_at:$('editDue').value,format:$('editFormat').value};
    const out=await json('/api/jobs/'+id,payload,'PATCH');
    $('jobEditor').close();await refresh();toast(out.message);
  }catch(e){toast(e.message,true)}
}
// Filterable archive with explicit blocking status for multi-part stories.
renderJobs=function(){
  const platform=$('jobFilterPlatform').value,state=$('jobFilterState').value,query=$('jobSearch').value.toLowerCase().trim();
  const filtered=jobs.filter(j=>(!platform||j.platform===platform)&&(!state||(state==='published'?['published','published_manual'].includes(j.status):j.status===state))
    &&(!query||[j.original_name,j.caption,j.result,j.platform,new Date(j.due_at).toLocaleDateString('de-DE')].join(' ').toLowerCase().includes(query)));
  $('jobRows').innerHTML=filtered.map(j=>{
    const st=stateLabels[j.status]||[j.status,'gray'];let buttons='';
    if(j.status==='scheduled')buttons=`<button class="outline tiny" onclick="editJob('${j.id}')">✏️ Bearbeiten</button> <button class="outline tiny" onclick="jobAction('${j.id}','cancel')">Stornieren</button>`;
    if(j.status==='manual')buttons=`<button class="outline tiny" onclick="downloadMedia('${j.media_id}')">Bild ↓</button> <button class="outline tiny" onclick="jobAction('${j.id}','mark-published')">Erledigt ✓</button>`;
    if(j.status==='needs_review')buttons=`<button class="danger tiny" onclick="jobAction('${j.id}','retry')">Nach Prüfung erneut</button>`;
    const waiting=j.waiting_for?`<br><span class="pill amber">⏳ Wartet auf Karte ${j.waiting_for}</span>`:'';
    return `<tr><td class="nowrap">${new Date(j.due_at).toLocaleString('de-DE')}</td><td>${esc(j.original_name)}${j.series_id?`<br><small>🔮 Karte ${j.position} / 4</small>`:''}</td><td>${icon[j.platform]||''} ${esc(providers[j.platform]?.name||j.platform)}<br><small>${esc(fmtNames[j.format]||j.format)}</small></td><td><span class="pill ${st[1]}">${esc(st[0])}</span>${waiting}</td><td>${esc(j.result||'')}<br><small>${esc(j.caption||'')}</small></td><td><div class="row">${buttons}</div></td></tr>`;
  }).join('')||'<tr><td colspan="6">Keine passenden Veröffentlichungen.</td></tr>';
};
$('calStart').value=$('fourDate').value;
paintStudio();
