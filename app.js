const STORAGE_KEY = "kuechenbuch-recipes-v1";
const SUPABASE_URL = "https://ohdamaixedupjivfobsv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_65F5g7J7EJ0LzAqxchLKCA_6j9K31yM";
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let recipes = [];
let storageMode = "checking";
let currentUser = null;
let recipeVersions = new Map();
let editingRecipeVersion = null;
let cloudWriteInProgress = 0;
let cloudRefreshStarted = false;
let activeCategory = "Alle";
let searchTerm = "";
let sortMode = "title_asc";
let formProducts = [];
let formIngredients = [];
let formCalculation = null;
let formComponents = [];
let scannerStream = null;
let scannerAnimationFrame = null;
let lastScanAttempt = 0;
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
    return saved ? JSON.parse(saved) : [];
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

function updateAuthInterface() {
  const authButton = document.querySelector("#authButton");
  const authUser = document.querySelector("#authUser");
  authButton.textContent = currentUser ? "Abmelden" : "Anmelden";
  authUser.textContent = currentUser?.email || "Nicht angemeldet";
}

function openAuth() {
  document.querySelector("#authError").textContent = "";
  const modal = document.querySelector("#authModal");
  if (!modal.open) modal.showModal();
  setTimeout(() => document.querySelector("#authEmail").focus(), 50);
}

function closeAuth() {
  document.querySelector("#authModal").close();
}

function ensureCanEdit() {
  if (currentUser) return true;
  openAuth();
  return false;
}

async function requireAuthenticatedCloudUser() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.getUser();
  if (error || !data.user) {
    currentUser = null;
    updateAuthInterface();
    openAuth();
    throw new Error("Deine Anmeldung ist nicht mehr gültig. Bitte erneut anmelden und das Rezept danach noch einmal speichern.");
  }
  currentUser = data.user;
  updateAuthInterface();
  return data.user;
}

async function loadPublishedRecipes() {
  const response = await fetch("data/recipes.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Veröffentlichte Sammlung nicht gefunden");
  return response.json();
}

async function loadRecipes() {
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from("recipes")
        .select("id, data, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      if (data.length) {
        applyCloudRows(data);
        setStorageStatus("cloud", currentUser
          ? "Zentral in Supabase gespeichert"
          : "Zentrale Sammlung · zum Bearbeiten anmelden");
        return;
      }

      recipes = await loadPublishedRecipes();
      if (currentUser && recipes.length) {
        await importRecipesToCloud(recipes);
        await refreshRecipesFromCloud({ updateStatus: false });
        setStorageStatus("cloud", "Bestehende Sammlung nach Supabase importiert");
      } else {
        setStorageStatus("published", "Veröffentlichte Sammlung · zum Importieren anmelden");
      }
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

async function importRecipesToCloud(items) {
  if (supabaseClient && currentUser) {
    const authenticatedUser = await requireAuthenticatedCloudUser();
    const timestamp = new Date().toISOString();
    const rows = items.map(recipe => ({
      id: recipe.id,
      data: recipe,
      updated_at: timestamp,
      updated_by: authenticatedUser.id
    }));
    if (rows.length) {
      const { error } = await supabaseClient.from("recipes").upsert(rows, { onConflict: "id" });
      if (error) throw new Error(`Cloud-Speichern fehlgeschlagen: ${error.message}`);
    }
    localStorage.removeItem(STORAGE_KEY);
    setStorageStatus("cloud", "Zentral in Supabase gespeichert");
    return true;
  }

  return saveRecipesToLocalServer();
}

async function saveRecipeToCloud(recipe, { expectedVersion = null, isNew = false } = {}) {
  if (supabaseClient && currentUser) {
    const authenticatedUser = await requireAuthenticatedCloudUser();
    cloudWriteInProgress += 1;
    try {
      const timestamp = new Date().toISOString();
      const row = {
        id: recipe.id,
        data: recipe,
        updated_at: timestamp,
        updated_by: authenticatedUser.id
      };
      let result;
      if (isNew) {
        result = await supabaseClient.from("recipes").insert(row).select("updated_at");
      } else {
        let query = supabaseClient.from("recipes").update(row).eq("id", recipe.id);
        if (expectedVersion) query = query.eq("updated_at", expectedVersion);
        result = await query.select("updated_at");
      }
      if (result.error) throw new Error(`Cloud-Speichern fehlgeschlagen: ${result.error.message}`);
      if (!result.data?.length) {
        throw new Error("Dieses Rezept wurde inzwischen auf einem anderen Gerät verändert. Die neue Version wurde geladen; bitte deine Änderung erneut eingeben.");
      }
      recipeVersions.set(recipe.id, result.data[0].updated_at);
      localStorage.removeItem(STORAGE_KEY);
      setStorageStatus("cloud", "Speichern in Supabase bestätigt");
      return true;
    } finally {
      cloudWriteInProgress -= 1;
    }
  }

  if (supabaseClient && !currentUser) {
    openAuth();
    throw new Error("Bitte zuerst anmelden. Das Rezept wurde noch nicht gespeichert.");
  }

  return saveRecipesToLocalServer();
}

async function deleteRecipeFromCloud(recipe) {
  if (supabaseClient && currentUser) {
    await requireAuthenticatedCloudUser();
    cloudWriteInProgress += 1;
    try {
      let query = supabaseClient.from("recipes").delete().eq("id", recipe.id);
      const expectedVersion = recipeVersions.get(recipe.id);
      if (expectedVersion) query = query.eq("updated_at", expectedVersion);
      const { data, error } = await query.select("id");
      if (error) throw new Error(`Cloud-Löschen fehlgeschlagen: ${error.message}`);
      if (!data?.length) {
        throw new Error("Dieses Rezept wurde inzwischen auf einem anderen Gerät verändert und deshalb nicht gelöscht. Bitte die Seite neu laden.");
      }
      recipeVersions.delete(recipe.id);
      setStorageStatus("cloud", "Rezept zentral gelöscht");
      return true;
    } finally {
      cloudWriteInProgress -= 1;
    }
  }
  return saveRecipesToLocalServer();
}

async function saveRecipesToLocalServer() {
  try {
    const response = await fetch("/api/recipes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recipes)
    });
    if (!response.ok) throw new Error("Speichern fehlgeschlagen");
    localStorage.removeItem(STORAGE_KEY);
    setStorageStatus("file", "Sicher im Programmordner gespeichert");
    return true;
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
    setStorageStatus("browser", "Nur im Browser gespeichert – bitte server.py starten");
    alert("Der Programmordner ist gerade nicht erreichbar. Das Rezept wurde vorsichtshalber nur im Browser gespeichert. Starte die Website mit server.py, damit es in data/recipes.json geschrieben wird.");
    return false;
  }
}

