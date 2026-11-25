/* TimeSave Social 11 – platform picker and automatic source-media distribution.
   Based on TimeSave Social 10 per-destination media + upload and planning receipt.
   Only changes the composer. Existing V9 media tools and legacy planner remain available. */
'use strict';
const v10State = Object.create(null);
const v10MediaFormats = {
  facebook: {image:[['story','Story · Foto'],['post','Beitrag · Foto']],video:[['story','Story · Video'],['post','Beitrag · Video'],['reel','Reel · Video']]},
  instagram:{image:[['story','Story · Foto'],['post','Feed · Foto']],video:[['story','Story · Video'],['reel','Reel · Video']]},
  threads:  {image:[['post','Threads · Bildbeitrag']],video:[['reel','Threads · 9:16 Video']]},
  linkedin: {image:[['post','LinkedIn · Bildbeitrag']],video:[['video','LinkedIn · 9:16 / Feed-Video']]},
  telegram: {image:[['post','Kanalbeitrag · Bild']],video:[['post','Kanalbeitrag · Video']]},
  telegram_story:{image:[['story','Profil-Story · Bild (automatisch)']],video:[['story','Profil-Story · Video (automatisch)']]},
  tiktok:   {image:[['post','Fotobeitrag · Bild']],video:[['video','TikTok-Video · MP4']]},
  youtube:  {image:[],video:[['video','YouTube-Video / Short']]},
  whatsapp: {image:[['story','Status · Bild (manuell)']],video:[['story','Status · Video (manuell)']]},
  whatsapp_channel:{image:[['post','Kanal · Bild (manuell)']],video:[['post','Kanal · Video (manuell)']]},
};
const v10DefaultKind={tiktok:'video',youtube:'video'};
// Independent defaults: selecting a new image must not destroy the chosen video and vice versa.
const v11SourceDefaults={image:'',video:''};
const v10Labels={facebook:'Facebook',instagram:'Instagram',threads:'Threads',linkedin:'LinkedIn',telegram:'Telegram-Kanal',telegram_story:'Telegram-Profil-Story',tiktok:'TikTok',youtube:'YouTube',whatsapp:'WhatsApp-Status',whatsapp_channel:'WhatsApp-Kanal'};
let v10PendingPlan=null, v10Busy=false;

const v10OriginalRenderTargetGroup=renderTargetGroup;
renderTargetGroup=function(container,prefix){
  if(container!=='composerTargets'){v10OriginalRenderTargetGroup(container,prefix);return;}
  // Keep the native format/account/checkbox controls and the old Tarot planner unchanged.
  v10OriginalRenderTargetGroup(container,prefix);
  $(container).querySelectorAll('.target').forEach(row=>{
    const provider=row.dataset.provider, checked=row.querySelector('.want'), formats=row.querySelector('.format');
    const acc=row.querySelector('.connection-select');
    const state=v10State[provider]||(v10State[provider]={kind:v10DefaultKind[provider]||'image',mediaId:'',format:''});
    const body=document.createElement('div');body.className='v10-target-body';
    const mediaLabel=document.createElement('div');mediaLabel.className='v10-small-label';mediaLabel.textContent='1 · Was soll erscheinen?';
    const toggle=document.createElement('div');toggle.className='v10-kind-switch';toggle.setAttribute('role','group');toggle.setAttribute('aria-label',v10Labels[provider]+' · Bild oder Video');
    for(const kind of ['image','video']){
      const b=document.createElement('button');b.type='button';b.className='v10-kind-button';b.dataset.kind=kind;b.textContent=kind==='image'?'🖼 Bild':'🎬 Video';
      if(provider==='youtube'&&kind==='image'){b.disabled=true;b.title='YouTube benötigt ein MP4-Video';}
      b.addEventListener('click',()=>{state.kind=kind;state.mediaId='';state.format='';if(provider==='tiktok')$('tiktokConsent').checked=false;v10RefreshTarget(row);});
      toggle.appendChild(b);
    }
    const fileLabel=document.createElement('label');fileLabel.className='v10-small-label';fileLabel.textContent='2 · Datei für diesen Kanal';
    const select=document.createElement('select');select.className='v10-media-select';select.setAttribute('aria-label',v10Labels[provider]+' Datei');
    select.addEventListener('change',()=>{state.mediaId=select.value;if(provider==='tiktok')$('tiktokConsent').checked=false;v10RefreshTargetMessage(row);});fileLabel.appendChild(select);
    body.append(mediaLabel,toggle,fileLabel);
    const badge=document.createElement('small');badge.className='v10-target-hint';badge.setAttribute('aria-live','polite');body.appendChild(badge);
    const grid=row.querySelector('.target-grid');row.insertBefore(body,grid);
    const existingHint=row.querySelector(':scope > small');if(existingHint)existingHint.classList.add('v10-original-provider-hint');
    formats.addEventListener('change',()=>{state.format=formats.value;if(provider==='tiktok')$('tiktokConsent').checked=false;v10RefreshTargetMessage(row);});
    checked.addEventListener('change',()=>{row.classList.toggle('v10-active',checked.checked);v10RefreshTargetMessage(row);});
    acc.addEventListener('change',()=>{if(provider==='tiktok'){$('tiktokConsent').checked=false;loadedTikTokAccount='';$('tiktokPrivacy').disabled=true;$('tiktokCreatorLabel').textContent='Bitte TikTok-Sichtbarkeit erneut abfragen.';}});
    v10RefreshTarget(row);
    checked.addEventListener('change',v11UpdatePlatformPicker);
  });
  v11RenderPlatformPicker();
};

