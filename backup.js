/* Complete, portable backups. ZIP codec: locally vendored fflate 0.8.2 (MIT). */
const KochbuchBackup = (() => {
  'use strict';
  const LIMITS = Object.freeze({ archive: 210 * 1024 * 1024, total: 200 * 1024 * 1024,
    image: 8 * 1024 * 1024, json: 5 * 1024 * 1024, manifest: 1024 * 1024,
    recipes: 2000, files: 2003, pixels: 40000000, ratio: 200 });
  const FORMAT = 'kochbuch-complete-backup';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw new Error(message); };
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  const stable = value => JSON.stringify(value, (_key, item) => plain(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const same = (a, b) => stable(a) === stable(b);
  const snapshotEqual = (a, b) => same([...a.items].sort((x,y) => x.id.localeCompare(y.id)), [...b.items].sort((x,y) => x.id.localeCompare(y.id))) && same(a.versions || {}, b.versions || {});
  const safePath = name => name === 'images/' || /^(manifest\.json|recipes\.json|images\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}\.(png|jpg|jpeg|webp|gif))$/.test(name) && !name.includes('..');
  const timeout = () => AbortSignal.timeout(30000);
  function safeUrl(value) {
    const url = new URL(value, location.href);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('Ungültige Bildadresse.');
    return url.href;
  }
  function checkStructure(value, depth = 0) {
    if (depth > 40) fail('Die JSON-Struktur ist zu tief verschachtelt.');
    if (Array.isArray(value)) { value.forEach(item => checkStructure(item, depth + 1)); return; }
    if (!plain(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) fail('Unsicherer JSON-Schlüssel.');
      if (/^(password|passwort|access[_-]?token|refresh[_-]?token|session|authorization|api[_-]?key|service[_-]?role[_-]?key|secret)$/i.test(key)) fail('Die Rezeptdaten enthalten ein möglicherweise geheimes Feld. Es wird keine Sicherung erstellt/importiert.');
      checkStructure(item, depth + 1);
    }
  }
  function validateRecipes(items, legacy = false) {
    if (!Array.isArray(items) || items.length > LIMITS.recipes) fail('Ungültige Rezeptliste (maximal 2.000 Rezepte).');
    checkStructure(items);
    const ids = new Set();
    const result = clone(items);
    for (const recipe of result) {
      if (!plain(recipe) || typeof recipe.id !== 'string' || !recipe.id.trim() || recipe.id.length > 200) fail('Ein Rezept hat keine gültige ID.');
      if (ids.has(recipe.id)) fail(`Doppelte Rezept-ID: ${recipe.id}`);
      ids.add(recipe.id);
      if (typeof recipe.title !== 'string' || !recipe.title.trim() || recipe.title.length > 1000) fail(`Ungültiger Rezeptname: ${recipe.id}`);
      const label = `Rezept „${recipe.title}“`;
      if (!['Vorspeise','Hauptspeise','Nachspeise'].includes(recipe.category)) fail(`${label}: ungültige Kategorie.`);
      if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.every(item => typeof item === 'string' || (plain(item) && typeof item.name === 'string' && (item.amount == null || item.amount === '' || (typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount >= 0)) && (item.unit == null || typeof item.unit === 'string')))) fail(`${label}: ungültige Zutaten.`);
      if (legacy) {
        if (recipe.image === undefined) recipe.image = '';
        if (recipe.links === undefined) recipe.links = [];
        if (recipe.instructions === undefined) recipe.instructions = '';
      }
      if (typeof recipe.image !== 'string' || typeof recipe.instructions !== 'string' || !Array.isArray(recipe.links) || !recipe.links.every(link => typeof link === 'string')) fail(`${label}: Bild, Links oder Anleitung ungültig.`);
      if (recipe.components !== undefined && (!Array.isArray(recipe.components) || !recipe.components.every(part => plain(part) && typeof part.id === 'string' && typeof part.name === 'string' && typeof part.instructions === 'string'))) fail(`${label}: ungültige Rezeptteile.`);
      if (recipe.tags !== undefined && (!Array.isArray(recipe.tags) || !recipe.tags.every(tag => typeof tag === 'string'))) fail(`${label}: ungültige Tags.`);
      if (recipe.favorite !== undefined && typeof recipe.favorite !== 'boolean') fail(`${label}: ungültiger Favoritenstatus.`);
      if (recipe.difficulty != null && !['','Einfach','Mittel','Anspruchsvoll'].includes(recipe.difficulty)) fail(`${label}: ungültige Schwierigkeit.`);
      for (const key of ['servings','prepMinutes','cookMinutes','restMinutes','finishedWeightGrams']) {
        const value = recipe[key];
        if (value !== undefined && value !== null && value !== '' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail(`${label}: ungültiger Zahlenwert (${key}).`);
      }
      if (recipe.nutrition != null && (!plain(recipe.nutrition) || Object.values(recipe.nutrition).some(value => value !== null && value !== '' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)))) fail(`${label}: ungültige Nährwerte.`);
      if (recipe.nutritionBasis != null && (!plain(recipe.nutritionBasis) || !['grams','servings'].includes(recipe.nutritionBasis.unit) || typeof recipe.nutritionBasis.amount !== 'number' || !(recipe.nutritionBasis.amount > 0))) fail(`${label}: ungültige Nährwert-Bezugsmenge.`);
    }
    if (encoder.encode(JSON.stringify(result)).length > LIMITS.json) fail('Rezeptdaten sind größer als 5 MiB.');
    return result;
  }
  async function readResponse(response, limit) {
    if (!response.ok) fail(`Abruf fehlgeschlagen (HTTP ${response.status}).`);
    if (Number(response.headers.get('Content-Length')) > limit) fail('Datei überschreitet die erlaubte Größe.');
    if (!response.body) fail('Leere Antwort.');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) fail('Datei überschreitet die erlaubte Größe.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async function getImage(url) {
    return readResponse(await fetch(safeUrl(url), { cache:'no-store', credentials:'omit', signal:timeout() }), LIMITS.image);
  }
  async function imageInfo(bytes) {
    if (!bytes.length || bytes.length > LIMITS.image) fail('Bild ist leer oder größer als 8 MiB.');
    let mime, ext;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { mime='image/jpeg'; ext='jpg'; }
    else if ([137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)) { mime='image/png'; ext='png'; }
    else if (/^GIF8[79]a/.test(String.fromCharCode(...bytes.subarray(0,6)))) { mime='image/gif'; ext='gif'; }
    else if (String.fromCharCode(...bytes.subarray(0,4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8,12)) === 'WEBP') { mime='image/webp'; ext='webp'; }
    else fail('Ungültiges Bildformat; erlaubt sind PNG, JPG, GIF und WebP.');
    // Inspect raster dimensions before asking the browser to allocate a decoded image.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width = 0, height = 0;
    if (ext === 'png' && bytes.length >= 24) { width=view.getUint32(16); height=view.getUint32(20); }
    if (ext === 'gif' && bytes.length >= 10) { width=view.getUint16(6,true); height=view.getUint16(8,true); }
    if (ext === 'webp' && bytes.length >= 30) {
      const kind=String.fromCharCode(...bytes.subarray(12,16));
      if (kind === 'VP8X') { width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16); height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16); }
      else if (kind === 'VP8 ') { width=view.getUint16(26,true)&16383; height=view.getUint16(28,true)&16383; }
      else if (kind === 'VP8L' && bytes[20]===47) { width=1+bytes[21]+((bytes[22]&63)<<8); height=1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&15)<<10); }
    }
    if (ext === 'jpg') {
      let p=2;
      while (p+8<bytes.length) {
        if (bytes[p++]!==255) break;
        while(bytes[p]===255) p++;
        const marker=bytes[p++];
        if (marker===0xda || marker===0xd9) break;
        const length=view.getUint16(p);
        if (length<2 || p+length>bytes.length) break;
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) { height=view.getUint16(p+3); width=view.getUint16(p+5); break; }
        p+=length;
      }
    }
    if (!width || !height || width*height > LIMITS.pixels) fail('Bildabmessungen ungültig oder größer als 40 Megapixel.');
    const url=URL.createObjectURL(new Blob([bytes],{type:mime}));
    try {
      const image=new Image(); image.src=url;
      await Promise.race([image.decode(), new Promise((_,reject)=>setTimeout(()=>reject(new Error('Bildprüfung hat zu lange gedauert.')),10000))]);
      if (!image.naturalWidth || !image.naturalHeight) fail('Bild kann nicht geöffnet werden.');
    } catch { fail('Bild ist beschädigt oder kann nicht geöffnet werden.'); }
    finally { URL.revokeObjectURL(url); }
    return { mime, ext, bytes:bytes.length, sha256:await hash(bytes) };
  }
  async function create(items, progress = () => {}) {
    const exported=validateRecipes(items);
    const files=Object.create(null), images=[], bySource=new Map(), byHash=new Map();
    files["images/"]=new Uint8Array(0);
    let size=0;
    for (let i=0;i<exported.length;i++) {
      const recipe=exported[i];
      if (!recipe.image) continue;
      progress(`Sichere Bild: ${recipe.title} (${i+1}/${exported.length})`);
      try {
        let entry=bySource.get(recipe.image);
        if (!entry) {
          const bytes=await getImage(recipe.image), info=await imageInfo(bytes);
          entry=byHash.get(info.sha256);
          if (!entry) {
            const path=`images/${info.sha256}.${info.ext}`;
            entry={path,...info}; files[path]=bytes; byHash.set(info.sha256,entry);
            size+=bytes.length;
            if (size>LIMITS.total) fail('Bilder überschreiten insgesamt 200 MiB.');
          }
          bySource.set(recipe.image,entry);
        }
        recipe.image=entry.path;
        images.push({recipeId:recipe.id,...entry});
      } catch(error) { fail(`Keine vollständige Sicherung: Bild von „${recipe.title}“ fehlt oder ist ungültig. ${error.message}`); }
    }
    const recipeBytes=encoder.encode(JSON.stringify(exported,null,2));
    if (recipeBytes.length>LIMITS.json) fail('Rezeptdaten sind größer als 5 MiB.');
    files['recipes.json']=recipeBytes;
    const manifest={format:FORMAT,version:1,createdAt:new Date().toISOString(),recipeCount:exported.length,imageCount:byHash.size,
      recipeFile:'recipes.json',recipeSha256:await hash(recipeBytes),images,settings:'none',imageStorage:'embedded',zipMethods:[0,8]};
    files['manifest.json']=encoder.encode(JSON.stringify(manifest,null,2));
    if (files['manifest.json'].length>LIMITS.manifest || size+recipeBytes.length+files['manifest.json'].length>LIMITS.total) fail('Sicherung überschreitet die Größenbegrenzung.');
    const bytes=fflate.zipSync(files,{level:0});
    if (bytes.length>LIMITS.archive) fail('ZIP ist zu groß.');
    return {blob:new Blob([bytes],{type:'application/zip'}),manifest};
  }
  function crc32(bytes) {
    let crc=-1;
    for (const byte of bytes) { crc^=byte; for(let j=0;j<8;j++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
    return (crc^-1)>>>0;
  }
  function unzipBounded(bytes) {
    // Validate central AND local headers before any decompression; reject ZIP64,
    // encryption, duplicate names, symlinks, overlaps and undeclared entries.
    if (bytes.length<22 || bytes.length>LIMITS.archive) fail('Ungültige oder zu große ZIP-Datei.');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let end=bytes.length-22;
    while(end>=Math.max(0,bytes.length-65557) && view.getUint32(end,true)!==0x06054b50) end--;
    if(end<0 || view.getUint32(end,true)!==0x06054b50 || end+22+view.getUint16(end+20,true)!==bytes.length) fail('ZIP-Abschluss fehlt.');
    const count=view.getUint16(end+10,true), dirSize=view.getUint32(end+12,true), dir=view.getUint32(end+16,true);
    if(view.getUint16(end+4,true) || view.getUint16(end+6,true) || view.getUint16(end+8,true)!==count || count>LIMITS.files || dir+dirSize!==end) fail('Mehrteilige/ZIP64-Archive oder ungültiges ZIP-Verzeichnis werden nicht unterstützt.');
    const files=Object.create(null), names=new Set(), ranges=[];
    let p=dir,total=0;
    for(let i=0;i<count;i++) {
      if(p+46>end || view.getUint32(p,true)!==0x02014b50) fail('Beschädigtes ZIP-Verzeichnis.');
      const flags=view.getUint16(p+8,true), method=view.getUint16(p+10,true), crc=view.getUint32(p+16,true), compressed=view.getUint32(p+20,true), size=view.getUint32(p+24,true);
      const nl=view.getUint16(p+28,true), extra=view.getUint16(p+30,true), comment=view.getUint16(p+32,true), local=view.getUint32(p+42,true);
      if(p+46+nl+extra+comment>end || view.getUint16(p+34,true) || (view.getUint32(p+38,true)>>>16 & 0xf000)===0xa000) fail('Unsicherer ZIP-Eintrag.');
      const name=decoder.decode(bytes.subarray(p+46,p+46+nl));
      if(!safePath(name) || names.has(name)) fail(`Unsicherer oder doppelter ZIP-Pfad: ${name}`);
      names.add(name);
      const max=name==='manifest.json'?LIMITS.manifest:name==='recipes.json'?LIMITS.json:LIMITS.image;
      total+=size;
      if(name==='images/' && size!==0) fail('Ungültiger Bilderordner im ZIP.');
      if((flags & ~0x808)!==0 || ![0,8].includes(method) || size>max || total>LIMITS.total || size>Math.max(compressed,1)*LIMITS.ratio) fail('ZIP-Grenzen überschritten oder nicht unterstützte Komprimierung/Verschlüsselung.');
      if(local+30>dir || view.getUint32(local,true)!==0x04034b50 || view.getUint16(local+6,true)!==flags || view.getUint16(local+8,true)!==method) fail('Ungültiger lokaler ZIP-Kopf.');
      const localName=view.getUint16(local+26,true), localExtra=view.getUint16(local+28,true), start=local+30+localName+localExtra;
      if(start+compressed>dir || decoder.decode(bytes.subarray(local+30,local+30+localName))!==name) fail('ZIP-Pfade oder Größen widersprechen sich.');
      if(!(flags&8) && (view.getUint32(local+18,true)!==compressed || view.getUint32(local+22,true)!==size || view.getUint32(local+14,true)!==crc)) fail('Widersprüchliche ZIP-Größen.');
      ranges.push([local,start+compressed]);
      const input=bytes.subarray(start,start+compressed); let output;
      if(method===0) { if(compressed!==size) fail('Ungültige ZIP-Dateigröße.'); output=input.slice(); }
      else {
        const parts=[]; let actual=0;
        const inflater=new fflate.Inflate(chunk=>{ actual+=chunk.length; if(actual>size || actual>max) fail('Entpackte Datei überschreitet die Grenze.'); parts.push(chunk); });
        for(let offset=0;offset<input.length;offset+=1024) inflater.push(input.subarray(offset,offset+1024),offset+1024>=input.length);
        if(actual!==size) fail('Entpackte Dateigröße stimmt nicht.');
        output=new Uint8Array(size); let offset=0; for(const chunk of parts){output.set(chunk,offset);offset+=chunk.length;}
      }
      if(output.length!==size || crc32(output)!==crc) fail(`Beschädigte ZIP-Datei: ${name}`);
      files[name]=output; p+=46+nl+extra+comment;
    }
    ranges.sort((a,b)=>a[0]-b[0]);
    if(p!==end || (ranges.length && ranges[0][0]!==0) || ranges.some((range,i)=>i && range[0]<ranges[i-1][1])) fail('Überlappende oder unerwartete ZIP-Einträge.');
    if(!files['manifest.json'] || !files['recipes.json']) fail('manifest.json oder recipes.json fehlt.');
    return files;
  }
  function parseJson(bytes, name) {
    try { const value=JSON.parse(decoder.decode(bytes)); checkStructure(value); return value; }
    catch(error) { fail(`${name}: ungültiges JSON. ${error.message}`); }
  }
  async function inspect(file) {
    if(file.size>LIMITS.archive) fail('Die Datei ist größer als 210 MiB.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(bytes[0]!==0x50 || bytes[1]!==0x4b) {
      if(bytes.length>LIMITS.json) fail('JSON-Datei größer als 5 MiB.');
      const data=parseJson(bytes,'Legacy-Backup');
      if(!Array.isArray(data) && (!plain(data) || data.format!=='kuechenbuch-backup' || data.version!==1 || !Array.isArray(data.recipes) || data.recipeCount!==data.recipes.length)) fail('Unbekanntes Legacy-Backupformat.');
      const items=validateRecipes(Array.isArray(data)?data:data.recipes,true);
      return {legacy:true,items,images:new Map(),manifest:null,warnings:['Alte JSON-Sicherung: enthält keine eingebetteten Bilddateien. Vorhandene Bildlinks werden beim Import abgerufen, geprüft und neu gespeichert. Ohne erreichbare Originalbilder ist keine vollständige Wiederherstellung möglich.']};
    }
    let files;
    try { files=unzipBounded(bytes); } catch(error) { fail(`ZIP ungültig: ${error.message}`); }
    const manifest=parseJson(files['manifest.json'],'manifest.json');
    if(manifest.format!==FORMAT || manifest.version!==1) fail('Unbekanntes Backupformat oder unbekannte Backupversion.');
    if(typeof manifest.createdAt!=='string' || !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.recipeFile!=='recipes.json' || !Array.isArray(manifest.images) || manifest.settings!=='none' || manifest.imageStorage!=='embedded') fail('Pflichtinformationen im Manifest fehlen.');
    if(manifest.recipeSha256!==await hash(files['recipes.json'])) fail('Prüfsumme der Rezeptdaten stimmt nicht.');
    const items=validateRecipes(parseJson(files['recipes.json'],'recipes.json'));
    if(manifest.recipeCount!==items.length || !Number.isInteger(manifest.imageCount)) fail('Rezept-/Bildanzahl im Manifest stimmt nicht.');
    const images=new Map(), assignments=new Set(), required=new Set();
    for(const entry of manifest.images) {
      if(!plain(entry) || typeof entry.path!=='string' || !safePath(entry.path) || !entry.path.startsWith('images/') || assignments.has(entry.recipeId)) fail('Ungültige oder doppelte Bildzuordnung.');
      const recipe=items.find(item=>item.id===entry.recipeId);
      if(!recipe || recipe.image!==entry.path) fail('Bildzuordnung passt nicht zum Rezept.');
      assignments.add(entry.recipeId); required.add(entry.path);
      if(!files[entry.path]) fail(`Bild fehlt: „${recipe.title}“ (${entry.path}).`);
      let info=images.get(entry.path)?.info;
      try { if(!info) info=await imageInfo(files[entry.path]); }
      catch(error) { fail(`Bild von „${recipe.title}“: ${error.message}`); }
      if(entry.sha256!==info.sha256 || entry.bytes!==info.bytes || entry.mime!==info.mime) fail(`Bildprüfsumme/Metadaten stimmen nicht: „${recipe.title}“.`);
      images.set(entry.path,{bytes:files[entry.path],info});
    }
    if(items.some(recipe=>recipe.image && !assignments.has(recipe.id)) || manifest.imageCount!==required.size || Object.keys(files).some(path=>path.startsWith('images/') && path!=='images/' && !required.has(path))) fail('Unvollständige oder zusätzliche Bildzuordnungen im Backup.');
    return {legacy:false,items,images,manifest,warnings:[]};
  }
  function plan(bundle,snapshot,mode) {
    if(!['merge','replace'].includes(mode)) fail('Ungültige Wiederherstellungsoption.');
    const ids=new Set(snapshot.items.map(item=>item.id));
    const existing=bundle.items.filter(item=>ids.has(item.id)).length;
    const selected=mode==='merge'?bundle.items.filter(item=>!ids.has(item.id)):bundle.items;
    return {mode,total:bundle.items.length,existing,newCount:bundle.items.length-existing,importCount:selected.length,skipCount:mode==='merge'?existing:0,selected:clone(selected)};
  }
  async function restore(bundle,mode,adapter,{progress=()=>{},safety,expected}={}) {
    // Work from a private copy, never mutate either loaded recipes or parsed backup.
    const before=await adapter.snapshot();
    if(expected && !snapshotEqual(before,expected)) fail('Die Sammlung hat sich seit der Vorschau geändert. Bitte Datei erneut prüfen. Es wurden keine Daten geändert.');
    const chosen=plan(bundle,before,mode);
    if(mode==='replace') {
      if(!safety) fail('Vor Ersetzen ist eine vollständige Sicherheitskopie erforderlich.');
      progress('Erstelle vollständige Sicherheitskopie vor dem Ersetzen …');
      const backup=await create(before.items,progress);
      // Callback must require the user to download and explicitly confirm receipt.
      if(!await safety(backup)) fail('Abgebrochen: Sicherheitskopie wurde nicht bestätigt. Keine Rezeptdaten geändert.');
    }
    const staged=[], uploaded=new Map(), expectedImages=new Map();
    let uploadedCount=0;
    let committed=false, commitStarted=false;
    let reusableImages=null;
    async function existingImages() {
      if(reusableImages) return reusableImages;
      reusableImages=new Map();
      // Reuse only files whose bytes were actually fetched and checked. A broken
      // image on an unrelated skipped recipe must not block a merge.
      for(const source of new Set(before.items.map(recipe=>recipe.image).filter(Boolean))) {
        try { const bytes=await getImage(source), info=await imageInfo(bytes); reusableImages.set(info.sha256,source); }
        catch { /* Not a reusable candidate; safety backup already checks replace. */ }
      }
      return reusableImages;
    }
    try {
      for(const recipe of chosen.selected) {
        if(!recipe.image) { staged.push(recipe); continue; }
        progress(`Prüfe und lade Bild hoch: ${recipe.title}`);
        try {
          const source=recipe.image;
          let image=uploaded.get(source);
          if(!image) {
            const embedded=bundle.images.get(source);
            const bytes=embedded?.bytes || await getImage(source);
            const info=embedded?.info || await imageInfo(bytes);
            image=(await existingImages()).get(info.sha256);
            if(!image) { image=await adapter.upload(bytes,info); uploadedCount++; }
            const actual=await getImage(image);
            if(await hash(actual)!==info.sha256) fail('Hochgeladenes Bild ist nicht vollständig lesbar oder wurde verändert.');
            uploaded.set(source,image);
            expectedImages.set(image,info.sha256);
            reusableImages.set(info.sha256,image);
          }
          recipe.image=image;
          staged.push(recipe);
        } catch(error) { fail(`Bild von „${recipe.title}“: ${error.message}`); }
      }
      if(!snapshotEqual(before,await adapter.snapshot())) fail('Die Sammlung wurde während der Bildprüfung geändert. Bitte erneut beginnen.');
      const target=mode==='merge'?[...before.items,...staged]:staged;
      validateRecipes(target);
      progress('Speichere und kontrolliere Rezeptdaten …');
      // Adapter maintains its own journal and rolls back only its confirmed writes.
      commitStarted=true;
      await adapter.commit(before,target);
      committed=true;
      const after=await adapter.snapshot();
      if(!same([...after.items].sort((a,b)=>a.id.localeCompare(b.id)),[...target].sort((a,b)=>a.id.localeCompare(b.id)))) fail('Abschlussprüfung: gespeicherte Sammlung weicht vom Import ab. Sicherheitskopie aufbewahren und Sammlung neu laden.');
      for(const image of uploaded.values()) if(await hash(await getImage(image))!==expectedImages.get(image)) fail("Bild-Abschlussprüfung fehlgeschlagen; Rezeptdaten sind bereits gespeichert. Sicherheitskopie aufbewahren.");
      return {...chosen,imageCount:uploadedCount,items:after.items,legacy:bundle.legacy};
    } catch(error) {
      // Uploaded files deliberately stay: deleting on an uncertain network result
      // could remove an image already referenced by a successfully persisted recipe.
      fail(`${error.message}\n${committed ? "Rezeptdaten wurden bereits gespeichert, die Abschlusskontrolle ist nicht vollständig bestätigt. Bitte neu laden und Sicherheitskopie aufbewahren." : !commitStarted ? "Keine Rezeptdaten wurden geändert." : "Der Schreibvorgang wurde gestartet; beachte die Angaben zur Rücknahme und prüfe die Sammlung nach dem Neuladen."}\n${uploadedCount ? 'Neu hochgeladene Bilder bleiben vorsichtshalber erhalten; vorhandene Bilder wurden nicht gelöscht.' : 'Vorhandene Bilder wurden nicht verändert.'}`);
    }
  }
  return {LIMITS,create,inspect,plan,restore,hash,imageInfo,validateRecipes,same,snapshotEqual};
})();
