const STORAGE_KEY = "kuechenbuch-recipes-v1";
const SUPABASE_URL = "https://ohdamaixedupjivfobsv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_65F5g7J7EJ0LzAqxchLKCA_6j9K31yM";
// No saved session is read or created: all website requests use the public key.
try { localStorage.removeItem(`sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`); } catch { /* Browser storage may be disabled. */ }
let supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "kochbuch-public-v1" }
});
let recipes = [];
let storageMode = "checking";
let recipeVersions = new Map();
let editingRecipeVersion = null;
let localRecipeEtag = null;
let editorSaveInProgress = false;
let cloudWriteInProgress = 0;
let backupBusy = false;
let cloudRefreshEpoch = 0;
let cloudRefreshStarted = false;
let activeCategory = "Alle";
let searchTerm = "";
let sortMode = "title_asc";
let formIngredients = [];
let editingRecipeSnapshot = null;
let formTags = [];
let selectedTags = [];
let maxDuration = null;
let difficultyFilter = "";
let favoritesOnly = false;
const favoriteWrites = new Set();
let formComponents = [];
let formImage = "";
let pendingImageFile = null;
let imagePreviewObjectUrl = "";

const recipeGrid = document.querySelector("#recipeGrid");
const emptyState = document.querySelector("#emptyState");
const recipeModal = document.querySelector("#recipeModal");
const detailModal = document.querySelector("#detailModal");
const recipeForm = document.querySelector("#recipeForm");

function loadBrowserBackup() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const items = saved ? JSON.parse(saved) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function setStorageStatus(mode, message) {
  storageMode = mode;
  const status = document.querySelector("#storageStatus");
  document.querySelector("#storageStatusText").textContent = message;
  status.classList.toggle("browser-storage", ["browser", "error", "published"].includes(mode));
}

function ensureCanEdit() {
  if (backupBusy) return false;
  return !["checking", "error"].includes(storageMode) && Boolean(supabaseClient || storageMode === "file");
}

async function loadPublishedRecipes() {
  const response = await fetch("data/recipes.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Veröffentlichte Sammlung nicht gefunden");
  return response.json();
}

async function fetchCloudRecipeRows(client = supabaseClient, columns = "id, data, updated_at", maxRecipes = Infinity) {
  const rows = [], ids = new Set();
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("recipes").select(columns).order("id").range(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error(error?.message || "Ungültige Cloud-Antwort");
    for (const row of data) {
      if (!row.data || row.id !== row.data.id || ids.has(row.id)) throw new Error("Cloud-Datensätze sind unvollständig oder wurden während des Ladens verschoben. Bitte erneut laden.");
      ids.add(row.id); rows.push(row);
      if (rows.length > maxRecipes) throw new Error(`Sammlung größer als ${maxRecipes} Rezepte. Keine unvollständige Sicherung erstellt.`);
    }
    if (data.length < 500) return rows;
  }
}

async function loadRecipes() {
  if (supabaseClient) {
    try {
      const data = await fetchCloudRecipeRows();
      applyCloudRows(data);
      setStorageStatus("cloud", "Öffentliche Sammlung · ohne Anmeldung bearbeiten");
      return;
    } catch (error) {
      console.error("Supabase konnte nicht geladen werden:", error);
    }
  }

  try {
    recipes = await loadPublishedRecipes();
    setStorageStatus("published", "Veröffentlichte Sammlung · Cloud nicht erreichbar");
    return;
  } catch {
    recipes = loadBrowserBackup();
    setStorageStatus("browser", "Cloud nicht erreichbar · Browser-Sicherung geladen");
  }
}

function applyCloudRows(rows) {
  recipes = rows.map(row => row.data);
  recipeVersions = new Map(rows.map(row => [row.id, row.updated_at]));
}

function cloudWriteFailure(error, operation) {
  const blocked = error?.code === "42501" || /row.level.security|permission denied|not authorized/i.test(error?.message || "");
  return new Error(blocked
    ? `Supabase verweigert das öffentliche ${operation}. Die öffentlichen Schreibrechte sind noch nicht freigegeben. Der Vorgang wurde nicht als erfolgreich bestätigt.`
    : `Cloud-${operation} fehlgeschlagen: ${error?.message || "Unbekannter Fehler"}`);
}

async function unconfirmedCloudWrite(id, version, operation) {
  let unchanged = false;
  try {
    const result = await supabaseClient.from("recipes").select("updated_at").eq("id", id);
    unchanged = !result.error && result.data?.some(row => row.updated_at === version);
  } catch { /* No reliable readback: report an unconfirmed version conflict. */ }
  if (unchanged) throw new Error(`Supabase hat das öffentliche ${operation} nicht zugelassen, obwohl der Rezeptstand unverändert ist. Bitte die öffentlichen Schreibrechte freigeben. Es wurde kein Erfolg angezeigt.`);
  throw new Error(`Das Rezept wurde möglicherweise inzwischen verändert oder gelöscht. ${operation} wurde nicht bestätigt. Bitte die Sammlung neu laden.`);
}

async function saveRecipeToCloud(recipe, { expectedVersion = null, isNew = false } = {}) {
  if (supabaseClient) {
    cloudWriteInProgress += 1;
    cloudRefreshEpoch += 1;
    try {
      if (!isNew && !expectedVersion) throw new Error("Der Versionsstand fehlt; das Rezept wurde möglicherweise inzwischen verändert. Bitte neu laden.");
      const timestamp = new Date().toISOString();
      const row = {
        id: recipe.id,
        data: recipe,
        updated_at: timestamp
      };
      let result;
      if (isNew) {
        result = await supabaseClient.from("recipes").insert(row).select("updated_at");
      } else {
        let query = supabaseClient.from("recipes").update(row).eq("id", recipe.id);
        if (expectedVersion) query = query.eq("updated_at", expectedVersion);
        result = await query.select("updated_at");
      }
      if (result.error) throw cloudWriteFailure(result.error, "Speichern");
      if (!result.data?.length) {
        await unconfirmedCloudWrite(recipe.id, expectedVersion, "Speichern");
      }
      recipeVersions.set(recipe.id, result.data[0].updated_at);
      localStorage.removeItem(STORAGE_KEY);
      setStorageStatus("cloud", "Speichern in Supabase bestätigt");
      return true;
    } finally {
      cloudWriteInProgress -= 1;
    }
  }

  return saveRecipesToLocalServer(recipes.some(item => item.id === recipe.id)
    ? recipes.map(item => item.id === recipe.id ? recipe : item) : [recipe, ...recipes]);
}

async function deleteRecipeFromCloud(recipe) {
  if (supabaseClient) {
    cloudWriteInProgress += 1;
    cloudRefreshEpoch += 1;
    try {
      if (!recipeVersions.get(recipe.id)) throw new Error("Der Versionsstand fehlt; das Rezept wurde möglicherweise inzwischen verändert. Bitte neu laden.");
      let query = supabaseClient.from("recipes").delete().eq("id", recipe.id);
      const expectedVersion = recipeVersions.get(recipe.id);
      if (expectedVersion) query = query.eq("updated_at", expectedVersion);
      const { data, error } = await query.select("id");
      if (error) throw cloudWriteFailure(error, "Löschen");
      if (!data?.length) {
        await unconfirmedCloudWrite(recipe.id, expectedVersion, "Löschen");
      }
      recipeVersions.delete(recipe.id);
      setStorageStatus("cloud", "Rezept zentral gelöscht");
      return true;
    } finally {
      cloudWriteInProgress -= 1;
    }
  }
  if (!ensureCanEdit()) throw new Error("Der Rezeptspeicher ist momentan nicht erreichbar.");
  return saveRecipesToLocalServer(recipes.filter(item => item.id !== recipe.id));
}