// A compact selection grid is always visible; only enabled platforms show their full form.
function v11RenderPlatformPicker(){
  const root=$('v11PlatformPicker');
  if(!root)return;
  root.replaceChildren();
  const rows=Array.from($('composerTargets').querySelectorAll('.target'));
  for(const row of rows){
    const provider=row.dataset.provider;
    const connected=accounts.some(x=>x.provider===provider);
    const manual=['whatsapp','whatsapp_channel'].includes(provider);
    const button=document.createElement('button');button.type='button';
    button.className='v11-platform-button';button.dataset.provider=provider;
    button.setAttribute('aria-pressed','false');
    button.setAttribute('aria-label',v10Labels[provider]+' auswählen');
    const iconNode=document.createElement('span');iconNode.className='v11-platform-icon';iconNode.textContent=icon[provider]||'✦';
    const textNode=document.createElement('span');textNode.className='v11-platform-text';
    const nameNode=document.createElement('strong');nameNode.textContent=v10Labels[provider];
    const statusNode=document.createElement('small');
    statusNode.textContent=manual?'Manuelle Vorbereitung':connected?'Verbunden':'Nicht verbunden';
    statusNode.className='v11-platform-status '+(manual?'is-manual':connected?'is-connected':'is-disconnected');
    textNode.append(nameNode,statusNode);
    const checkNode=document.createElement('span');checkNode.className='v11-platform-check';checkNode.setAttribute('aria-hidden','true');checkNode.textContent='+';
    button.append(iconNode,textNode,checkNode);
    button.addEventListener('click',()=>{
      const input=row.querySelector('.want');
      input.checked=!input.checked;
      input.dispatchEvent(new Event('change',{bubbles:true}));
      if(provider==='tiktok'&&!input.checked)$('tiktokConsent').checked=false;
    });
    root.append(button);
  }
  v11UpdatePlatformPicker();
}
function v11UpdatePlatformPicker(){
  const rows=Array.from($('composerTargets').querySelectorAll('.target'));
  let selected=0;
  for(const row of rows){
    const enabled=row.querySelector('.want').checked;
    row.classList.toggle('v11-enabled',enabled);
    row.hidden=!enabled;
    if(enabled)selected++;
    const button=$('v11PlatformPicker')?.querySelector('[data-provider="'+row.dataset.provider+'"]');
    if(button){
      button.classList.toggle('is-selected',enabled);
      button.setAttribute('aria-pressed',String(enabled));
      button.setAttribute('aria-label',v10Labels[row.dataset.provider]+(enabled?' abwählen':' auswählen'));
      button.querySelector('.v11-platform-check').textContent=enabled?'✓':'+';
    }
  }
  $('v11SelectedCount').textContent=selected+' '+(selected===1?'Plattform':'Plattformen')+' ausgewählt';
  $('v11PickerEmpty').hidden=selected>0;
  $('v11SelectedHeading').hidden=selected===0;
  $('v11TikTokPanel').hidden=!rows.some(row=>row.dataset.provider==='tiktok'&&row.querySelector('.want').checked);
}
// An explicit new Ausgangsdatei assignment overrides matching per-platform media selections,
// but preserves all choices of the other media type (image vs video).
function v11SyncSourceMedia(){
  const chosenMedia=media.find(x=>x.id===$('composerMedia').value);
  if(!chosenMedia){$('v11SourceStatus').textContent='Wähle ein Bild oder Video, um es den passenden Plattformen automatisch zuzuordnen.';return;}
  const kind=chosenMedia.mime==='video/mp4'?'video':chosenMedia.mime?.startsWith('image/')?'image':null;
  if(!kind)return;
  v11SourceDefaults[kind]=chosenMedia.id;
  for(const provider of Object.keys(v10MediaFormats)){
    const state=v10State[provider];
    if(state?.kind===kind && v10MediaFormats[provider][kind].length){state.mediaId=chosenMedia.id;}
  }
  $('composerTargets').querySelectorAll('.target').forEach(v10RefreshTarget);
  v11ShowSourceStatus(kind,chosenMedia.original_name,false);
}
function v11ShowSourceStatus(kind,name,uploaded){
  const activeRows=Array.from($('composerTargets').querySelectorAll('.target')).filter(row=>{
    const state=v10State[row.dataset.provider];
    return row.querySelector('.want').checked&&state?.kind===kind&&!!v10MediaFormats[row.dataset.provider][kind].length;
  });
  const allMatching=Object.keys(v10MediaFormats).filter(provider=>v10State[provider]?.kind===kind&&v10MediaFormats[provider][kind].length).length;
  const label=kind==='image'?'🖼 Bild':'🎬 Video';
  $('v11SourceStatus').textContent='✓ '+label+' „'+name+'“ '+(uploaded?'hochgeladen und':'')+' automatisch zugeordnet: '+activeRows.length+' ausgewählte '+(activeRows.length===1?'Plattform':'Plattformen')+' · '+allMatching+' insgesamt. Auswahl pro Plattform bleibt änderbar.';
}

