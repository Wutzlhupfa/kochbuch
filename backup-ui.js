/* Storage adapter and UI; no schema changes or server needed on GitHub Pages. */
let backupPreview = null;
let backupSafetyResolver = null;
const backupStatus = message => { document.querySelector('#backupStatus').textContent = message; };
const backupClone = value => JSON.parse(JSON.stringify(value));

function createBackupAdapter() {
  const cloud = supabaseClient;
  const local = !cloud && storageMode === 'file';
  const writeUser = currentUser;
  return {
    async snapshot() {
      if (cloud) {
        const rows=await fetchCloudRecipeRows(cloud,'id, data, updated_at, updated_by',KochbuchBackup.LIMITS.recipes);
        if(rows.some(row=>row.id!==row.data?.id || typeof row.updated_at!=='string')) throw new Error('Cloud-Datensätze enthalten ungültige IDs/Versionen.');
        KochbuchBackup.validateRecipes(rows.map(row=>row.data));
        return {items:rows.map(row=>row.data), versions:Object.fromEntries(rows.map(row=>[row.id,row.updated_at])),rows};
      }
      if(!local) throw new Error('Kein aktueller Speicher erreichbar. Keine Sicherung aus möglicherweise veralteten Browserdaten erstellt.');
      const response=await fetch('/api/recipes',{cache:'no-store',signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new Error('Lokale Rezeptdatei konnte nicht gelesen werden.');
      const items=await response.json();
      KochbuchBackup.validateRecipes(items);
      const etag=response.headers.get('ETag');
      if(!etag) throw new Error('Bitte den aktualisierten server.py neu starten; die sichere Dateiversionsprüfung fehlt.');
      return {items,versions:{file:etag}};
    },
    async upload(bytes,info) {
      if(cloud) {
        if(!writeUser || currentUser?.id!==writeUser.id) throw new Error('Anmeldung für Bildimport erforderlich.');
        await requireAuthenticatedCloudUser();
        const path=`${writeUser.id}/restore-${crypto.randomUUID()}.${info.ext}`;
        const {error}=await cloud.storage.from('recipe-images').upload(path,new Blob([bytes],{type:info.mime}),{contentType:info.mime,upsert:false});
        if(error) throw new Error(`Bild-Upload fehlgeschlagen: ${error.message}`);
        return cloud.storage.from('recipe-images').getPublicUrl(path).data.publicUrl;
      }
      if(!local) throw new Error('Kein beschreibbarer Bildspeicher.');
      const response=await fetch('/api/image',{method:'POST',headers:{'Content-Type':info.mime},body:bytes,signal:AbortSignal.timeout(30000)});
      const data=await response.json();
      if(!response.ok || !data.path) throw new Error(data.error || 'Bild-Upload fehlgeschlagen.');
      return data.path;
    },
    async commit(before,target) {
      if(cloud) return commitBackupToCloud(cloud,writeUser,before,target);
      if(!local) throw new Error('Kein beschreibbarer Rezeptspeicher.');
      const response=await fetch('/api/recipes',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':before.versions.file},body:JSON.stringify(target),signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new Error(response.status===409?'Datei wurde zwischenzeitlich geändert. Import abgebrochen, keine Rezeptdaten überschrieben.':'Lokaler Import fehlgeschlagen. Die Rezeptdatei wird atomar ersetzt; bitte neu laden und Sicherheitskopie aufbewahren.');
      const after=await this.snapshot();
      if(!KochbuchBackup.same([...after.items].sort((a,b)=>a.id.localeCompare(b.id)),[...target].sort((a,b)=>a.id.localeCompare(b.id)))) throw new Error('Lokale Abschlussprüfung fehlgeschlagen. Daten können bereits gespeichert sein; Sicherheitskopie aufbewahren.');
    }
  };
}

async function commitBackupToCloud(cloud,user,before,target) {
  if(!user || currentUser?.id!==user.id) throw new Error('Anmeldung ist nicht mehr gültig.');
  await requireAuthenticatedCloudUser();
  const oldRows=new Map(before.rows.map(row=>[row.id,row]));
  const targetIds=new Set(target.map(item=>item.id));
  const journal=[];
  let pending=null;
  async function perform(kind,old,data) {
    const row=kind==='delete'?null:{id:data.id,data,updated_at:new Date().toISOString(),updated_by:user.id};
    const id=old?.id || data.id;
    pending={kind,old,row,id};
    let query=kind==='insert'?cloud.from('recipes').insert(row):kind==='update'?cloud.from('recipes').update(row).eq('id',id).eq('updated_at',old.updated_at):cloud.from('recipes').delete().eq('id',id).eq('updated_at',old.updated_at);
    const result=await query.select('id, data, updated_at, updated_by');
    if(result.error || result.data?.length!==1) throw new Error(result.error?.message || `Versionskonflikt bei Rezept ${id}`);
    journal.push({...pending,saved:result.data[0]}); pending=null;
  }
  try {
    for(const recipe of target) {
      const old=oldRows.get(recipe.id);
      if(!old) await perform('insert',null,recipe);
      else if(!KochbuchBackup.same(old.data,recipe)) await perform('update',old,recipe);
    }
    // Existing rows are deleted last, after all uploads and writes succeeded.
    for(const old of before.rows) if(!targetIds.has(old.id)) await perform('delete',old,null);
    const after=await createBackupAdapter().snapshot();
    const sorted=items=>[...items].sort((a,b)=>a.id.localeCompare(b.id));
    if(!KochbuchBackup.same(sorted(after.items),sorted(target))) throw new Error('Cloud-Abschlussprüfung weicht vom geplanten Bestand ab.');
  } catch(error) {
    const rollbackErrors=[];
    // An HTTP request may have committed despite a lost response. Reconcile it
    // before attempting compensation; never blindly overwrite a newer version.
    if(pending) {
      try {
        const {data,error:readError}=await cloud.from('recipes').select('id, data, updated_at, updated_by').eq('id',pending.id);
        if(readError) throw readError;
        const found=data?.[0];
        if(pending.kind==='delete' && !found) journal.push({...pending,saved:null});
        else if(found && pending.row && found.updated_at===pending.row.updated_at && KochbuchBackup.same(found.data,pending.row.data)) journal.push({...pending,saved:found});
        else if((pending.kind==='insert' && !found) || (pending.old && found && found.updated_at===pending.old.updated_at)) { /* not changed */ }
        else throw new Error(`Unklarer Schreibausgang bei ${pending.id}.`);
      } catch(reconcileError) { rollbackErrors.push(reconcileError.message); }
    }
    for(const entry of [...journal].reverse()) {
      try {
        let query;
        if(entry.kind==='delete') query=cloud.from('recipes').insert(entry.old);
        else if(entry.kind==='insert') query=cloud.from('recipes').delete().eq('id',entry.id).eq('updated_at',entry.saved.updated_at);
        else query=cloud.from('recipes').update(entry.old).eq('id',entry.id).eq('updated_at',entry.saved.updated_at);
        const result=await query.select('id');
        if(result.error || result.data?.length!==1) throw new Error(result.error?.message || 'Rezept inzwischen geändert');
      } catch(rollbackError) { rollbackErrors.push(`${entry.id}: ${rollbackError.message}`); }
    }
    try {
      const restored=await createBackupAdapter().snapshot();
      if(!KochbuchBackup.snapshotEqual(before,restored)) rollbackErrors.push('Ausgangszustand konnte nicht vollständig bestätigt werden.');
    } catch { rollbackErrors.push('Kontrolle der Rücknahme nicht erreichbar.'); }
    throw new Error(`Import fehlgeschlagen: ${error.message}\n${rollbackErrors.length ? 'ACHTUNG: Rücknahme unvollständig/unklar. Sammlung neu laden, Sicherheitskopie aufbewahren und keine weiteren Änderungen vornehmen. Details: '+rollbackErrors.join('; ') : 'Alle Rezeptänderungen dieses Imports wurden zurückgenommen und der Ausgangszustand geprüft.'}`);
  }
}

function downloadBackupBlob(blob,name) {
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url; link.download=name; document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function backupFilename(prefix='kochbuch-backup') { return `${prefix}-${new Date().toISOString().slice(0,10)}.zip`; }
async function withBackupLock(action) {
  if(backupBusy || cloudWriteInProgress || editorSaveInProgress) throw new Error('Ein Speichervorgang läuft bereits. Bitte kurz warten.');
  backupBusy=true;
  cloudRefreshEpoch+=1;
  const previouslyDisabled=new Map();
  document.querySelectorAll('button,input,select,textarea').forEach(element=>{
    if(element.closest('#restoreModal')) return;
    previouslyDisabled.set(element,element.disabled); element.disabled=true;
  });
  const beforeUnload=event=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',beforeUnload);
  try { return await action(); }
  finally {
    backupBusy=false;
    previouslyDisabled.forEach((disabled,element)=>{element.disabled=disabled;});
    window.removeEventListener('beforeunload',beforeUnload);
  }
}
async function createFullBackup() {
  try {
    await withBackupLock(async()=>{
      backupStatus('Lade den aktuellen Datenbestand …');
      const snapshot=await createBackupAdapter().snapshot();
      const result=await KochbuchBackup.create(snapshot.items,backupStatus);
      const latest=await createBackupAdapter().snapshot();
      if(!KochbuchBackup.snapshotEqual(snapshot,latest)) throw new Error('Die Sammlung hat sich während der Sicherung geändert. Bitte erneut sichern.');
      downloadBackupBlob(result.blob,backupFilename());
      backupStatus(`Vollständige Sicherung erstellt: ${result.manifest.recipeCount} Rezepte, ${result.manifest.imageCount} Bilddateien. Download im Browser prüfen.`);
    });
  } catch(error) { backupStatus(`Sicherung fehlgeschlagen: ${error.message}`); }
}
function updateRestorePreview() {
  if(!backupPreview) return;
  const mode=document.querySelector('#restoreMode').value;
  const plan=KochbuchBackup.plan(backupPreview.bundle,backupPreview.snapshot,mode);
  const imageCount=backupPreview.bundle.legacy?0:backupPreview.bundle.manifest.imageCount;
  document.querySelector('#restorePreviewText').textContent=`${plan.total} Rezepte gefunden · ${imageCount} eingebettete Bilddateien · ${plan.existing} IDs bereits vorhanden · ${plan.newCount} neue Rezepte. ${mode==='merge'?`Zusammenführen: ${plan.importCount} importieren, ${plan.skipCount} unverändert überspringen.`:`Ersetzen: ${backupPreview.snapshot.items.length} vorhandene Rezepte werden durch ${plan.total} Rezepte ersetzt.`}`;
  document.querySelector('#replaceWarning').hidden=mode!=='replace';
  document.querySelector('#replaceConfirm').checked=false;
  document.querySelector('#restoreConfirm').disabled=false;
}
async function inspectBackupFile(file) {
  backupPreview=null;
  if(!file) return;
  try {
    await withBackupLock(async()=>{
      backupStatus('Prüfe Backup und sämtliche enthaltenen Bilder …');
      const bundle=await KochbuchBackup.inspect(file);
      const snapshot=await createBackupAdapter().snapshot();
      backupPreview={bundle,snapshot};
      document.querySelector('#restoreMode').value='merge';
      document.querySelector('#restoreWarnings').textContent=bundle.warnings.join('\n');
      document.querySelector('#restoreSafety').hidden=true;
      document.querySelector('#restoreResult').textContent='';
      updateRestorePreview();
      document.querySelector('#restoreModal').showModal();
      backupStatus('Backup vollständig geprüft. Wiederherstellung wartet auf deine Bestätigung.');
    });
  } catch(error) { backupStatus(`Datei nicht importiert: ${error.message}`); }
}
function requestSafetyDownload(result) {
  document.querySelector('#restoreSafety').hidden=false;
  document.querySelector('#safetyReceived').checked=false;
  document.querySelector('#safetyContinue').disabled=true;
  document.querySelector('#safetyCancel').disabled=false;
  document.querySelector('#safetyDownload').onclick=()=>{
    downloadBackupBlob(result.blob,backupFilename('kochbuch-sicherheitskopie'));
    document.querySelector('#safetyReceived').disabled=false;
  };
  document.querySelector('#safetyReceived').disabled=true;
  return new Promise(resolve=>{backupSafetyResolver=resolve;});
}
async function runRestore() {
  if(!backupPreview || backupBusy || !ensureCanEdit()) return;
  const mode=document.querySelector('#restoreMode').value;
  if(mode==='replace' && !document.querySelector('#replaceConfirm').checked) {
    document.querySelector('#restoreResult').textContent='Bitte das Ersetzen der gesamten Sammlung ausdrücklich bestätigen.'; return;
  }
  document.querySelector('#restoreConfirm').disabled=true;
  document.querySelector('#restoreMode').disabled=true;
  document.querySelector('#restoreClose').disabled=true;
  let attempted=false;
  try {
    await withBackupLock(async()=>{
      attempted=true;
      const {bundle,snapshot}=backupPreview;
      const result=await KochbuchBackup.restore(bundle,mode,createBackupAdapter(),{
        expected:snapshot,progress:message=>{document.querySelector('#restoreResult').textContent=message;},safety:requestSafetyDownload
      });
      // Re-read persisted data after verification; do not use stale in-memory data.
      const latest=await createBackupAdapter().snapshot();
      if (!supabaseClient) localRecipeEtag=latest.versions.file;
      recipes=latest.items; recipeVersions=new Map(Object.entries(latest.versions)); normalizeAllRecipes(); render();
      const message=`${result.legacy?'Legacy-Import abgeschlossen (JSON enthielt keine Bilder; erreichbare Bildlinks wurden geprüft und neu gespeichert).':'Wiederherstellung vollständig geprüft.'} ${result.importCount} Rezepte importiert, ${result.skipCount} übersprungen, ${result.imageCount} Bilddateien hochgeladen.`;
      document.querySelector('#restoreResult').textContent=message; backupStatus(message);
    });
  } catch(error) {
    document.querySelector('#restoreResult').textContent=error.message;
    backupStatus(`Wiederherstellung nicht erfolgreich bestätigt: ${error.message}`);
    // Failed/ambiguous imports require a new preview and a fresh snapshot.
  } finally {
    if(attempted) backupPreview=null;
    document.querySelector('#restoreSafety').hidden=true;
    document.querySelector('#restoreMode').disabled=false;
    document.querySelector('#restoreClose').disabled=false;
    document.querySelector('#restoreConfirm').disabled=true;
  }
}
document.querySelector('#exportBackupButton').addEventListener('click',createFullBackup);
document.querySelector('#restoreBackupButton').addEventListener('click',()=>{if(ensureCanEdit()) document.querySelector('#backupFileInput').click();});
document.querySelector('#backupFileInput').addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';inspectBackupFile(file);});
document.querySelector('#restoreMode').addEventListener('change',updateRestorePreview);
document.querySelector('#restoreConfirm').addEventListener('click',runRestore);
document.querySelector('#restoreClose').addEventListener('click',()=>{if(!backupBusy) document.querySelector('#restoreModal').close();});
document.querySelector('#restoreModal').addEventListener('cancel',event=>{if(backupBusy) event.preventDefault();});
document.querySelector('#safetyReceived').addEventListener('change',event=>{document.querySelector('#safetyContinue').disabled=!event.target.checked;});
document.querySelector('#safetyContinue').addEventListener('click',()=>{if(document.querySelector('#safetyReceived').checked && backupSafetyResolver){backupSafetyResolver(true);backupSafetyResolver=null;document.querySelector('#restoreSafety').hidden=true;}});
document.querySelector('#safetyCancel').addEventListener('click',()=>{if(backupSafetyResolver){backupSafetyResolver(false);backupSafetyResolver=null;}});