async function saveRecipesToLocalServer(items) {
  if (storageMode !== "file") throw new Error("Kein beschreibbarer Speicher verfügbar. Bitte Verbindung prüfen oder server.py starten.");
  const response = await fetch("/api/recipes", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(localRecipeEtag ? { "If-Match": localRecipeEtag } : {}) },
    body: JSON.stringify(items)
  });
  if (!response.ok) throw new Error(response.status === 409 ? "Die lokale Sammlung wurde inzwischen verändert. Bitte neu laden. Deine Änderung wurde nicht übernommen." : "Speichern im Programmordner fehlgeschlagen. Deine Änderung wurde nicht übernommen.");
  localRecipeEtag = response.headers.get("ETag");
  setStorageStatus("file", "Sicher im Programmordner gespeichert");
  return true;
}

async function refreshRecipesFromCloud({ updateStatus = true } = {}) {
  if (!supabaseClient || cloudWriteInProgress || backupBusy) return false;
  const refreshEpoch = cloudRefreshEpoch;
  let data;
  try { data = await fetchCloudRecipeRows(); }
  catch (error) { console.error("Cloud-Aktualisierung fehlgeschlagen:", error); return false; }
  if (backupBusy || cloudWriteInProgress || refreshEpoch !== cloudRefreshEpoch) return false;
  applyCloudRows(data);
  normalizeAllRecipes();
  render();
  if (updateStatus) {
    setStorageStatus("cloud", "Öffentliche Sammlung · zentral synchronisiert");
  }
  return true;
}

function startAutomaticCloudRefresh() {
  if (!supabaseClient || cloudRefreshStarted) return;
  cloudRefreshStarted = true;
  setInterval(() => {
    if (!document.hidden) refreshRecipesFromCloud();
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRecipesFromCloud();
  });
}

function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[character]);
}

function validUrl(value) {
  try {
    if (!value) return null;
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function clearPreviewObjectUrl() {
  if (imagePreviewObjectUrl) URL.revokeObjectURL(imagePreviewObjectUrl);
  imagePreviewObjectUrl = "";
}

function updateImagePreview() {
  const field = document.querySelector("#imagePreviewField");
  const preview = document.querySelector("#imagePreview");
  clearPreviewObjectUrl();
  let source = validUrl(formImage);
  if (pendingImageFile) {
    imagePreviewObjectUrl = URL.createObjectURL(pendingImageFile);
    source = imagePreviewObjectUrl;
  }
  field.hidden = !source;
  if (source) preview.src = source;
  else preview.removeAttribute("src");
}

async function uploadPendingImage() {
  if (!pendingImageFile) return formImage;
  const imageInfo = await KochbuchBackup.imageInfo(new Uint8Array(await pendingImageFile.arrayBuffer()));
  if (supabaseClient) {
    const extension = imageInfo.ext;
    const uniqueId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const filename = `public/recipe-${uniqueId}.${extension}`;
    const { error } = await supabaseClient.storage
      .from("recipe-images")
      .upload(filename, pendingImageFile, { contentType: imageInfo.mime, upsert: false });
    if (error) throw cloudWriteFailure(error, "Bild-Upload");
    const { data } = supabaseClient.storage.from("recipe-images").getPublicUrl(filename);
    formImage = data.publicUrl;
    pendingImageFile = null;
    clearPreviewObjectUrl();
    return formImage;
  }
  const response = await fetch("/api/image", {
    method: "POST",
    headers: { "Content-Type": imageInfo.mime },
    body: pendingImageFile
  });
  let result = {};
  try { result = await response.json(); } catch { /* Fehlermeldung folgt unten. */ }
  if (!response.ok || !result.path) {
    throw new Error(result.error || "Das Bild konnte nicht im Programmordner gespeichert werden.");
  }
  formImage = result.path;
  pendingImageFile = null;
  clearPreviewObjectUrl();
  return formImage;
}

const nutritionFields = {
  energyKj: "#energyKjInput",
  energyKcal: "#energyKcalInput",
  fat: "#fatInput",
  saturates: "#saturatesInput",
  carbs: "#carbsInput",
  sugars: "#sugarsInput",
  protein: "#proteinInput",
  salt: "#saltInput",
  fiber: "#fiberInput"
};

const nutritionLabels = {
  energyKj: ["Energie", "kJ"],
  energyKcal: ["Kalorien", "kcal"],
  fat: ["Fett", "g"],
  saturates: ["davon gesättigte Fettsäuren", "g"],
  carbs: ["Kohlenhydrate", "g"],
  sugars: ["davon Zucker", "g"],
  protein: ["Eiweiß", "g"],
  salt: ["Salz", "g"],
  fiber: ["Ballaststoffe", "g"]
};

function setNutritionValues(nutrition = {}) {
  Object.entries(nutritionFields).forEach(([key, selector]) => {
    const value = nutrition[key];
    document.querySelector(selector).value = value ?? "";
  });
}

function getNutritionValues() {
  return Object.fromEntries(Object.entries(nutritionFields).map(([key, selector]) => {
    const raw = document.querySelector(selector).value;
    return [key, raw === "" ? null : Number(raw)];
  }));
}

function hasNutritionValues(nutrition = {}) {
  return Object.values(nutrition).some(value => value !== null && value !== "" && value !== undefined);
}

function normalizeNutritionBasis(value = {}) {
  value = value || {};
  const unit = value.unit === "servings" ? "servings" : "grams";
  const amount = Number(value.amount);
  return { unit, amount: amount > 0 ? amount : (unit === "servings" ? 1 : 100) };
}

function nutritionBasisLabel(value = {}) {
  const basis = normalizeNutritionBasis(value);
  const amount = formatIngredientAmount(basis.amount);
  if (basis.unit === "servings") return `${amount} ${basis.amount === 1 ? "Portion" : "Portionen"}`;
  return `${amount} g`;
}

function getNutritionBasisFromForm() {
  return JSON.parse(document.querySelector("#nutritionBasisInput").value);
}

function setNutritionBasisForm(value = {}) {
  const basis = normalizeNutritionBasis(value);
  const select = document.querySelector("#nutritionBasisInput");
  select.querySelectorAll(".legacy-basis").forEach(option => option.remove());
  const serialized = JSON.stringify(basis);
  if (![...select.options].some(option => option.value === serialized)) {
    const option = new Option(`${nutritionBasisLabel(basis)} (bisherige Bezugsmenge)`, serialized);
    option.className = "legacy-basis";
    select.add(option);
  }
  select.value = serialized;
}

const ingredientUnits = ["g", "kg", "ml", "l", "Stück", "EL", "TL", "Prise"];

function newIngredientId() {
  return crypto.randomUUID ? crypto.randomUUID() : `ingredient-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newComponentId() {
  return crypto.randomUUID ? crypto.randomUUID() : `component-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeComponent(value = {}) {
  return {
    ...value,
    id: value.id || newComponentId(),
    name: value.name || "Rezeptteil",
    instructions: value.instructions || ""
  };
}

function normalizeIngredient(value) {
  if (value && typeof value === "object") {
    return {
      ...value,
      id: value.id || newIngredientId(),
      name: value.name || "",
      amount: value.amount ?? "",
      unit: value.unit || "g",
      weightGrams: value.weightGrams ?? "",
      checked: Boolean(value.checked),
      nutritionPer100g: value.nutritionPer100g || null,
      nutritionSource: value.nutritionSource || "",
      nutritionMatches: value.nutritionMatches || [],
      productBarcode: value.productBarcode || "",
      componentId: value.componentId || ""
    };
  }
  const text = String(value || "").trim();
  const match = text.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|EL|TL|Stück|Prise)?\s+(.+)$/i);
  if (!match) return { id: newIngredientId(), name: text, amount: "", unit: "g", weightGrams: "", checked: false, nutritionPer100g: null, nutritionSource: "", nutritionMatches: [], productBarcode: "", componentId: "" };
  const enteredUnit = match[2] || "Stück";
  const unit = ingredientUnits.find(item => item.toLowerCase() === enteredUnit.toLowerCase()) || "Stück";
  return { id: newIngredientId(), name: match[3], amount: Number(match[1].replace(",", ".")), unit, weightGrams: "", checked: false, nutritionPer100g: null, nutritionSource: "", nutritionMatches: [], productBarcode: "", componentId: "" };
}

function normalizeAllRecipes() {
  recipes.forEach(recipe => {
    if (!Array.isArray(recipe.components) || !recipe.components.length) {
      recipe.components = [normalizeComponent({ name: "Allgemein", instructions: recipe.instructions || "" })];
    } else {
      recipe.components = recipe.components.map(normalizeComponent);
    }
    recipe.ingredients = (recipe.ingredients || []).map(normalizeIngredient);
    const fallbackComponentId = recipe.components[0].id;
    recipe.ingredients.forEach(ingredient => {
      if (!recipe.components.some(component => component.id === ingredient.componentId)) ingredient.componentId = fallbackComponentId;
    });
  });
}

function formatIngredientAmount(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value);
}