function v10RefreshTarget(row){
  const provider=row.dataset.provider,state=v10State[provider];
  const kind=state.kind, fileSelect=row.querySelector('.v10-media-select'), formatSelect=row.querySelector('.format');
  for(const button of row.querySelectorAll('.v10-kind-button')){
    const active=button.dataset.kind===kind;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',active?'true':'false');
  }
  const items=media.filter(x=>kind==='image'?x.mime.startsWith('image/'):x.mime==='video/mp4');
  const previous=state.mediaId;
  const preview=media.find(x=>x.id===$('composerMedia').value && (kind==='image'?x.mime.startsWith('image/'):x.mime==='video/mp4'));
  fileSelect.innerHTML='<option value="">'+(items.length?'– Datei bewusst auswählen –':'– Erst '+(kind==='image'?'Bild':'MP4')+' hochladen –')+'</option>'+
    items.map(x=>`<option value="${esc(x.id)}">${esc(x.original_name)}</option>`).join('');
  // Single matching file is safe to suggest; with several files require intentional selection.
  const preferred=v11SourceDefaults[kind];
  const selected=items.some(x=>x.id===previous)?previous:
    (items.some(x=>x.id===preferred)?preferred:(preview?.id || (items.length===1?items[0].id:'')));
  fileSelect.value=selected;state.mediaId=selected;
  const allowed=v10MediaFormats[provider][kind], current=state.format||formatSelect.value;
  formatSelect.innerHTML=allowed.map(([val,label])=>`<option value="${val}">${label}</option>`).join('');
  formatSelect.value=allowed.some(([val])=>val===current)?current:(allowed[0]?.[0]||'');
  state.format=formatSelect.value;formatSelect.disabled=!allowed.length;
  row.classList.toggle('v10-active',row.querySelector('.want').checked);
  v10RefreshTargetMessage(row);
}
function v10RefreshTargetMessage(row){
  const p=row.dataset.provider,st=v10State[p],file=media.find(x=>x.id===st.mediaId);
  const msg=row.querySelector('.v10-target-hint');
  if(!row.querySelector('.want').checked){msg.textContent='○ Dieser Kanal ist nicht ausgewählt.';msg.className='v10-target-hint';return;}
  if(!file){msg.textContent='⚠ Bitte eine passende Datei auswählen.';msg.className='v10-target-hint v10-warning';return;}
  const warnings={youtube:'YouTube lädt aktuell privat hoch.',tiktok:st.kind==='image'?'TikTok-Fotos brauchen verifizierte öffentliche Medien-URL.':'TikTok-Sichtbarkeit muss separat bestätigt werden.',whatsapp:'WhatsApp-Status ist ein manueller Auftrag.',whatsapp_channel:'WhatsApp-Kanal ist ein manueller Auftrag.',telegram_story:'Wird automatisch über dein verbundenes Telegram-Business-Profil veröffentlicht. Bilder werden auf 9:16 angepasst; Video benötigt FFmpeg.'};
  msg.textContent='✓ '+(st.kind==='image'?'Bild':'Video')+' gewählt · '+(warnings[p]||'Geplant zum gewählten Termin');msg.className='v10-target-hint';
}