async function refreshRecipesFromCloud({ updateStatus = true } = {}) {
  if (!supabaseClient || cloudWriteInProgress) return false;
  const { data, error } = await supabaseClient
    .from("recipes")
    .select("id, data, updated_at")
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("Cloud-Aktualisierung fehlgeschlagen:", error);
    return false;
  }
  applyCloudRows(data);
  normalizeAllRecipes();
  render();
  if (updateStatus) {
    setStorageStatus("cloud", currentUser
      ? "Zentral synchronisiert"
      : "Zentrale Sammlung · zum Bearbeiten anmelden");
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
  if (supabaseClient) {
    if (!currentUser) throw new Error("Bitte zuerst anmelden, um Bilder hochzuladen.");
    const extensionMap = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const extension = extensionMap[pendingImageFile.type];
    const uniqueId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const filename = `${currentUser.id}/recipe-${uniqueId}.${extension}`;
    const { error } = await supabaseClient.storage
      .from("recipe-images")
      .upload(filename, pendingImageFile, { contentType: pendingImageFile.type, upsert: false });
    if (error) throw new Error(`Bild konnte nicht hochgeladen werden: ${error.message}`);
    const { data } = supabaseClient.storage.from("recipe-images").getPublicUrl(filename);
    formImage = data.publicUrl;
    pendingImageFile = null;
    clearPreviewObjectUrl();
    return formImage;
  }
  const response = await fetch("/api/image", {
    method: "POST",
    headers: { "Content-Type": pendingImageFile.type || "application/octet-stream" },
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
  return normalizeNutritionBasis({
    unit: document.querySelector("#nutritionBasisUnitInput").value,
    amount: document.querySelector("#nutritionBasisAmountInput").value
  });
}

function setNutritionBasisForm(value = {}) {
  const basis = normalizeNutritionBasis(value);
  document.querySelector("#nutritionBasisUnitInput").value = basis.unit;
  document.querySelector("#nutritionBasisAmountInput").value = basis.amount;
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
    id: value.id || newComponentId(),
    name: value.name || "Rezeptteil",
    instructions: value.instructions || ""
  };
}

function normalizeIngredient(value) {
  if (value && typeof value === "object") {
    return {
      id: value.id || newIngredientId(),
      name: value.name || "",
      amount: value.amount ?? "",
      unit: ingredientUnits.includes(value.unit) ? value.unit : "g",
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

function ingredientWeight(ingredient) {
  const explicitWeight = Number(ingredient.weightGrams);
  if (explicitWeight > 0) return explicitWeight;
  const amount = Number(ingredient.amount);
  if (!(amount > 0)) return null;
  if (ingredient.unit === "g") return amount;
  if (ingredient.unit === "kg") return amount * 1000;
  if (ingredient.unit === "ml") return amount;
  if (ingredient.unit === "l") return amount * 1000;
  return null;
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

function downloadJsonBackup() {
  const exportedAt = new Date();
  const backup = {
    format: "kuechenbuch-backup",
    version: 1,
    exportedAt: exportedAt.toISOString(),
    recipeCount: recipes.length,
    recipes: sortedRecipesForExport()
  };
  const date = exportedAt.toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kuechenbuch-sicherung-${date}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      ${parts}
      ${nutritionRows ? `<section class="extra"><h3>Nährwertangaben</h3><p class="caption">Angaben für ${escapeHtml(nutritionBasis)}</p><table><tbody>${nutritionRows}</tbody></table></section>` : ""}
      ${links.length ? `<section class="extra"><h3>Links</h3><ul class="links">${links.map(url => `<li>${escapeHtml(url)}</li>`).join("")}</ul></section>` : ""}
    </article>`;
  }).join("");

  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Küchenbuch</title><style>
    :root{color:#243229;background:#fffdf8;font-family:Arial,sans-serif}*{box-sizing:border-box}body{margin:0;background:#ece9e0}.toolbar{position:sticky;z-index:10;top:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;color:white;background:#243229}.toolbar p{margin:0;font-size:13px}.toolbar button{padding:10px 17px;border:0;border-radius:999px;color:#243229;background:#fffdf8;cursor:pointer;font-weight:700}.book{width:210mm;margin:18px auto;background:#fffdf8;box-shadow:0 8px 30px #0002}.cover,.contents,.recipe{padding:18mm 16mm}.cover{display:flex;min-height:270mm;flex-direction:column;justify-content:center;text-align:center}.mark{display:grid;width:25mm;height:25mm;margin:0 auto 15mm;place-items:center;border:1px solid #243229;border-radius:50%;font:42px Georgia,serif}.eyebrow,.category,.recipe-number{font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#526b54}.cover h1{margin:0;font:70px/1 Georgia,serif}.cover .subtitle{margin:8mm auto 0;max-width:120mm;color:#667068;font-size:17px}.cover .date{margin-top:25mm;color:#667068;font-size:12px}.contents{min-height:270mm}.contents h2,.recipe h2{margin:0 0 10mm;font:44px/1.05 Georgia,serif}.contents ol{margin:0;padding:0;list-style:none}.contents li{display:flex;justify-content:space-between;gap:15mm;padding:3mm 0;border-bottom:1px solid #dedbd2;font-size:13px}.contents li span:last-child{color:#667068}.recipe{position:relative;min-height:270mm;break-before:page}.recipe-number{position:absolute;right:16mm;top:18mm;color:#778078}.recipe-image{display:block;width:100%;height:65mm;margin-bottom:9mm;object-fit:cover}.category{margin:0 0 3mm}.recipe h2{margin-bottom:3mm}.servings{margin:0 0 10mm;color:#667068;font-size:12px}.part{margin-top:9mm;padding-top:7mm;border-top:1px solid #d8d5cc}.part h3,.extra h3{margin:0 0 5mm;font:26px Georgia,serif;color:#526b54}.part-columns{display:grid;grid-template-columns:42% 1fr;gap:12mm}.part h4{margin:0 0 3mm;font-size:11px;letter-spacing:.1em;text-transform:uppercase}.ingredients{margin:0;padding:0;list-style:none}.ingredients li{padding:2.2mm 0;border-bottom:1px solid #ebe8df;font-size:12px}.instructions{margin:0;white-space:pre-wrap;font-size:12px;line-height:1.6}.muted,.caption{color:#777f78}.extra{margin-top:9mm;padding-top:7mm;border-top:1px solid #d8d5cc;break-inside:avoid}.caption{margin:-3mm 0 3mm;font-size:10px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:2mm 0;border-bottom:1px solid #ebe8df;text-align:left}td{text-align:right}.links{margin:0;padding-left:5mm;font-size:10px;line-height:1.5;overflow-wrap:anywhere}@page{size:A4;margin:0}@media print{body{background:white}.toolbar{display:none}.book{width:auto;margin:0;box-shadow:none}.cover,.contents,.recipe{min-height:297mm}.part,.part-columns,.ingredients li{break-inside:avoid}}
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
    group.innerHTML = `<div class="ingredient-group-heading"><h4>${escapeHtml(component.name)}</h4><button class="secondary-button compact-button" type="button">＋ Zutat für ${escapeHtml(component.name)}</button></div><div class="ingredient-group-rows"><p class="ingredient-group-empty">Noch keine Zutaten in diesem Rezeptteil.</p></div>`;
    group.querySelector("button").addEventListener("click", () => addIngredient({ componentId: component.id }));
    const rows = group.querySelector(".ingredient-group-rows");
    groupContainers.set(component.id, rows);
    container.append(group);
  });
  formIngredients.forEach((ingredient, index) => {
    const row = document.createElement("article");
    row.className = `ingredient-row${ingredient.checked ? " checked" : ""}`;
    const unitOptions = ingredientUnits.map(unit => `<option value="${unit}"${unit === ingredient.unit ? " selected" : ""}>${unit}</option>`).join("");
    const componentOptions = formComponents.map(component => `<option value="${escapeHtml(component.id)}"${component.id === ingredient.componentId ? " selected" : ""}>${escapeHtml(component.name)}</option>`).join("");
    const sourceText = ingredient.nutritionPer100g
      ? `${ingredient.nutritionSource || "Nährwerte vorhanden"}${ingredient.nutritionMatches?.length ? ` · Basis: ${ingredient.nutritionMatches.slice(0, 2).join(", ")}` : ""}`
      : "Noch keine Nährwerte zugeordnet";
    row.innerHTML = `
      <label class="ingredient-check-wrap"><span class="sr-only">Auf Einkaufsliste abhaken</span><input class="ingredient-check" type="checkbox" ${ingredient.checked ? "checked" : ""}></label>
      <label>Menge<input class="ingredient-amount-input" type="number" min="0" step="0.01" value="${escapeHtml(String(ingredient.amount ?? ""))}" placeholder="100"></label>
      <label>Einheit<select class="ingredient-unit-input">${unitOptions}</select></label>
      <label class="ingredient-name-field">Zutat<input class="ingredient-name-input" type="text" value="${escapeHtml(ingredient.name)}" placeholder="z. B. Mehl (optional)"></label>
      <label class="ingredient-weight-field">Gewicht g<input class="ingredient-weight-input" type="number" min="0" step="0.1" value="${escapeHtml(String(ingredient.weightGrams ?? ""))}" placeholder="auto"></label>
      <button class="ingredient-row-remove" type="button" aria-label="Zutat entfernen">×</button>
      <label class="ingredient-component-field">Gehört zu<select class="ingredient-component-input">${componentOptions}</select></label>
      <div class="ingredient-lookup"><p class="ingredient-lookup-status ${ingredient.nutritionPer100g ? "success" : ""}">${escapeHtml(sourceText)}</p><button class="ingredient-lookup-button" type="button">Nährwerte suchen</button></div>`;

    const update = (key, value) => { ingredient[key] = value; };
    row.querySelector(".ingredient-check").addEventListener("change", event => { update("checked", event.target.checked); row.classList.toggle("checked", event.target.checked); });
    row.querySelector(".ingredient-amount-input").addEventListener("input", event => update("amount", event.target.value === "" ? "" : Number(event.target.value)));
    row.querySelector(".ingredient-unit-input").addEventListener("change", event => update("unit", event.target.value));
    row.querySelector(".ingredient-name-input").addEventListener("input", event => {
      update("name", event.target.value);
      ingredient.nutritionPer100g = null;
      ingredient.nutritionSource = "";
      row.querySelector(".ingredient-lookup-status").textContent = "Zutat geändert – Nährwerte neu suchen";
      row.querySelector(".ingredient-lookup-status").className = "ingredient-lookup-status";
    });
    row.querySelector(".ingredient-weight-input").addEventListener("input", event => update("weightGrams", event.target.value === "" ? "" : Number(event.target.value)));
    row.querySelector(".ingredient-component-input").addEventListener("change", event => {
      update("componentId", event.target.value);
      renderIngredientRows();
    });
    row.querySelector(".ingredient-row-remove").addEventListener("click", () => { formIngredients.splice(index, 1); renderIngredientRows(); });
    row.querySelector(".ingredient-lookup-button").addEventListener("click", event => lookupIngredientNutrition(ingredient, event.target, row.querySelector(".ingredient-lookup-status")));
    const target = groupContainers.get(ingredient.componentId) || groupContainers.values().next().value;
    if (target) {
      target.querySelector(".ingredient-group-empty")?.remove();
      target.append(row);
    }
  });
}

async function lookupIngredientNutrition(ingredient, button = null, statusElement = null) {
  if (!ingredient.name.trim()) throw new Error("Bitte zuerst eine Zutat eingeben.");
  if (button) button.disabled = true;
  if (statusElement) { statusElement.textContent = "Durchschnittswerte werden gesucht …"; statusElement.className = "ingredient-lookup-status"; }
  try {
    const response = await fetch(`/api/ingredient?query=${encodeURIComponent(ingredient.name.trim())}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Keine Nährwerte gefunden.");
    ingredient.nutritionPer100g = result.nutrition;
    ingredient.nutritionSource = `${result.source} (${result.sampleCount} Treffer)`;
    ingredient.nutritionMatches = result.matches || [];
    if (statusElement) { statusElement.textContent = ingredient.nutritionSource; statusElement.className = "ingredient-lookup-status success"; }
    return true;
  } catch (error) {
    if (statusElement) { statusElement.textContent = error.message; statusElement.className = "ingredient-lookup-status error"; }
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

async function calculateRecipeNutrition() {
  const button = document.querySelector("#calculateNutritionButton");
  const summary = document.querySelector("#calculationSummary");
  const usableIngredients = formIngredients.filter(item => item.name.trim());
  if (!usableIngredients.length) {
    summary.textContent = "Bitte zuerst mindestens eine Zutat anlegen.";
    return;
  }
  const missingWeights = usableIngredients.filter(item => !ingredientWeight(item));
  if (missingWeights.length) {
    summary.textContent = `Gewicht fehlt bei: ${missingWeights.map(item => item.name).join(", ")}. Bei Stück/EL/TL bitte das Gewicht in Gramm ergänzen.`;
    return;
  }
  const nutritionBasis = getNutritionBasisFromForm();
  const baseServings = Number(document.querySelector("#servingsInput").value);
  if (nutritionBasis.unit === "servings" && !(baseServings > 0)) {
    summary.textContent = "Für die Berechnung pro Portion bitte oben die Grundportionen des Rezepts eintragen.";
    return;
  }
  button.disabled = true;
  const missingNutrition = usableIngredients.filter(item => !item.nutritionPer100g);
  if (missingNutrition.length > 10) {
    summary.textContent = "Bitte zuerst bei einigen Zutaten einzeln auf „Nährwerte suchen“ klicken. Pro Minute sind höchstens zehn neue Internetsuchen möglich.";
    button.disabled = false;
    return;
  }
  const failed = [];
  for (let index = 0; index < missingNutrition.length; index += 1) {
    const ingredient = missingNutrition[index];
    summary.textContent = `Suche Nährwerte ${index + 1}/${missingNutrition.length}: ${ingredient.name} …`;
    try { await lookupIngredientNutrition(ingredient); }
    catch { failed.push(ingredient.name); }
  }
  renderIngredientRows();
  if (failed.length) {
    summary.textContent = `Keine Berechnung möglich. Es fehlen Nährwerte für: ${failed.join(", ")}. Bitte Bezeichnung präzisieren oder Werte über einen Barcode übernehmen.`;
    button.disabled = false;
    return;
  }

  const totalWeight = usableIngredients.reduce((sum, item) => sum + ingredientWeight(item), 0);
  const basisFactor = nutritionBasis.unit === "servings"
    ? nutritionBasis.amount / baseServings
    : nutritionBasis.amount / totalWeight;
  const calculated = {};
  Object.keys(nutritionFields).forEach(key => {
    const contributions = usableIngredients
      .filter(item => item.nutritionPer100g?.[key] !== null && item.nutritionPer100g?.[key] !== undefined)
      .map(item => Number(item.nutritionPer100g[key]) * ingredientWeight(item) / 100);
    calculated[key] = contributions.length ? Math.round((contributions.reduce((sum, value) => sum + value, 0) * basisFactor) * 100) / 100 : null;
  });
  setNutritionValues(calculated);
  formCalculation = {
    totalWeightGrams: Math.round(totalWeight * 10) / 10,
    ingredientCount: usableIngredients.length,
    calculatedAt: new Date().toISOString(),
    source: "Open Food Facts – gemittelte Produktwerte"
  };
  summary.textContent = `Werte für ${nutritionBasisLabel(nutritionBasis)} berechnet, aus ${usableIngredients.length} Zutaten und ${Math.round(totalWeight)} g Gesamtgewicht. Flüssigkeiten wurden näherungsweise mit 1 g/ml angesetzt.`;
  button.disabled = false;
}

function renderScannedProducts() {
  const container = document.querySelector("#scannedProducts");
  container.replaceChildren();
  formProducts.forEach((product, index) => {
    const item = document.createElement("article");
    item.className = "product-item";
    const imageUrl = validUrl(product.image);
    item.innerHTML = `
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : '<span class="product-placeholder">▦</span>'}
      <div><strong>${escapeHtml(product.name)}</strong><p>${escapeHtml(product.brand || `EAN ${product.barcode}`)}</p>${product.ingredientText ? `<p>Zutaten: ${escapeHtml(product.ingredientText)}</p>` : ""}</div>
      <button class="product-remove" type="button" aria-label="Produkt entfernen">×</button>`;
    item.querySelector(".product-remove").addEventListener("click", () => {
      formProducts.splice(index, 1);
      renderScannedProducts();
    });
    container.append(item);
  });
}

function setBarcodeStatus(message, isError = false) {
  const status = document.querySelector("#barcodeStatus");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function lookupBarcode() {
  const input = document.querySelector("#barcodeInput");
  const barcode = input.value.replace(/\D/g, "");
  input.value = barcode;
  if (!/^\d{8,14}$/.test(barcode)) {
    setBarcodeStatus("Bitte einen Barcode mit 8 bis 14 Ziffern eingeben.", true);
    return;
  }
  if (formProducts.some(product => product.barcode === barcode)) {
    setBarcodeStatus("Dieses Produkt wurde bereits hinzugefügt.", true);
    return;
  }

  const button = document.querySelector("#lookupBarcodeButton");
  button.disabled = true;
  setBarcodeStatus("Produktdaten werden geladen …");
  try {
    const response = await fetch(`/api/product?barcode=${encodeURIComponent(barcode)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Produkt wurde nicht gefunden.");
    formProducts.push(result);
    renderScannedProducts();
    addIngredient({
      name: result.name,
      amount: 100,
      unit: "g",
      nutritionPer100g: result.nutrition,
      nutritionSource: `Barcode ${result.barcode} · Open Food Facts`,
      nutritionMatches: [result.name],
      productBarcode: result.barcode
    });
    setBarcodeStatus(`${result.name} wurde als 100-g-Zutatenposition hinzugefügt. Passe die verwendete Menge bei Bedarf an.`);
    input.value = "";
  } catch (error) {
    setBarcodeStatus(error.message || "Produktdaten konnten nicht geladen werden.", true);
  } finally {
    button.disabled = false;
  }
}

function stopBarcodeScanner() {
  if (scannerAnimationFrame) cancelAnimationFrame(scannerAnimationFrame);
  scannerAnimationFrame = null;
  if (scannerStream) scannerStream.getTracks().forEach(track => track.stop());
  scannerStream = null;
  const view = document.querySelector("#scannerView");
  const video = document.querySelector("#scannerVideo");
  video.srcObject = null;
  view.hidden = true;
}

async function startBarcodeScanner() {
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    setBarcodeStatus("Die Kamera-Barcoderkennung wird von diesem Browser nicht unterstützt. Bitte Chrome verwenden oder die EAN manuell eingeben.", true);
    return;
  }
  try {
    const supportedFormats = await BarcodeDetector.getSupportedFormats();
    const formats = ["ean_13", "ean_8", "upc_a", "upc_e"].filter(format => supportedFormats.includes(format));
    if (!formats.length) throw new Error("EAN-Barcodes werden von diesem Browser nicht unterstützt.");
    const detector = new BarcodeDetector({ formats });
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const view = document.querySelector("#scannerView");
    const video = document.querySelector("#scannerVideo");
    video.srcObject = scannerStream;
    view.hidden = false;
    await video.play();
    setBarcodeStatus("Halte den Barcode ruhig in den markierten Bereich.");

    const scanFrame = async timestamp => {
      if (!scannerStream) return;
      if (timestamp - lastScanAttempt > 350) {
        lastScanAttempt = timestamp;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length) {
            document.querySelector("#barcodeInput").value = barcodes[0].rawValue;
            stopBarcodeScanner();
            await lookupBarcode();
            return;
          }
        } catch { /* Der nächste Kameraframe wird erneut geprüft. */ }
      }
      scannerAnimationFrame = requestAnimationFrame(scanFrame);
    };
    scannerAnimationFrame = requestAnimationFrame(scanFrame);
  } catch (error) {
    stopBarcodeScanner();
    setBarcodeStatus(error.name === "NotAllowedError" ? "Der Kamerazugriff wurde nicht erlaubt." : (error.message || "Kamera konnte nicht gestartet werden."), true);
  }
}

function render() {
  const filtered = recipes.filter(recipe => {
    const categoryMatches = activeCategory === "Alle" || recipe.category === activeCategory;
    const searchable = `${recipe.title} ${(recipe.ingredients || []).map(item => normalizeIngredient(item).name).join(" ")}`.toLowerCase();
    return categoryMatches && searchable.includes(searchTerm.toLowerCase());
  });
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
    card.dataset.id = recipe.id;
    recipeGrid.append(fragment);
  });

  emptyState.hidden = filtered.length > 0;
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
  formProducts = typeof structuredClone === "function" ? structuredClone(recipe?.products || []) : JSON.parse(JSON.stringify(recipe?.products || []));
  formComponents = typeof structuredClone === "function" ? structuredClone(recipe?.components || []) : JSON.parse(JSON.stringify(recipe?.components || []));
  formComponents = formComponents.map(normalizeComponent);
  if (!formComponents.length) formComponents.push(normalizeComponent({ name: "Allgemein", instructions: recipe?.instructions || "" }));
  formIngredients = typeof structuredClone === "function" ? structuredClone(recipe?.ingredients || []) : JSON.parse(JSON.stringify(recipe?.ingredients || []));
  formIngredients = formIngredients.map(normalizeIngredient);
  formIngredients.forEach(ingredient => {
    if (!formComponents.some(component => component.id === ingredient.componentId)) ingredient.componentId = formComponents[0].id;
  });
  if (!formIngredients.length) formIngredients.push(normalizeIngredient({}));
  formCalculation = recipe?.nutritionCalculation || null;
  formImage = recipe?.image || "";
  pendingImageFile = null;
  document.querySelector("#formTitle").textContent = recipe ? "Rezept bearbeiten" : "Neues Rezept";
  document.querySelector("#recipeId").value = recipe?.id || "";
  document.querySelector("#titleInput").value = recipe?.title || "";
  document.querySelector("#categoryInput").value = recipe?.category || "Vorspeise";
  document.querySelector("#servingsInput").value = recipe?.servings ?? (recipe ? "" : 4);
  document.querySelector("#linksInput").value = recipe?.links.join("\n") || "";
  setNutritionValues(recipe?.nutrition || {});
  setNutritionBasisForm(recipe?.nutritionBasis || { unit: "grams", amount: 100 });
  setBarcodeStatus("");
  renderScannedProducts();
  renderComponentRows();
  renderIngredientRows();
  document.querySelector("#calculationSummary").textContent = formCalculation
    ? `Zuletzt berechnet aus ${formCalculation.ingredientCount} Zutaten und ${formCalculation.totalWeightGrams} g Gesamtgewicht.`
    : "Noch nicht berechnet.";
  updateImagePreview();
  recipeModal.showModal();
  setTimeout(() => document.querySelector("#titleInput").focus(), 50);
}

function closeForm() {
  stopBarcodeScanner();
  clearPreviewObjectUrl();
  editingRecipeVersion = null;
  recipeModal.close();
}

function openDetail(id) {
  const recipe = recipes.find(item => item.id === id);
  if (!recipe) return;
  let detailRecipeVersion = recipeVersions.get(id) || null;
  const imageUrl = validUrl(recipe.image);
  const links = (recipe.links || []).map(validUrl).filter(Boolean);
  const nutrition = recipe.nutrition || {};
  const nutritionBasis = nutritionBasisLabel(recipe.nutritionBasis);
  const products = recipe.products || [];
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
    const shoppingList = componentIngredients.length
      ? componentIngredients.map(({ ingredient, index }) => `<label class="shopping-item${ingredient.checked ? " checked" : ""}"><input class="shopping-check" data-index="${index}" type="checkbox" ${ingredient.checked ? "checked" : ""}><span class="scaled-ingredient-label" data-index="${index}">${escapeHtml(ingredientLabel(ingredient))}</span></label>`).join("")
      : '<p class="empty-detail-info">Für diesen Teil wurden noch keine Zutaten zugeordnet.</p>';
    return `<section class="recipe-part-detail"><h3 class="recipe-part-title">${escapeHtml(component.name)}</h3><div><h3>Zutaten &amp; Einkaufsliste</h3><div class="ingredient-list">${shoppingList}</div></div><div><h3>Zubereitung</h3><p class="instructions">${escapeHtml(component.instructions)}</p></div></section>`;
  }).join("");
  const detail = document.querySelector("#recipeDetail");
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
          <button type="button" data-action="edit" title="Bearbeiten" aria-label="Rezept bearbeiten">✎</button>
          <button type="button" data-action="delete" title="Löschen" aria-label="Rezept löschen">⌫</button>
        </div>
      </div>
      ${baseServings ? `<div class="servings-calculator"><label for="detailServingsInput">Portionen</label><input id="detailServingsInput" type="number" min="0.5" max="1000" step="0.5" value="${escapeHtml(String(baseServings))}"><span>Grundrezept für ${escapeHtml(formatIngredientAmount(baseServings))} Portionen</span></div>` : '<p class="servings-missing">Für dieses Rezept ist noch keine Grund-Portionszahl hinterlegt. Du kannst sie über „Bearbeiten“ ergänzen.</p>'}
      <div class="recipe-parts-detail">${partsHtml}</div>
      <section class="detail-links"><h3>Nährwertangaben</h3><table class="nutrition-table"><caption>Angaben für ${escapeHtml(nutritionBasis)}${recipe.nutritionCalculation ? ` · berechnet aus ${recipe.nutritionCalculation.totalWeightGrams} g Zutaten` : ""}</caption><tbody>${nutritionRows}</tbody></table>${hasNutritionValues(nutrition) ? '<p class="nutrition-note">Näherungswerte auf Grundlage der hinterlegten Zutatenmengen.</p>' : '<p class="empty-detail-info">Für dieses Rezept wurden noch keine Nährwerte berechnet.</p>'}</section>
      ${products.length ? `<section class="detail-links"><h3>Gescannte Produkte</h3><div class="product-detail-list">${products.map(product => `<article class="product-detail"><strong>${escapeHtml(product.name)} · EAN ${escapeHtml(product.barcode)}</strong>${product.ingredientText ? `<p><b>Zutaten:</b> ${escapeHtml(product.ingredientText)}</p>` : ""}</article>`).join("")}</div><p class="nutrition-note">Produktdaten: Open Food Facts</p></section>` : ""}
      <section class="detail-links"><h3>Links</h3>${links.length ? `<div class="link-list">${links.map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${url.includes("instagram.com") ? "Instagram" : `Webseite ${index + 1}`} ↗</a>`).join("")}</div>` : '<p class="empty-detail-info">Für dieses Rezept wurden noch keine Links hinterlegt.</p>'}</section>
    </div>`;
  detail.querySelector(".detail-close").addEventListener("click", () => detailModal.close());
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
  detail.querySelectorAll(".shopping-check").forEach(checkbox => checkbox.addEventListener("change", async event => {
    if (!ensureCanEdit()) {
      event.target.checked = !event.target.checked;
      return;
    }
    const ingredient = recipe.ingredients[Number(event.target.dataset.index)];
    const previousChecked = ingredient.checked;
    ingredient.checked = event.target.checked;
    event.target.closest(".shopping-item").classList.toggle("checked", event.target.checked);
    try {
      await saveRecipeToCloud(recipe, { expectedVersion: detailRecipeVersion });
      detailRecipeVersion = recipeVersions.get(recipe.id) || detailRecipeVersion;
    } catch (error) {
      ingredient.checked = previousChecked;
      event.target.checked = previousChecked;
      event.target.closest(".shopping-item").classList.toggle("checked", previousChecked);
      alert(error.message);
      if (error.message.includes("inzwischen")) {
        detailModal.close();
        await refreshRecipesFromCloud();
      }
    }
  }));
  detailModal.showModal();
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
  if (!ensureCanEdit()) return;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  const originalButtonText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = "Wird gespeichert …";
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
    return;
  }
  const id = document.querySelector("#recipeId").value;
  const recipe = {
    id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    title: document.querySelector("#titleInput").value.trim(),
    category: document.querySelector("#categoryInput").value,
    servings: document.querySelector("#servingsInput").value === ""
      ? null
      : Number(document.querySelector("#servingsInput").value),
    image: formImage,
    ingredients,
    instructions: components.map(component => `${component.name}:\n${component.instructions}`).join("\n\n"),
    components,
    links: document.querySelector("#linksInput").value.split("\n").map(item => item.trim()).filter(Boolean),
    products: formProducts,
    nutrition: getNutritionValues(),
    nutritionBasis: getNutritionBasisFromForm(),
    nutritionCalculation: formCalculation
  };
  try {
    await saveRecipeToCloud(recipe, { expectedVersion: editingRecipeVersion, isNew: !id });
    if (id) recipes = recipes.map(item => item.id === id ? recipe : item);
    else recipes = [recipe, ...recipes];
    closeForm();
    render();
  } catch (error) {
    alert(error.message);
    if (error.message.includes("inzwischen")) {
      closeForm();
      await refreshRecipesFromCloud();
    }
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;
  }
});

document.querySelectorAll("#newRecipeButton, #heroNewRecipeButton, #emptyNewRecipeButton").forEach(button => button.addEventListener("click", () => openForm()));
document.querySelectorAll("#closeModalButton, #cancelButton").forEach(button => button.addEventListener("click", closeForm));
document.querySelector("#closeAuthButton").addEventListener("click", closeAuth);
document.querySelector("#authButton").addEventListener("click", async () => {
  if (!currentUser) {
    openAuth();
    return;
  }
  await supabaseClient.auth.signOut();
  currentUser = null;
  updateAuthInterface();
  setStorageStatus("cloud", "Zentrale Sammlung · zum Bearbeiten anmelden");
});
document.querySelector("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorField = document.querySelector("#authError");
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  errorField.textContent = "";
  submitButton.disabled = true;
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: document.querySelector("#authEmail").value.trim(),
    password: document.querySelector("#authPassword").value
  });
  submitButton.disabled = false;
  if (error) {
    errorField.textContent = "Anmeldung fehlgeschlagen. Bitte E-Mail-Adresse und Passwort prüfen.";
    return;
  }
  currentUser = data.user;
  updateAuthInterface();
  closeAuth();
  await loadRecipes();
  normalizeAllRecipes();
  render();
});
document.querySelector("#lookupBarcodeButton").addEventListener("click", lookupBarcode);
document.querySelector("#barcodeInput").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); lookupBarcode(); }
});
document.querySelector("#scanBarcodeButton").addEventListener("click", startBarcodeScanner);
document.querySelector("#stopScannerButton").addEventListener("click", stopBarcodeScanner);
document.querySelector("#addComponentButton").addEventListener("click", addComponent);
document.querySelector("#calculateNutritionButton").addEventListener("click", calculateRecipeNutrition);
document.querySelector("#nutritionBasisUnitInput").addEventListener("change", event => {
  document.querySelector("#nutritionBasisAmountInput").value = event.target.value === "servings" ? 1 : 100;
});
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
document.querySelector("#exportBackupButton").addEventListener("click", event => runExport(event.currentTarget, "Wird gesichert …", async () => {
  await loadLatestRecipesForExport();
  downloadJsonBackup();
}));
document.querySelectorAll(".category-tab").forEach(tab => tab.addEventListener("click", () => {
  activeCategory = tab.dataset.category;
  document.querySelectorAll(".category-tab").forEach(item => item.classList.toggle("active", item === tab));
  render();
}));
[recipeModal, detailModal, document.querySelector("#authModal")].forEach(modal => modal.addEventListener("click", event => {
  if (event.target === modal) {
    if (modal === recipeModal) closeForm();
    else if (modal.id === "authModal") closeAuth();
    else modal.close();
  }
}));

async function initialize() {
  if (supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    currentUser = data.session?.user || null;
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      currentUser = session?.user || null;
      updateAuthInterface();
    });
  }
  updateAuthInterface();
  await loadRecipes();
  normalizeAllRecipes();
  render();
  startAutomaticCloudRefresh();
}

initialize();