function ingredientLabel(ingredient, factor = 1) {
  const item = normalizeIngredient(ingredient);
  const numericAmount = Number(item.amount);
  const hasAmount = item.amount !== "" && Number.isFinite(numericAmount);
  const amount = hasAmount ? `${formatIngredientAmount(numericAmount * factor)} ${item.unit} ` : "";
  return `${amount}${item.name}`.trim();
}

function sortedRecipesForExport() {
  return [...recipes].sort((left, right) => left.title.localeCompare(right.title, "de", { sensitivity: "base" }));
}

async function loadLatestRecipesForExport() {
  if (supabaseClient) {
    const refreshed = await refreshRecipesFromCloud({ updateStatus: false });
    if (!refreshed) throw new Error("Die neuesten Cloud-Daten konnten nicht geladen werden. Bitte prüfe deine Internetverbindung und versuche es erneut.");
  }
  if (!recipes.length) throw new Error("Es sind noch keine Rezepte zum Exportieren vorhanden.");
}

function recipeBookHtml(items) {
  const generatedAt = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short" }).format(new Date());
  const contents = items.map((recipe, index) => `<li><span>${index + 1}. ${escapeHtml(recipe.title)}</span><span>${escapeHtml(recipe.category || "Ohne Kategorie")}</span></li>`).join("");
  const recipesHtml = items.map((recipe, index) => {
    const components = recipe.components?.length
      ? recipe.components
      : [normalizeComponent({ name: "Allgemein", instructions: recipe.instructions || "" })];
    const imageUrl = validUrl(recipe.image);
    const parts = components.map(component => {
      const ingredients = (recipe.ingredients || [])
        .map(normalizeIngredient)
        .filter(ingredient => ingredient.componentId === component.id);
      const ingredientRows = ingredients.length
        ? ingredients.map(ingredient => `<li>${escapeHtml(ingredientLabel(ingredient))}</li>`).join("")
        : "<li class=\"muted\">Keine Zutaten eingetragen</li>";
      return `<section class="part">
        <h3>${escapeHtml(component.name || "Allgemein")}</h3>
        <div class="part-columns">
          <div><h4>Zutaten</h4><ul class="ingredients">${ingredientRows}</ul></div>
          <div><h4>Zubereitung</h4><p class="instructions">${escapeHtml(component.instructions || "Keine Zubereitung eingetragen")}</p></div>
        </div>
      </section>`;
    }).join("");
    const nutrition = recipe.nutrition || {};
    const nutritionBasis = nutritionBasisLabel(recipe.nutritionBasis);
    const nutritionRows = Object.entries(nutritionLabels)
      .filter(([key]) => nutrition[key] !== null && nutrition[key] !== "" && nutrition[key] !== undefined)
      .map(([key, [label, unit]]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(nutrition[key]))} ${escapeHtml(unit)}</td></tr>`)
      .join("");
    const links = (recipe.links || []).map(validUrl).filter(Boolean);
    return `<article class="recipe">
      <div class="recipe-number">Rezept ${index + 1} von ${items.length}</div>
      ${imageUrl ? `<img class="recipe-image" src="${escapeHtml(imageUrl)}" alt="">` : ""}
      <p class="category">${escapeHtml(recipe.category || "Ohne Kategorie")}</p>
      <h2>${escapeHtml(recipe.title)}</h2>
      ${Number(recipe.servings) > 0 ? `<p class="servings">Grundrezept für ${escapeHtml(formatIngredientAmount(Number(recipe.servings)))} Portionen</p>` : ""}
      ${recipeInformationHtml(recipe)}
      ${normalizeTags(recipe.tags).length ? `<p class="recipe-tags">Tags: ${normalizeTags(recipe.tags).map(escapeHtml).join(" · ")}</p>` : ""}
      ${parts}
      ${nutritionRows ? `<section class="extra"><h3>Nährwertangaben</h3><p class="caption">Angaben für ${escapeHtml(nutritionBasis)}${needsNutritionReview(recipe) ? " · bitte manuell überprüfen" : ""}</p><table><tbody>${nutritionRows}</tbody></table></section>` : ""}
      ${links.length ? `<section class="extra"><h3>Links</h3><ul class="links">${links.map(url => `<li>${escapeHtml(url)}</li>`).join("")}</ul></section>` : ""}
    </article>`;
  }).join("");

  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Küchenbuch</title><style>
    :root{color:#243229;background:#fffdf8;font-family:Arial,sans-serif}*{box-sizing:border-box}body{margin:0;background:#ece9e0}.toolbar{position:sticky;z-index:10;top:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;color:white;background:#243229}.toolbar p{margin:0;font-size:13px}.toolbar button{padding:10px 17px;border:0;border-radius:999px;color:#243229;background:#fffdf8;cursor:pointer;font-weight:700}.book{overflow-wrap:anywhere;width:210mm;margin:18px auto;background:#fffdf8;box-shadow:0 8px 30px #0002}.cover,.contents,.recipe{padding:18mm 16mm}.cover{display:flex;min-height:270mm;flex-direction:column;justify-content:center;text-align:center}.mark{display:grid;width:25mm;height:25mm;margin:0 auto 15mm;place-items:center;border:1px solid #243229;border-radius:50%;font:42px Georgia,serif}.eyebrow,.category,.recipe-number{font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#526b54}.cover h1{margin:0;font:70px/1 Georgia,serif}.cover .subtitle{margin:8mm auto 0;max-width:120mm;color:#667068;font-size:17px}.cover .date{margin-top:25mm;color:#667068;font-size:12px}.contents{min-height:270mm}.contents h2,.recipe h2{margin:0 0 10mm;font:44px/1.05 Georgia,serif}.contents ol{margin:0;padding:0;list-style:none}.contents li{display:flex;justify-content:space-between;gap:15mm;padding:3mm 0;border-bottom:1px solid #dedbd2;font-size:13px}.contents li span:last-child{color:#667068}.recipe{position:relative;min-height:270mm;break-before:page}.recipe-number{position:absolute;right:16mm;top:18mm;color:#778078}.recipe-image{display:block;width:100%;height:65mm;margin-bottom:9mm;object-fit:cover}.category{margin:0 0 3mm}.recipe h2{margin-bottom:3mm}.servings{margin:0 0 10mm;color:#667068;font-size:12px}.part{margin-top:9mm;padding-top:7mm;border-top:1px solid #d8d5cc}.part h3,.extra h3{margin:0 0 5mm;font:26px Georgia,serif;color:#526b54}.part-columns>div{min-width:0}.part-columns{display:grid;grid-template-columns:42% 1fr;gap:12mm}.part h4{margin:0 0 3mm;font-size:11px;letter-spacing:.1em;text-transform:uppercase}.ingredients{margin:0;padding:0;list-style:none}.ingredients li{padding:2.2mm 0;border-bottom:1px solid #ebe8df;font-size:12px}.instructions{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6}.muted,.caption{color:#777f78}.extra{margin-top:9mm;padding-top:7mm;border-top:1px solid #d8d5cc;break-inside:avoid}.caption{margin:-3mm 0 3mm;font-size:10px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:2mm 0;border-bottom:1px solid #ebe8df;text-align:left}td{text-align:right}.recipe-information{margin-top:6mm;break-inside:avoid}.recipe-information h3{font:22px Georgia,serif}.recipe-information dl{display:flex;flex-wrap:wrap;gap:4mm 8mm;font-size:11px}.recipe-information dt{color:#667068}.recipe-information dd{margin:1mm 0}.recipe-information .nutrition-note,.recipe-tags{font-size:10px;color:#667068}.links{margin:0;padding-left:5mm;font-size:10px;line-height:1.5;overflow-wrap:anywhere}@page{size:A4;margin:0}@media print{body{background:white}.toolbar{display:none}.book{width:auto;margin:0;box-shadow:none}.cover,.contents,.recipe{min-height:297mm}.part,.part-columns,.ingredients li{break-inside:avoid}}
    @page recipe-page{size:A4;margin:16mm}@media print{.recipe{page:recipe-page;min-height:265mm;padding:0}.recipe-number{top:0;right:0}}
  </style></head><body><div class="toolbar"><p>Wähle im Druckdialog „Als PDF sichern“.</p><button type="button" onclick="window.print()">Drucken / als PDF sichern</button></div><main class="book"><section class="cover"><div class="mark">K</div><p class="eyebrow">Meine Rezeptsammlung</p><h1>Küchenbuch</h1><p class="subtitle">${items.length} ${items.length === 1 ? "Rezept" : "Rezepte"} - zum Nachkochen, Teilen und Aufbewahren.</p><p class="date">Erstellt am ${escapeHtml(generatedAt)}</p></section><section class="contents"><p class="eyebrow">Inhalt</p><h2>Alle Rezepte</h2><ol>${contents}</ol></section>${recipesHtml}</main></body></html>`;
}

async function openRecipeBookForPdf() {
  const printWindow = window.open("", "_blank");
  if (!printWindow) throw new Error("Das PDF-Fenster wurde blockiert. Bitte erlaube Pop-ups für diese Website und versuche es erneut.");
  printWindow.document.write("<!doctype html><title>Rezeptbuch wird vorbereitet …</title><p style='font-family:Arial;padding:30px'>Die neuesten Rezepte werden geladen …</p>");
  try {
    await loadLatestRecipesForExport();
    printWindow.document.open();
    printWindow.document.write(recipeBookHtml(sortedRecipesForExport()));
    printWindow.document.close();
  } catch (error) {
    printWindow.close();
    throw error;
  }
}

async function runExport(button, loadingText, action) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = loadingText;
  try {
    await action();
  } catch (error) {
    alert(error.message || "Der Export konnte nicht erstellt werden.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function addIngredient(initial = {}) {
  const ingredient = normalizeIngredient(initial);
  if (!ingredient.componentId) ingredient.componentId = formComponents[0]?.id || "";
  formIngredients.unshift(ingredient);
  renderIngredientRows();
}

function addComponent() {
  formComponents.push(normalizeComponent({ name: `Rezeptteil ${formComponents.length + 1}` }));
  renderComponentRows();
  renderIngredientRows();
}

function renderComponentRows() {
  const container = document.querySelector("#componentRows");
  container.replaceChildren();
  formComponents.forEach((component, index) => {
    const row = document.createElement("article");
    row.className = "component-row";
    row.innerHTML = `
      <label>Name des Rezeptteils<input class="component-name-input" type="text" value="${escapeHtml(component.name)}" placeholder="z. B. Teig (optional)"></label>
      <label>Anleitung<textarea class="component-instructions-input" rows="4" placeholder="Zubereitung für diesen Teil … (optional)">${escapeHtml(component.instructions)}</textarea></label>
      <button class="component-remove" type="button" aria-label="Rezeptteil entfernen" ${formComponents.length === 1 ? "disabled" : ""}>×</button>`;
    row.querySelector(".component-name-input").addEventListener("input", event => { component.name = event.target.value; });
    row.querySelector(".component-name-input").addEventListener("change", renderIngredientRows);
    row.querySelector(".component-instructions-input").addEventListener("input", event => { component.instructions = event.target.value; });
    row.querySelector(".component-remove").addEventListener("click", () => {
      if (formComponents.length === 1) return;
      const fallbackId = formComponents.find(item => item.id !== component.id).id;
      formIngredients.forEach(ingredient => { if (ingredient.componentId === component.id) ingredient.componentId = fallbackId; });
      formComponents.splice(index, 1);
      renderComponentRows();
      renderIngredientRows();
    });
    container.append(row);
  });
}

function renderIngredientRows() {
  const container = document.querySelector("#ingredientRows");
  container.replaceChildren();
  const groupContainers = new Map();
  formComponents.forEach(component => {
    const group = document.createElement("section");
    group.className = "ingredient-group";
    group.innerHTML = `<div class="ingredient-group-heading"><h4>${escapeHtml(component.name)}</h4><button class="secondary-button compact-button" type="button" aria-label="Zutat für ${escapeHtml(component.name)} hinzufügen">＋ Zutat hinzufügen</button></div><div class="ingredient-group-rows"><p class="ingredient-group-empty">Noch keine Zutaten in diesem Rezeptteil.</p></div>`;
    group.querySelector("button").addEventListener("click", () => addIngredient({ componentId: component.id }));
    const rows = group.querySelector(".ingredient-group-rows");
    groupContainers.set(component.id, rows);
    container.append(group);
  });
  formIngredients.forEach((ingredient, index) => {
    const row = document.createElement("article");
    row.className = "ingredient-row";
    const unitOptions = [...new Set([...ingredientUnits, ingredient.unit])].map(unit => `<option value="${escapeHtml(unit)}"${unit === ingredient.unit ? " selected" : ""}>${escapeHtml(unit)}</option>`).join("");
    const componentOptions = formComponents.map(component => `<option value="${escapeHtml(component.id)}"${component.id === ingredient.componentId ? " selected" : ""}>${escapeHtml(component.name)}</option>`).join("");
    row.innerHTML = `
      <label>Menge<input class="ingredient-amount-input" type="number" min="0" step="0.01" value="${escapeHtml(String(ingredient.amount ?? ""))}" placeholder="100"></label>
      <label>Einheit<select class="ingredient-unit-input">${unitOptions}</select></label>
      <label class="ingredient-name-field">Zutat<input class="ingredient-name-input" type="text" value="${escapeHtml(ingredient.name)}" placeholder="z. B. Mehl (optional)"></label>
      <button class="ingredient-row-remove" type="button" aria-label="Zutat entfernen">×</button>
      <label class="ingredient-component-field">Gehört zu<select class="ingredient-component-input">${componentOptions}</select></label>
      `;

    const update = (key, value) => { ingredient[key] = value; };
    row.querySelector(".ingredient-amount-input").addEventListener("input", event => update("amount", event.target.value === "" ? "" : Number(event.target.value)));
    row.querySelector(".ingredient-unit-input").addEventListener("change", event => update("unit", event.target.value));
    row.querySelector(".ingredient-name-input").addEventListener("input", event => update("name", event.target.value));
    row.querySelector(".ingredient-component-input").addEventListener("change", event => {
      update("componentId", event.target.value);
      renderIngredientRows();
    });
    row.querySelector(".ingredient-row-remove").addEventListener("click", () => { formIngredients.splice(index, 1); renderIngredientRows(); });
    const target = groupContainers.get(ingredient.componentId) || groupContainers.values().next().value;
    if (target) {
      target.querySelector(".ingredient-group-empty")?.remove();
      target.append(row);
    }
  });
}

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeTags(tags) {
  const unique = new Map();
  (Array.isArray(tags) ? tags : []).forEach(value => {
    const tag = String(value).normalize("NFKC").trim().replace(/\s+/g, " ");
    const key = tag.toLocaleLowerCase("de");
    if (tag && !unique.has(key)) unique.set(key, tag);
  });
  return [...unique.values()];
}
function tagKey(tag) { return normalizeTags([tag])[0]?.toLocaleLowerCase("de") || ""; }
function availableTags() {
  return normalizeTags([...recipes.flatMap(recipe => recipe.tags || []), ...formTags, ...selectedTags])
    .sort((a, b) => a.localeCompare(b, "de"));
}
function totalDuration(recipe) {
  const values = [recipe.prepMinutes, recipe.cookMinutes, recipe.restMinutes].map(optionalNumber).filter(value => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
function recipeSummary(recipe) {
  const duration = totalDuration(recipe);
  return [duration !== null ? `${formatIngredientAmount(duration)} Min. gesamt` : "",
    Number(recipe.servings) > 0 ? `${formatIngredientAmount(recipe.servings)} Portionen` : "",
    recipe.difficulty || ""].filter(Boolean);
}
function recipeInformationHtml(recipe) {
  const fields = [["prepMinutes", "Vorbereitungszeit", "Min."], ["cookMinutes", "Koch-/Backzeit", "Min."], ["restMinutes", "Ruhe-/Gehzeit", "Min."], ["finishedWeightGrams", "Fertiges Gesamtgewicht", "g"]];
  const rows = fields.filter(([key]) => optionalNumber(recipe[key]) !== null)
    .map(([key, label, unit]) => `<div><dt>${label}</dt><dd>${formatIngredientAmount(recipe[key])} ${unit}</dd></div>`);
  if (recipe.difficulty) rows.push(`<div><dt>Schwierigkeitsgrad</dt><dd>${escapeHtml(recipe.difficulty)}</dd></div>`);
  if (totalDuration(recipe) !== null) rows.push(`<div><dt>Gesamtdauer</dt><dd>${formatIngredientAmount(totalDuration(recipe))} Min.</dd></div>`);
  return rows.length ? `<section class="recipe-information"><h3>Rezeptinformationen</h3><dl>${rows.join("")}</dl>${totalDuration(recipe) !== null ? '<p class="nutrition-note">Summe der angegebenen Zeiten; parallele Schritte sind nicht berücksichtigt.</p>' : ""}</section>` : "";
}
function needsNutritionReview(recipe) {
  return Boolean(recipe && hasNutritionValues(recipe.nutrition || {}) && recipe.nutritionVerified !== true);
}
function matchesFilters(recipe) {
  const tags = normalizeTags(recipe.tags).map(tagKey);
  const duration = totalDuration(recipe);
  const searchable = `${recipe.title} ${(recipe.ingredients || []).map(item => normalizeIngredient(item).name).join(" ")}`.toLocaleLowerCase("de");
  return (activeCategory === "Alle" || recipe.category === activeCategory)
    && searchable.includes(searchTerm.toLocaleLowerCase("de"))
    && selectedTags.every(tag => tags.includes(tagKey(tag)))
    && (maxDuration === null || (duration !== null && duration <= maxDuration))
    && (!difficultyFilter || recipe.difficulty === difficultyFilter)
    && (!favoritesOnly || recipe.favorite === true);
}
function renderTagChoices() {
  const container = document.querySelector("#tagFilterChoices");
  container.replaceChildren();
  availableTags().forEach(tag => {
    const label = document.createElement("label");
    label.className = "tag-choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selectedTags.some(value => tagKey(value) === tagKey(tag));
    input.addEventListener("change", () => {
      selectedTags = input.checked ? normalizeTags([...selectedTags, tag]) : selectedTags.filter(value => tagKey(value) !== tagKey(tag));
      render();
    });
    label.append(input, document.createTextNode(tag));
    container.append(label);
  });
}
function renderFormTags() {
  const container = document.querySelector("#formTags");
  container.replaceChildren();
  formTags.forEach(tag => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tag-chip";
    button.textContent = `${tag} ×`;
    button.setAttribute("aria-label", `Tag ${tag} entfernen`);
    button.addEventListener("click", () => { formTags = formTags.filter(value => tagKey(value) !== tagKey(tag)); renderFormTags(); });
    container.append(button);
  });
  document.querySelector("#tagSuggestions").replaceChildren(...availableTags().map(tag => new Option(tag, tag)));
}
function addFormTag() {
  const input = document.querySelector("#tagInput");
  formTags = normalizeTags([...formTags, input.value]);
  input.value = "";
  renderFormTags();
}
function configureFavoriteButton(button, recipe) {
  button.textContent = recipe.favorite === true ? "♥" : "♡";
  button.classList.toggle("active", recipe.favorite === true);
  button.setAttribute("aria-pressed", String(recipe.favorite === true));
  button.setAttribute("aria-label", recipe.favorite === true ? "Favorit entfernen" : "Als Favorit markieren");
  button.disabled = favoriteWrites.has(recipe.id);
  button.addEventListener("click", async event => {
    event.stopPropagation();
    if (!ensureCanEdit() || favoriteWrites.has(recipe.id)) return;
    favoriteWrites.add(recipe.id);
    button.disabled = true;
    // Use the latest loaded version; commit UI state only after persistence succeeds.
    const latest = recipes.find(item => item.id === recipe.id);
    if (!latest) { favoriteWrites.delete(recipe.id); button.disabled = false; return; }
    const updated = { ...latest, favorite: latest.favorite !== true };
    try {
      await saveRecipeToCloud(updated, { expectedVersion: recipeVersions.get(recipe.id) || null });
      recipes = recipes.map(item => item.id === updated.id ? updated : item);
      render();
      if (detailModal.open && document.querySelector("#recipeDetail").dataset.recipeId === recipe.id) openDetail(recipe.id);
    } catch (error) {
      alert(error.message || "Favorit konnte nicht gespeichert werden.");
      if (error.message?.includes("inzwischen")) await refreshRecipesFromCloud();
    } finally {
      favoriteWrites.delete(recipe.id);
      document.querySelectorAll(".recipe-card").forEach(card => { card.querySelector(".favorite-button").disabled = favoriteWrites.has(card.dataset.id); });
      const detailHeart = document.querySelector('[data-action="favorite"]');
      if (detailHeart) detailHeart.disabled = favoriteWrites.has(document.querySelector("#recipeDetail").dataset.recipeId);
    }
  });
}

document.querySelector("#addTagButton").addEventListener("click", addFormTag);
document.querySelector("#tagInput").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); addFormTag(); }
});
document.querySelector("#maxDurationInput").addEventListener("input", event => { maxDuration = optionalNumber(event.target.value); render(); });
document.querySelector("#difficultyFilter").addEventListener("change", event => { difficultyFilter = event.target.value; render(); });
document.querySelector("#favoritesFilter").addEventListener("change", event => { favoritesOnly = event.target.checked; render(); });
document.querySelector("#resetFiltersButton").addEventListener("click", () => {
  activeCategory = "Alle"; selectedTags = []; maxDuration = null; difficultyFilter = ""; favoritesOnly = false; searchTerm = "";
  document.querySelector("#searchInput").value = "";
  document.querySelector("#maxDurationInput").value = "";
  document.querySelector("#difficultyFilter").value = "";
  document.querySelector("#favoritesFilter").checked = false;
  document.querySelectorAll(".category-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.category === "Alle"));
  render();
});

function render() {
  renderTagChoices();
  document.querySelectorAll(".category-tab").forEach(tab => { tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(tab.dataset.category === activeCategory)); });
  const filtered = recipes.filter(matchesFilters);
  const compareTitles = (left, right) => left.title.localeCompare(right.title, "de", { sensitivity: "base" });
  filtered.sort((left, right) => {
    if (sortMode === "title_desc") return compareTitles(right, left);
    if (sortMode === "category") {
      return left.category.localeCompare(right.category, "de", { sensitivity: "base" }) || compareTitles(left, right);
    }
    if (sortMode === "updated_desc") {
      return new Date(recipeVersions.get(right.id) || 0).getTime() - new Date(recipeVersions.get(left.id) || 0).getTime() || compareTitles(left, right);
    }
    return compareTitles(left, right);
  });

  recipeGrid.replaceChildren();
  filtered.forEach(recipe => {
    const fragment = document.querySelector("#recipeCardTemplate").content.cloneNode(true);
    const card = fragment.querySelector(".recipe-card");
    const image = fragment.querySelector("img");
    const imageUrl = validUrl(recipe.image);
    if (imageUrl) {
      image.src = imageUrl;
      image.alt = recipe.title;
      image.addEventListener("error", () => image.remove());
    } else image.remove();
    fragment.querySelector(".category-badge").textContent = recipe.category;
    fragment.querySelector("h3").textContent = recipe.title;
    fragment.querySelector(".card-open").addEventListener("click", () => openDetail(recipe.id));
    fragment.querySelector(".card-meta").textContent = recipeSummary(recipe).join(" · ");
    const heart = fragment.querySelector(".favorite-button");
    configureFavoriteButton(heart, recipe);
    card.dataset.id = recipe.id;
    recipeGrid.append(fragment);
  });

  emptyState.hidden = filtered.length > 0;
  emptyState.querySelector("h3").textContent = recipes.length ? "Keine passenden Rezepte" : "Noch keine Rezepte hier";
  emptyState.querySelector("p").textContent = recipes.length ? "Passe die Suche oder die Filter an, um weitere Rezepte zu sehen." : "Füge dein erstes Rezept hinzu und beginne deine persönliche Sammlung.";
  recipeGrid.hidden = filtered.length === 0;
  document.querySelector("#countAll").textContent = recipes.length;
  document.querySelector("#countStarter").textContent = recipes.filter(r => r.category === "Vorspeise").length;
  document.querySelector("#countMain").textContent = recipes.filter(r => r.category === "Hauptspeise").length;
  document.querySelector("#countDessert").textContent = recipes.filter(r => r.category === "Nachspeise").length;
}

