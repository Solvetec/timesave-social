/* TimeSave Social 9 Creative Studio: progressive enhancement. Keeps V8 APIs + secrets intact. */
'use strict';
let v9VideoPreviewURL='',v9VideoBusy=false;
const v9OldNav=nav;
nav=function(id){
  v9OldNav(id);
  const titles={studio:'Bildstudio · Design & Vorlagen',videoStudio:'Videostudio · Clips gestalten',composer:'Veröffentlichung erstellen',library:'Deine Mediathek',accounts:'Plattformen & Konten',queue:'Planung & Archiv',tarot:'Tarot-Serienplanung'};
  if(titles[id])$('pageTitle').textContent=titles[id];
  if(id==='videoStudio'){
    v9FillVideoSelect();
    if(!$('v9VideoSource').value){const choice=$('composerMedia').value||chosen;if(choice && media.some(x=>x.id===choice))$('v9VideoSource').value=choice;}
    v9ChooseVideoSource();
  }
};
// Reuse the publishing form with a real preview for MP4 files.
let v9ComposerVideoURL='';
const v9OldComposerPreview=showComposerPreview;
showComposerPreview=function(){
  const vid=$('composerVideoPreview'),item=media.find(m=>m.id===$('composerMedia').value);
  vid.hidden=true;vid.pause();vid.removeAttribute('src');vid.load();
  if(v9ComposerVideoURL){URL.revokeObjectURL(v9ComposerVideoURL);v9ComposerVideoURL='';}
  if(item?.mime==='video/mp4'){
    $('composerPreview').hidden=true;
    const expected=item.id;
    fetch('/api/media/'+expected,{headers:{'X-Admin-Token':auth}}).then(r=>r.ok?r.blob():Promise.reject(Error('Video nicht erreichbar')))
      .then(b=>{if($('composerMedia').value!==expected)return;v9ComposerVideoURL=URL.createObjectURL(b);vid.src=v9ComposerVideoURL;vid.hidden=false;})
      .catch(()=>{});
  }else{v9OldComposerPreview();}
};
const v9OldMediaChoices=renderMediaChoices;
renderMediaChoices=function(){v9OldMediaChoices();v9FillVideoSelect();};
function v9FillVideoSelect(){
 const sel=$('v9VideoSource');if(!sel)return;
 const old=sel.value;
 sel.innerHTML='<option value="">– Bild oder MP4 wählen –</option>'+media.filter(m=>m.mime.startsWith('image/')||m.mime==='video/mp4')
  .map(m=>`<option value="${esc(m.id)}">${m.mime==='video/mp4'?'🎞':'🖼'} ${esc(m.original_name)}</option>`).join('');
 if(media.some(m=>m.id===old))sel.value=old;
}
function openVideoStudio(id){
 nav('videoStudio');
 if(id && media.some(m=>m.id===id)){$('v9VideoSource').value=id;v9ChooseVideoSource();}
}
async function v9ChooseVideoSource(){
 const id=$('v9VideoSource').value,im=$('v9PreviewImage'),vid=$('v9PreviewVideo'),emp=$('v9PreviewEmpty');
 im.hidden=true;vid.hidden=true;vid.pause();vid.removeAttribute('src');vid.load();
 if(v9VideoPreviewURL){URL.revokeObjectURL(v9VideoPreviewURL);v9VideoPreviewURL='';}
 if(!id){emp.hidden=false;v9PreviewVideoUpdate();return;}
 const item=media.find(x=>x.id===id);if(!item){emp.hidden=false;return;}
 try{
   const r=await fetch('/api/media/'+id,{headers:{'X-Admin-Token':auth}});
   if(!r.ok)throw Error('Medium nicht erreichbar');
   const url=URL.createObjectURL(await r.blob());
   if($('v9VideoSource').value!==id){URL.revokeObjectURL(url);return;}
   v9VideoPreviewURL=url;emp.hidden=true;
   if(item.mime==='video/mp4'){vid.src=url;vid.hidden=false;}else{im.src=url;im.hidden=false;}
   $('v9VideoTrim').disabled=item.mime!=='video/mp4';
   $('v9VideoMotion').disabled=item.mime==='video/mp4';
   v9PreviewVideoUpdate();
 }catch(e){emp.hidden=false;toast(e.message,true)}
}
function v9PreviewVideoUpdate(){
  const frame=$('v9PreviewFrame');
  frame.classList.toggle('square',$('v9VideoFormat').value==='square');
  frame.dataset.position=$('v9VideoPosition').value;
  const title=$('v9VideoTitle').value.trim(),subtitle=$('v9VideoSubtitle').value.trim(),badge=$('v9VideoBadge').value.trim();
  $('v9PreviewTitle').textContent=title;
  $('v9PreviewSubtitle').textContent=subtitle;
  $('v9PreviewTitle').style.color=$('v9VideoColor').value;
  $('v9PreviewOverlay').hidden=!(title||subtitle);
  $('v9PreviewBadge').textContent=badge;$('v9PreviewBadge').hidden=!badge;
  const filters={normal:'none',warm:'sepia(.18) saturate(1.2) brightness(1.07)',cool:'hue-rotate(8deg) saturate(1.15)',vivid:'saturate(1.4) contrast(1.08)',mono:'grayscale(1)'};
  $('v9PreviewImage').style.filter=filters[$('v9VideoFilter').value];
  $('v9PreviewVideo').style.filter=filters[$('v9VideoFilter').value];
}
function applyStudioTemplate(template){
  const templates={
    royal:{look:'cool',tint:'violet',font:'Georgia',color:'#fff4df',box:'glass',decor:'stars',size:'72',x:'50',y:'39'},
    sunset:{look:'warm',tint:'gold',font:'Georgia',color:'#fff2c4',box:'glass',decor:'line',size:'67',x:'50',y:'42'},
    minimal:{look:'original',tint:'none',font:'Arial',color:'#ffffff',box:'glass',decor:'none',size:'67',x:'50',y:'42'},
    oracle:{look:'vivid',tint:'rose',font:'Georgia',color:'#fff2ea',box:'glass',decor:'stars',size:'75',x:'50',y:'40'}
  };
  const t=templates[template];if(!t)return;
  for(const [field,value] of Object.entries(t)){
    const ids={look:'studioLook',tint:'studioTint',font:'studioFont',color:'studioColor',box:'studioBox',decor:'studioDecor',size:'studioFontSize',x:'studioX',y:'studioY'};
    $(ids[field]).value=value;
  }
  document.querySelectorAll('.design-template').forEach(b=>b.classList.remove('is-selected'));
  const index=['royal','sunset','minimal','oracle'].indexOf(template);
  const el=document.querySelectorAll('.design-template')[index];if(el)el.classList.add('is-selected');
  paintStudio();
}
function resetStudioDecor(){
  $('studioText').value='';$('studioSubtitle').value='';$('studioLook').value='original';
  $('studioTint').value='none';$('studioDecor').value='none';$('studioSignature').value='Solvetec';
  $('studioFontSize').value='64';$('studioX').value='50';$('studioY').value='49';
  $('studioColor').value='#ffffff';$('studioBox').value='glass';
  document.querySelectorAll('.design-template').forEach(b=>b.classList.remove('is-selected'));
  paintStudio();
}
async function v9RenderVideo(continuePlanning){
  if(v9VideoBusy)return;
  const mid=$('v9VideoSource').value;
  if(!mid){toast('Bitte zuerst ein Bild oder Video auswählen.',true);return;}
  const seconds=Number($('v9VideoDuration').value),start=Number($('v9VideoTrim').value);
  if(!Number.isInteger(seconds)||seconds<3||seconds>30){toast('Die Videodauer muss zwischen 3 und 30 Sekunden liegen.',true);return;}
  if(!Number.isFinite(start)||start<0||start>600){toast('Startzeit muss zwischen 0 und 600 Sekunden liegen.',true);return;}
  const payload={media_id:mid,seconds,start_seconds:start,format:$('v9VideoFormat').value,
    motion:$('v9VideoMotion').value,filter:$('v9VideoFilter').value,
    title:$('v9VideoTitle').value,subtitle:$('v9VideoSubtitle').value,
    badge:$('v9VideoBadge').value,title_color:$('v9VideoColor').value,
    position:$('v9VideoPosition').value,fade:$('v9VideoFade').checked};
  try{
    v9VideoBusy=true;
    $('v9RenderOnly').disabled=true;$('v9RenderPlan').disabled=true;
    $('v9VideoProgress').textContent='⏳ Dein MP4 wird gestaltet. Bitte die Seite geöffnet lassen …';
    const r=await api('/api/media/render-video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    await refresh();
    $('v9VideoProgress').textContent='✓ '+r.message;
    chosen=r.id;$('composerMedia').value=r.id;
    if(continuePlanning){
      $('postCaption').value=[$('v9VideoTitle').value,$('v9VideoSubtitle').value].filter(Boolean).join('\n');
      nav('composer');showComposerPreview();
      toast('Dein Video wurde gerendert. Wähle jetzt TikTok / Reels / andere unterstützte Ziele und einen Termin.');
    }else{nav('library');toast('Neues MP4 im Fundus gespeichert. Original unverändert.');}
  }catch(e){$('v9VideoProgress').textContent='⚠ '+e.message;toast(e.message,true)}
  finally{v9VideoBusy=false;$('v9RenderOnly').disabled=false;$('v9RenderPlan').disabled=false;}
}
// A progressive dashboard helper, no remote analytics and no new permissions.
function v9QuickCreate(kind){nav(kind==='video'?'videoStudio':kind==='image'?'studio':'composer')}
v9PreviewVideoUpdate();