async function v10UploadMedia(){
  const files=Array.from($('v10UploadFiles').files||[]);
  if(!files.length){toast('Bitte mindestens ein Bild oder MP4 auswählen.',true);return;}
  if(files.some(f=>!['image/jpeg','image/png','video/mp4'].includes(f.type))){toast('Erlaubt sind JPG, PNG und MP4.',true);return;}
  const button=$('v10UploadButton'),notice=$('v10UploadStatus');button.disabled=true;
  notice.className='v10-upload-status v10-upload-busy';notice.textContent='⏳ '+files.length+' Datei(en) werden in die Mediathek geladen …';
  const successes=[],errors=[];
  try{
    for(const f of files){
      try{const r=await v17TransmitMedia(f,(message)=>{notice.textContent='⏳ '+f.name+' · '+message;});successes.push({id:r.id,name:f.name,kind:f.type==='video/mp4'?'video':'image',cloud:r.cloud});if(r.optimized)notice.textContent='✓ '+f.name+' optimiert: '+v176FmtSize(r.original_bytes)+' → '+v176FmtSize(r.stored_bytes);
      }catch(e){errors.push(f.name+': '+e.message);}
    }
    if(successes.length){
      await refresh();
      for(const item of successes){
        v11SourceDefaults[item.kind]=item.id;
        for(const provider of Object.keys(v10MediaFormats)){
          const state=v10State[provider];if(state && state.kind===item.kind)state.mediaId=item.id;
        }
      }
      $('composerMedia').value=successes.at(-1).id;showComposerPreview();renderTargetGroup('composerTargets','post');
      v11ShowSourceStatus(successes.at(-1).kind,successes.at(-1).name,true);
      // On a multi-image upload, the last matching file is only a pre-selection and is visible in every card.
      notice.className='v10-upload-status v10-upload-ok';
      notice.textContent='✓ Upload bestätigt: '+successes.map(x=>x.name).join(' · ')+' · '+successes.length+' Datei(en) in der Mediathek gespeichert.'+(errors.length?' ⚠ Fehler: '+errors.join(' | '):'');
      toast(successes.length+' Datei(en) erfolgreich in TimeSave Social hochgeladen.');
    } else {notice.className='v10-upload-status v10-warning';notice.textContent='⚠ Upload fehlgeschlagen: '+errors.join(' | ');toast(errors.join(' | '),true);}
    $('v10UploadFiles').value='';
  } finally{button.disabled=false;}
}