function openForm(recipe = null, expectedVersion = null) {
  if (!ensureCanEdit()) return;
  editingRecipeVersion = recipe ? (expectedVersion || recipeVersions.get(recipe.id) || null) : null;
  recipeForm.reset();
  editingRecipeSnapshot = recipe ? JSON.parse(JSON.stringify(recipe)) : {};
  formComponents = typeof structuredClone === "function" ? structuredClone(recipe?.components || []) : JSON.parse(JSON.stringify(recipe?.components || []));
  formComponents = formComponents.map(normalizeComponent);
  if (!formComponents.length) formComponents.push(normalizeComponent({ name: "Allgemein", instructions: recipe?.instructions || "" }));
  formIngredients = typeof structuredClone === "function" ? structuredClone(recipe?.ingredients || []) : JSON.parse(JSON.stringify(recipe?.ingredients || []));
  formIngredients = formIngredients.map(normalizeIngredient);
  formIngredients.forEach(ingredient => {
    if (!formComponents.some(component => component.id === ingredient.componentId)) ingredient.componentId = formComponents[0].id;
  });
  if (!formIngredients.length) formIngredients.push(normalizeIngredient({}));
  formImage = recipe?.image || "";
  pendingImageFile = null;
  document.querySelector("#formTitle").textContent = recipe ? "Rezept bearbeiten" : "Neues Rezept";
  document.querySelector("#recipeId").value = recipe?.id || "";
  document.querySelector("#titleInput").value = recipe?.title || "";
  document.querySelector("#categoryInput").value = recipe?.category || "Vorspeise";
  document.querySelector("#servingsInput").value = recipe?.servings ?? (recipe ? "" : 4);
  document.querySelector("#linksInput").value = recipe?.links?.join("\n") || "";
  setNutritionValues(recipe?.nutrition || {});
  setNutritionBasisForm(recipe?.nutritionBasis || { unit: "grams", amount: 100 });
  for (const field of ["prepMinutes", "cookMinutes", "restMinutes", "finishedWeightGrams"]) {
    document.querySelector(`#${field}Input`).value = recipe?.[field] ?? "";
  }
  document.querySelector("#difficultyInput").value = recipe?.difficulty || "";
  formTags = normalizeTags(recipe?.tags);
  renderFormTags();
  const review = needsNutritionReview(recipe);
  document.querySelector("#nutritionReviewNotice").hidden = !review;
  document.querySelector("#nutritionConfirmedInput").checked = recipe?.nutritionVerified === true;
  renderComponentRows();
  renderIngredientRows();
  updateImagePreview();
  recipeModal.showModal();
  RecipeDrafts.begin();
  setTimeout(() => document.querySelector("#titleInput").focus(), 50);
}

