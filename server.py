#!/usr/bin/env python3
"""Lokaler Küchenbuch-Server mit dateibasierter Rezeptspeicherung."""

import argparse
import json
import os
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "recipes.json"
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
        super().do_GET()

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