function v10BuildPlan(){
  const rows=Array.from($('composerTargets').querySelectorAll('.target')).filter(x=>x.querySelector('.want').checked);
  if(!rows.length)throw Error('Bitte mindestens eine Plattform aktivieren.');
  const due=$('postDate').value;if(!due||!Number.isFinite(new Date(due).getTime())||new Date(due)<=new Date())throw Error('Bitte einen gültigen Termin in der Zukunft auswählen.');
  const targets=[];
  for(const row of rows){
    const provider=row.dataset.provider,st=v10State[provider],account=row.querySelector('.connection-select').value;
    const file=media.find(m=>m.id===st.mediaId);if(!file)throw Error(v10Labels[provider]+': Bitte eine Datei auswählen.');
    if(!v10MediaFormats[provider][st.kind].some(([v])=>v===st.format))throw Error(v10Labels[provider]+': Nicht unterstützte Kombination.');
    if(!['whatsapp','whatsapp_channel'].includes(provider)&&!account)throw Error(v10Labels[provider]+': Bitte ein verbundenes Konto auswählen.');
    targets.push({provider,format:st.format,media_id:file.id,connection_id:account||null});
  }
  const tt=targets.find(x=>x.provider==='tiktok');
  if(tt){
    if(tt.connection_id!==loadedTikTokAccount||$('tiktokPrivacy').disabled||!$('tiktokPrivacy').value)throw Error('TikTok: Bitte Konto & Sichtbarkeit erneut abfragen.');
    if(!$('tiktokConsent').checked)throw Error('TikTok: Bitte die gesonderte Veröffentlichungserlaubnis bestätigen.');
  }
  return {media_id:targets[0].media_id, caption:$('postCaption').value,due_at:due,targets,
    tiktok_privacy:tt?$('tiktokPrivacy').value:'SELF_ONLY',tiktok_consent:!!tt,tiktok_aigc:!!tt&&$('tiktokAigc').checked};
}
function v10OpenReview(){
  try{
    const plan=v10BuildPlan();v10PendingPlan=plan;
    const list=$('v10ReviewList');list.replaceChildren();
    for(const target of plan.targets){
      const f=media.find(x=>x.id===target.media_id);
      const row=document.createElement('div');row.className='v10-review-item';
      const left=document.createElement('div'),right=document.createElement('div');
      const headline=document.createElement('strong');headline.textContent=icon[target.provider]+' '+v10Labels[target.provider];
      const detail=document.createElement('span');detail.textContent=f.original_name+' · '+(f.mime==='video/mp4'?'MP4-Video':'Bild');
      left.append(headline,detail);
      const fmt=document.createElement('b');fmt.textContent=fmtNames[target.format]||target.format;right.append(fmt);
      if(['whatsapp','whatsapp_channel'].includes(target.provider)){const m=document.createElement('small');m.textContent='manuell';right.append(m);}
      row.append(left,right);list.append(row);
    }
    $('v10ReviewWhen').textContent='🗓 '+new Date(plan.due_at).toLocaleString('de-DE',{dateStyle:'full',timeStyle:'short'});
    $('v10ReviewConsent').checked=false;$('v10FinalPlan').disabled=true;
    $('v10ReviewDialog').showModal();
  }catch(e){toast(e.message,true);}
}
function v10CloseReview(){if($('v10ReviewDialog').open)$('v10ReviewDialog').close();v10PendingPlan=null;}
async function v10ConfirmPlan(){
  if(v10Busy)return;
  if(!$('v10ReviewConsent').checked||!v10PendingPlan){toast('Bitte zuerst alle Dateien und Ziele bestätigen.',true);return;}
  v10Busy=true;$('v10FinalPlan').disabled=true;
  try{
    // Revalidate with latest selections before writing; prevents stale confirmation.
    const current=v10BuildPlan();
    if(JSON.stringify(current)!==JSON.stringify(v10PendingPlan))throw Error('Deine Auswahl wurde verändert. Bitte Bestätigung erneut öffnen.');
    const r=await json('/api/plan',current);
    $('tiktokConsent').checked=false;
    v10CloseReview();await refresh();
    $('v10PlanReceipt').textContent='✓ '+r.count+' Veröffentlichungsaufträge gespeichert – Upload erfolgt erst zum geplanten Termin.';
    toast('✓ '+r.count+' Veröffentlichungen eingeplant. Bild/Video pro Plattform separat gespeichert.');
    nav('queue');
  }catch(e){toast(e.message,true);}finally{v10Busy=false;$('v10FinalPlan').disabled=false;}
}

const v10OldTikTokVideo=makeTikTokVideo;
makeTikTokVideo=async function(){
  await v10OldTikTokVideo();
  const id=$('composerMedia').value,item=media.find(x=>x.id===id);
  if(item?.mime==='video/mp4'){
    v10State.tiktok={...(v10State.tiktok||{}),kind:'video',mediaId:id,format:'video'};
    v10State.youtube={...(v10State.youtube||{}),kind:'video',mediaId:id,format:'video'};
    renderTargetGroup('composerTargets','post');showComposerPreview();
  }
};