function closeForm() { return RecipeDrafts.requestClose(); }

function finishCloseForm() {
  clearPreviewObjectUrl();
  editingRecipeVersion = null;
  recipeModal.close();
}

function copyTitleForRecipe(recipe) {
  const baseTitle = String(recipe.title || "Rezept").replace(/ \(Kopie(?: \d+)?\)$/i, "");
  let title = `${baseTitle} (Kopie)`;
  let copyNumber = 2;
  const existingTitles = new Set(recipes.map(item => String(item.title).toLocaleLowerCase("de")));
  while (existingTitles.has(title.toLocaleLowerCase("de"))) {
    title = `${baseTitle} (Kopie ${copyNumber})`;
    copyNumber += 1;
  }
  return title;
}

function createIndependentRecipeCopy(recipe) {
  const copy = typeof structuredClone === "function"
    ? structuredClone(recipe)
    : JSON.parse(JSON.stringify(recipe));
  const sourceComponents = copy.components?.length
    ? copy.components
    : [normalizeComponent({ name: "Allgemein", instructions: copy.instructions || "" })];
  const componentIds = new Map();
  copy.components = sourceComponents.map(component => {
    const newId = newComponentId();
    componentIds.set(component.id, newId);
    return { ...component, id: newId };
  });
  copy.ingredients = (copy.ingredients || []).map(ingredient => {
    const normalized = normalizeIngredient(ingredient);
    return {
      ...normalized,
      id: newIngredientId(),
      componentId: componentIds.get(normalized.componentId) || copy.components[0].id,
      checked: false
    };
  });
  copy.id = crypto.randomUUID ? crypto.randomUUID() : `recipe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  copy.title = copyTitleForRecipe(recipe);
  copy.favorite = false;
  return copy;
}

async function duplicateRecipe(recipe, button) {
  if (!ensureCanEdit()) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    const copy = createIndependentRecipeCopy(recipe);
    await saveRecipeToCloud(copy, { isNew: true });
    recipes = [copy, ...recipes];
    render();
    detailModal.close();
    openForm(copy, recipeVersions.get(copy.id) || null);
    alert(`„${copy.title}“ wurde als eigenständiges Rezept angelegt. Du kannst die Variante jetzt bearbeiten.`);
  } catch (error) {
    alert(error.message || "Das Rezept konnte nicht kopiert werden.");
    button.disabled = false;
    button.textContent = originalText;
  }
}

function openDetail(id) {
  const recipe = recipes.find(item => item.id === id);
  if (!recipe) return;
  let detailRecipeVersion = recipeVersions.get(id) || null;
  const imageUrl = validUrl(recipe.image);
  const links = (recipe.links || []).map(validUrl).filter(Boolean);
  const nutrition = recipe.nutrition || {};
  const nutritionBasis = nutritionBasisLabel(recipe.nutritionBasis);
  const baseServings = Number(recipe.servings) > 0 ? Number(recipe.servings) : null;
  const components = recipe.components?.length ? recipe.components : [normalizeComponent({ name: "Allgemein", instructions: recipe.instructions || "" })];
  const nutritionRows = Object.entries(nutritionLabels)
    .map(([key, [label, unit]]) => {
      const hasValue = nutrition[key] !== null && nutrition[key] !== "" && nutrition[key] !== undefined;
      return `<tr><th>${escapeHtml(label)}</th><td>${hasValue ? `${escapeHtml(String(nutrition[key]))} ${unit}` : "–"}</td></tr>`;
    })
    .join("");
  const partsHtml = components.map(component => {
    const componentIngredients = recipe.ingredients
      .map((item, index) => ({ ingredient: normalizeIngredient(item), index }))
      .filter(({ ingredient }) => ingredient.componentId === component.id);
    const ingredientList = componentIngredients.length
      ? componentIngredients.map(({ ingredient, index }) => `<li class="scaled-ingredient-label" data-index="${index}">${escapeHtml(ingredientLabel(ingredient))}</li>`).join("")
      : '<p class="empty-detail-info">Für diesen Teil wurden noch keine Zutaten zugeordnet.</p>';
    return `<section class="recipe-part-detail"><h3 class="recipe-part-title">${escapeHtml(component.name)}</h3><div><h3>Zutaten</h3><ul class="ingredient-list">${ingredientList}</ul></div><div><h3>Zubereitung</h3><p class="instructions">${escapeHtml(component.instructions)}</p></div></section>`;
  }).join("");
  const detail = document.querySelector("#recipeDetail");
  detail.dataset.recipeId = recipe.id;
  detail.innerHTML = `
    <div class="detail-hero">
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(recipe.title)}">` : ""}
      <button class="icon-button detail-close" type="button" aria-label="Fenster schließen">×</button>
    </div>
    <div class="detail-content">
      <p class="eyebrow">${escapeHtml(recipe.category)}</p>
      <div class="detail-title-row">
        <h2>${escapeHtml(recipe.title)}</h2>
        <div class="detail-actions">
          <button class="favorite-button" type="button" data-action="favorite"></button>
          <button type="button" data-action="copy" title="Als neues Rezept kopieren" aria-label="Rezept kopieren">⧉</button>
          <button type="button" data-action="edit" title="Bearbeiten" aria-label="Rezept bearbeiten">✎</button>
          <button type="button" data-action="delete" title="Löschen" aria-label="Rezept löschen">⌫</button>
        </div>
      </div>
      ${baseServings ? `<div class="servings-calculator"><label for="detailServingsInput">Portionen</label><input id="detailServingsInput" type="number" min="0" step="any" value="${escapeHtml(String(baseServings))}"><span>Grundrezept für ${escapeHtml(formatIngredientAmount(baseServings))} Portionen</span></div>` : '<p class="servings-missing">Für dieses Rezept ist noch keine Grund-Portionszahl hinterlegt. Du kannst sie über „Bearbeiten“ ergänzen.</p>'}
      ${recipeInformationHtml(recipe)}
      <div class="tag-chips">${normalizeTags(recipe.tags).map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="recipe-parts-detail">${partsHtml}</div>
      <section class="detail-links"><h3>Nährwertangaben</h3><table class="nutrition-table"><caption>Angaben für ${escapeHtml(nutritionBasis)} · feste Bezugswerte</caption><tbody>${nutritionRows}</tbody></table>${needsNutritionReview(recipe) ? '<p class="review-notice">Bitte prüfen: Herkunft der bisherigen Nährwerte nicht bestätigt. Im Rezeptformular manuell bestätigen.</p>' : ""}${!hasNutritionValues(nutrition) ? '<p class="empty-detail-info">Keine Nährwerte eingetragen.</p>' : ""}</section>
      <section class="detail-links"><h3>Links</h3>${links.length ? `<div class="link-list">${links.map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${url.includes("instagram.com") ? "Instagram" : `Webseite ${index + 1}`} ↗</a>`).join("")}</div>` : '<p class="empty-detail-info">Für dieses Rezept wurden noch keine Links hinterlegt.</p>'}</section>
    </div>`;
  configureFavoriteButton(detail.querySelector('[data-action="favorite"]'), recipe);
  detail.querySelector(".detail-close").addEventListener("click", () => detailModal.close());
  detail.querySelector('[data-action="copy"]').addEventListener("click", event => duplicateRecipe(recipe, event.currentTarget));
  detail.querySelector('[data-action="edit"]').addEventListener("click", () => { detailModal.close(); openForm(recipe, detailRecipeVersion); });
  detail.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRecipe(recipe, detailRecipeVersion));
  const servingsInput = detail.querySelector("#detailServingsInput");
  if (servingsInput) servingsInput.addEventListener("input", event => {
    const selectedServings = Number(event.target.value);
    if (!(selectedServings > 0)) return;
    const factor = selectedServings / baseServings;
    detail.querySelectorAll(".scaled-ingredient-label").forEach(label => {
      const ingredient = recipe.ingredients[Number(label.dataset.index)];
      label.textContent = ingredientLabel(ingredient, factor);
    });
  });
  if (!detailModal.open) detailModal.showModal();
}

