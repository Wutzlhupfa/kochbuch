#!/usr/bin/env python3
"""Lokaler Küchenbuch-Server mit dateibasierter Rezeptspeicherung."""

import argparse
import json
import os
import re
import statistics
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "recipes.json"
NUTRITION_CACHE_FILE = ROOT / "data" / "nutrition-cache.json"
MAX_REQUEST_SIZE = 5 * 1024 * 1024
MAX_IMAGE_SIZE = 8 * 1024 * 1024


class RecipeHandler(SimpleHTTPRequestHandler):
    server_version = "Kuechenbuch/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed_path = urlparse(self.path)
        if parsed_path.path == "/api/recipes":
            try:
                recipes = json.loads(DATA_FILE.read_text(encoding="utf-8"))
                self.send_json(200, recipes)
            except (OSError, json.JSONDecodeError) as error:
                self.send_json(500, {"error": f"Rezeptdatei konnte nicht gelesen werden: {error}"})
            return
        if parsed_path.path == "/api/product":
            barcode = parse_qs(parsed_path.query).get("barcode", [""])[0].strip()
            self.lookup_product(barcode)
            return
        if parsed_path.path == "/api/ingredient":
            query = parse_qs(parsed_path.query).get("query", [""])[0].strip()
            self.lookup_ingredient(query)
            return
        super().do_GET()

    def lookup_ingredient(self, query):
        if len(query) < 2 or len(query) > 80:
            self.send_json(400, {"error": "Bitte eine eindeutige Zutat eingeben."})
            return
        cache_key = re.sub(r"\s+", " ", query.casefold()).strip()
        try:
            cache = json.loads(NUTRITION_CACHE_FILE.read_text(encoding="utf-8")) if NUTRITION_CACHE_FILE.exists() else {}
        except (OSError, json.JSONDecodeError):
            cache = {}
        if cache_key in cache:
            self.send_json(200, cache[cache_key])
            return

        parameters = urlencode({
            "search_terms": query,
            "search_simple": "1",
            "action": "process",
            "json": "1",
            "page_size": "12",
            "fields": "code,product_name,nutriments",
        })
        url = f"https://world.openfoodfacts.org/cgi/search.pl?{parameters}"
        request = Request(url, headers={"User-Agent": "Kuechenbuch/1.0 (local personal recipe application)"})
        try:
            with urlopen(request, timeout=15) as response:
                data = json.loads(response.read().decode("utf-8"))
            products = []
            for product in data.get("products", []):
                name = (product.get("product_name") or "").strip()
                nutrients = product.get("nutriments") or {}
                kcal = nutrients.get("energy-kcal_100g")
                if not name or not isinstance(kcal, (int, float)) or not 0 <= kcal <= 900:
                    continue
                products.append((name, nutrients))
            if not products:
                self.send_json(404, {"error": f"Für „{query}“ wurden keine belastbaren Nährwerte gefunden."})
                return

            nutrient_keys = {
                "energyKj": ("energy-kj_100g", 0, 4000),
                "energyKcal": ("energy-kcal_100g", 0, 900),
                "fat": ("fat_100g", 0, 100),
                "saturates": ("saturated-fat_100g", 0, 100),
                "carbs": ("carbohydrates_100g", 0, 100),
                "sugars": ("sugars_100g", 0, 100),
                "protein": ("proteins_100g", 0, 100),
                "salt": ("salt_100g", 0, 25),
                "fiber": ("fiber_100g", 0, 100),
            }
            averaged = {}
            for output_key, (source_key, minimum, maximum) in nutrient_keys.items():
                values = [
                    nutrients[source_key]
                    for _, nutrients in products
                    if isinstance(nutrients.get(source_key), (int, float))
                    and minimum <= nutrients[source_key] <= maximum
                ]
                averaged[output_key] = round(statistics.mean(values), 2) if values else None
            if averaged["energyKj"] is None and averaged["energyKcal"] is not None:
                averaged["energyKj"] = round(averaged["energyKcal"] * 4.184, 1)

            result = {
                "query": query,
                "nutrition": averaged,
                "sampleCount": len(products),
                "matches": [name for name, _ in products[:4]],
                "source": "Open Food Facts – Durchschnitt passender Produkte",
            }
            cache[cache_key] = result
            NUTRITION_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary_file = NUTRITION_CACHE_FILE.with_suffix(".json.tmp")
            temporary_file.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary_file, NUTRITION_CACHE_FILE)
            self.send_json(200, result)
        except HTTPError as error:
            status = 429 if error.code == 429 else 502
            message = "Zu viele Suchanfragen. Bitte etwa eine Minute warten." if status == 429 else "Die Nährwertsuche ist momentan nicht erreichbar."
            self.send_json(status, {"error": message})
        except (URLError, TimeoutError, json.JSONDecodeError, OSError):
            self.send_json(502, {"error": "Die Nährwertsuche ist momentan nicht erreichbar."})

    def lookup_product(self, barcode):
        if not re.fullmatch(r"\d{8,14}", barcode):
            self.send_json(400, {"error": "Bitte einen gültigen Barcode mit 8 bis 14 Ziffern eingeben."})
            return

        fields = (
            "code,product_name,product_name_de,brands,ingredients_text,ingredients_text_de,"
            "image_front_small_url,nutriments_energy-kcal_100g,nutriments_energy_100g,"
            "nutriments_fat_100g,nutriments_saturated-fat_100g,nutriments_carbohydrates_100g,"
            "nutriments_sugars_100g,nutriments_proteins_100g,nutriments_salt_100g,nutriments_fiber_100g"
        )
        url = f"https://world.openfoodfacts.org/api/v3.6/product/{quote(barcode)}.json?fields={fields}&lc=de"
        request = Request(
            url,
            headers={"User-Agent": "Kuechenbuch/1.0 (local personal recipe application)"},
        )
        try:
            with urlopen(request, timeout=12) as response:
                data = json.loads(response.read().decode("utf-8"))
            if data.get("status") != "success" or not data.get("product"):
                self.send_json(404, {"error": "Dieses Produkt wurde bei Open Food Facts nicht gefunden."})
                return
            product = data["product"]
            nutrients = (
                product.get("nutrition", {})
                .get("aggregated_set", {})
                .get("nutrients", {})
            )

            def nutrient_value(name):
                item = nutrients.get(name, {})
                return item.get("value") if isinstance(item, dict) else None

            self.send_json(200, {
                "barcode": barcode,
                "name": product.get("product_name_de") or product.get("product_name") or f"Produkt {barcode}",
                "brand": product.get("brands") or "",
                "ingredientText": product.get("ingredients_text_de") or product.get("ingredients_text") or "",
                "image": product.get("image_front_small_url") or "",
                "nutrition": {
                    "energyKj": nutrient_value("energy-kj") or nutrient_value("energy"),
                    "energyKcal": nutrient_value("energy-kcal"),
                    "fat": nutrient_value("fat"),
                    "saturates": nutrient_value("saturated-fat"),
                    "carbs": nutrient_value("carbohydrates"),
                    "sugars": nutrient_value("sugars"),
                    "protein": nutrient_value("proteins"),
                    "salt": nutrient_value("salt"),
                    "fiber": nutrient_value("fiber"),
                },
                "source": "Open Food Facts",
            })
        except HTTPError as error:
            status = 404 if error.code == 404 else 502
            self.send_json(status, {"error": "Produktdaten konnten nicht geladen werden."})
        except (URLError, TimeoutError, json.JSONDecodeError):
            self.send_json(502, {"error": "Open Food Facts ist momentan nicht erreichbar."})

    def do_PUT(self):
        if urlparse(self.path).path != "/api/recipes":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Ungültige Anfragegröße"})
            return

        if length <= 0 or length > MAX_REQUEST_SIZE:
            self.send_json(413, {"error": "Die Rezeptdatei ist zu groß oder leer"})
            return

        try:
            recipes = json.loads(self.rfile.read(length).decode("utf-8"))
            self.validate_recipes(recipes)
            DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary_file = DATA_FILE.with_suffix(".json.tmp")
            temporary_file.write_text(
                json.dumps(recipes, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(temporary_file, DATA_FILE)
            self.send_json(200, {"saved": True, "count": len(recipes)})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json(400, {"error": str(error)})
        except OSError as error:
            self.send_json(500, {"error": f"Rezeptdatei konnte nicht gespeichert werden: {error}"})

    def do_POST(self):
        if urlparse(self.path).path != "/api/image":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Ungültige Dateigröße"})
            return
        if length <= 0 or length > MAX_IMAGE_SIZE:
            self.send_json(413, {"error": "Das Bild ist leer oder größer als 8 MB."})
            return

        image_data = self.rfile.read(length)
        extension = self.detect_image_extension(image_data)
        if not extension:
            self.send_json(415, {"error": "Erlaubt sind JPG-, PNG-, WebP- und GIF-Bilder."})
            return
        try:
            image_directory = ROOT / "images"
            image_directory.mkdir(parents=True, exist_ok=True)
            filename = f"recipe-{uuid.uuid4().hex}.{extension}"
            image_path = image_directory / filename
            image_path.write_bytes(image_data)
            self.send_json(201, {"path": f"images/{filename}"})
        except OSError as error:
            self.send_json(500, {"error": f"Bild konnte nicht gespeichert werden: {error}"})

    @staticmethod
    def detect_image_extension(data):
        if data.startswith(b"\xff\xd8\xff"):
            return "jpg"
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "png"
        if data.startswith((b"GIF87a", b"GIF89a")):
            return "gif"
        if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "webp"
        return None

    @staticmethod
    def validate_recipes(recipes):
        if not isinstance(recipes, list):
            raise ValueError("Die Rezeptdaten müssen eine Liste sein")
        required = {"id", "title", "category", "ingredients", "instructions", "links", "image"}
        categories = {"Vorspeise", "Hauptspeise", "Nachspeise"}
        for recipe in recipes:
            if not isinstance(recipe, dict) or not required.issubset(recipe):
                raise ValueError("Ein Rezept ist unvollständig")
            if recipe["category"] not in categories:
                raise ValueError("Ein Rezept enthält eine ungültige Kategorie")
            if not isinstance(recipe["ingredients"], list) or not isinstance(recipe["links"], list):
                raise ValueError("Zutaten und Links müssen Listen sein")


def main():
    parser = argparse.ArgumentParser(description="Küchenbuch lokal starten")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), RecipeHandler)
    print(f"Küchenbuch läuft auf http://127.0.0.1:{args.port}", flush=True)
    print(f"Rezepte werden gespeichert in: {DATA_FILE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
