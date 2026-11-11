"""Isolierter Browsertest. Führt keine Cloud-Aufrufe aus und verwendet nur temporäre Rezeptdaten."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]

def main():
    spec = importlib.util.spec_from_file_location('kochbuch_server', ROOT / 'server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='kochbuch-test-') as directory:
        folder = Path(directory)
        (folder / 'data').mkdir()
        (folder / 'data/recipes.json').write_text('[]')
        html = (ROOT / 'index.html').read_text()
        html = html.replace('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>', '')
        import re
        html = re.sub(r'<link[^>]+https://fonts[^>]+>', '', html)
        html = html.replace('</body>', '<script src="part1.js"></script></body>')
        (folder / 'index.html').write_text(html)
        (folder / 'styles.css').write_text((ROOT / 'styles.css').read_text())
        (folder / 'app.js').write_text((ROOT / 'app.js').read_text().replace('\ninitialize();', '\n'))
        (folder / 'part1.js').write_text((ROOT / 'tests/part1.js').read_text())
        (folder / 'legacy-fixtures.json').write_text((ROOT / 'data/recipes.json').read_text())
        (folder / 'reload.html').write_text(html.replace('<script src="part1.js"></script>', '<script>initialize().then(() => { document.body.dataset.favorite = String(recipes[0]?.favorite); });</script>'))
        module.ROOT = folder
        module.DATA_FILE = folder / 'data/recipes.json'
        report_ready = threading.Event()
        reports = []
        class TestHandler(module.RecipeHandler):
            def do_POST(self):
                if self.path == '/test-result':
                    reports.append(self.rfile.read(int(self.headers['Content-Length'])).decode())
                    self.send_json(200, {'ok': True})
                    report_ready.set()
                else:
                    super().do_POST()
        server = ThreadingHTTPServer(('127.0.0.1', 0), TestHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}'
        try:
            for endpoint in ('/api/product?barcode=12345678', '/api/ingredient?query=mehl'):
                try:
                    urllib.request.urlopen(url + endpoint)
                    raise AssertionError('Obsoleter Endpunkt weiterhin vorhanden')
                except urllib.error.HTTPError as error:
                    assert error.code == 404
            request = urllib.request.Request(url+'/api/image', data=b'\x89PNG\r\n\x1a\nTEST', headers={'Content-Type':'image/png'})
            result = json.load(urllib.request.urlopen(request))
            assert (folder / result['path']).exists()
            chrome = os.environ.get('CHROME_PATH', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
            browser = subprocess.Popen([chrome, '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', f'--user-data-dir={folder / "chrome-profile"}', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                assert report_ready.wait(30), 'Browser lieferte kein Testergebnis'
                print(reports[0])
                assert reports[0].startswith('PASS'), 'Browsertest fehlgeschlagen'
            finally:
                browser.terminate()
                try:
                    browser.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    browser.kill()
                    browser.wait()
            print('PASS: entfernte Python-Endpunkte, Bild-Upload und isolierte lokale Speicherung')
        finally:
            server.shutdown()
            server.server_close()

if __name__ == '__main__':
    main()