async function deleteRecipe(recipe, expectedVersion = null) {
  if (!ensureCanEdit()) return;
  if (!confirm(`„${recipe.title}“ wirklich löschen?`)) return;
  try {
    if (expectedVersion) recipeVersions.set(recipe.id, expectedVersion);
    await deleteRecipeFromCloud(recipe);
    recipes = recipes.filter(item => item.id !== recipe.id);
    detailModal.close();
    render();
  } catch (error) {
    alert(error.message);
    if (error.message.includes("inzwischen")) await refreshRecipesFromCloud();
  }
}

recipeForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!ensureCanEdit() || editorSaveInProgress) return;
  editorSaveInProgress = true;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  const originalButtonText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = "Wird gespeichert …";
  if (!await RecipeDrafts.prepareSave()) {
    editorSaveInProgress = false; submitButton.disabled = false; submitButton.textContent = originalButtonText; return;
  }
  recipeForm.querySelector(".form-grid").inert = true;
  if (document.querySelector("#tagInput").value.trim()) addFormTag();
  let components = formComponents
    .filter(component => component.name.trim() || component.instructions.trim())
    .map((component, index) => ({
      ...component,
      name: component.name.trim() || `Rezeptteil ${index + 1}`,
      instructions: component.instructions.trim()
    }));
  if (!components.length) components = [normalizeComponent({ name: "Allgemein", instructions: "" })];
  const ingredients = formIngredients
    .filter(item => item.name.trim())
    .map(item => ({
      ...item,
      componentId: components.some(component => component.id === item.componentId)
        ? item.componentId
        : components[0].id
    }));
  try {
    await uploadPendingImage();
  } catch (error) {
    alert(error.message);
    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;
    editorSaveInProgress = false; recipeForm.querySelector(".form-grid").inert = false;
    RecipeDrafts.flush().catch(() => {});
    return;
  }
  const id = document.querySelector("#recipeId").value;
  const recipe = {
    ...editingRecipeSnapshot,
    id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    title: document.querySelector("#titleInput").value.trim(),
    category: document.querySelector("#categoryInput").value,
    servings: document.querySelector("#servingsInput").value === ""
      ? null
      : Number(document.querySelector("#servingsInput").value),
    image: formImage,
    ingredients,
    instructions: JSON.stringify(components) === JSON.stringify(editingRecipeSnapshot.components)
      ? editingRecipeSnapshot.instructions
      : components.map(component => `${component.name}:\n${component.instructions}`).join("\n\n"),
    components,
    links: document.querySelector("#linksInput").value.split("\n").map(item => item.trim()).filter(Boolean),
    nutrition: { ...editingRecipeSnapshot.nutrition, ...getNutritionValues() },
    nutritionBasis: getNutritionBasisFromForm(),
    nutritionVerified: document.querySelector("#nutritionConfirmedInput").checked,
    tags: normalizeTags(formTags),
    favorite: editingRecipeSnapshot.favorite === true,
    difficulty: document.querySelector("#difficultyInput").value,
    ...Object.fromEntries(["prepMinutes", "cookMinutes", "restMinutes", "finishedWeightGrams"].map(field => [field, optionalNumber(document.querySelector(`#${field}Input`).value)]))
  };
  try {
    await saveRecipeToCloud(recipe, { expectedVersion: editingRecipeVersion, isNew: !id });
    if (id) recipes = recipes.map(item => item.id === id ? recipe : item);
    else recipes = [recipe, ...recipes];
    document.querySelector("#editorStatus").textContent = "Rezept erfolgreich gespeichert. Zugehöriger lokaler Entwurf wird entfernt.";
    await RecipeDrafts.complete();
    finishCloseForm();
    render();
  } catch (error) {
    alert(error.message);
    await RecipeDrafts.flush().catch(() => {});
    if (error.message.includes("inzwischen")) {
      RecipeDrafts.markConflict(error.message);
      await refreshRecipesFromCloud();
    }
  } finally {
    editorSaveInProgress = false;
    recipeForm.querySelector(".form-grid").inert = false;
    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;
  }
});

document.querySelectorAll("#newRecipeButton, #heroNewRecipeButton, #emptyNewRecipeButton").forEach(button => button.addEventListener("click", () => openForm()));
document.querySelectorAll("#closeModalButton, #cancelButton").forEach(button => button.addEventListener("click", closeForm));
document.querySelector("#addComponentButton").addEventListener("click", addComponent);
document.querySelector("#imageFileInput").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowedTypes.includes(file.type)) {
    alert("Bitte ein JPG-, PNG-, WebP- oder GIF-Bild auswählen.");
    event.target.value = "";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    alert("Das Bild darf höchstens 8 MB groß sein.");
    event.target.value = "";
    return;
  }
  pendingImageFile = file;
  updateImagePreview();
});
document.querySelector("#removeImageButton").addEventListener("click", () => {
  formImage = "";
  pendingImageFile = null;
  document.querySelector("#imageFileInput").value = "";
  updateImagePreview();
});
document.querySelector("#searchInput").addEventListener("input", event => { searchTerm = event.target.value.trim(); render(); });
document.querySelector("#sortSelect").addEventListener("change", event => { sortMode = event.target.value; render(); });
document.querySelector("#exportPdfButton").addEventListener("click", event => runExport(event.currentTarget, "Wird vorbereitet …", openRecipeBookForPdf));
document.querySelectorAll(".category-tab").forEach(tab => tab.addEventListener("click", () => {
  activeCategory = tab.dataset.category;
  document.querySelectorAll(".category-tab").forEach(item => item.classList.toggle("active", item === tab));
  render();
}));
[recipeModal, detailModal].forEach(modal => modal.addEventListener("click", event => {
  if (event.target === modal) {
    if (modal === recipeModal) closeForm();
    else modal.close();
  }
}));

async function initialize() {
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    try {
      const response = await fetch("/api/recipes", { cache: "no-store" });
      if (!response.ok && response.status !== 404) {
        recipes = []; setStorageStatus("error", "Lokale Rezeptdatei nicht lesbar. Keine Daten überschrieben; bitte Datei prüfen."); render(); return;
      }
      const localRecipes = response.ok ? await response.json() : null;
      if (Array.isArray(localRecipes)) {
        supabaseClient = null;
        recipes = localRecipes;
        localRecipeEtag = response.headers.get("ETag");
        setStorageStatus("file", "Sicher im Programmordner gespeichert");
        normalizeAllRecipes();
        render();
        return;
      }
    } catch { /* Statische Vorschau verwendet den bisherigen Cloud-Speicher. */ }
  }
  await loadRecipes();
  normalizeAllRecipes();
  render();
  startAutomaticCloudRefresh();
}

initialize();
