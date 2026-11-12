"""Isolierter Browsertest. Führt keine Cloud-Aufrufe aus und verwendet nur temporäre Rezeptdaten."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import shutil
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]

def main(test_script="part1.js"):
    spec = importlib.util.spec_from_file_location('kochbuch_server', ROOT / 'server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='kochbuch-test-') as directory:
        folder = Path(directory)
        (folder / 'data').mkdir()
        (folder / 'data/recipes.json').write_text('[]')
        shutil.copytree(ROOT / 'vendor', folder / 'vendor')
        for asset in ['backup.js', 'backup-ui.js', 'drafts.js']:
            shutil.copyfile(ROOT / asset, folder / asset)
        backup_check = os.environ.get('KOCHBUCH_BACKUP_CHECK')
        if test_script == 'public-access.js' and backup_check:
            shutil.copyfile(backup_check, folder / 'source-backup.zip')
        html = (ROOT / 'index.html').read_text()
        html = html.replace('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>', '')
        import re
        html = re.sub(r'<link[^>]+https://fonts[^>]+>', '', html)
        html = html.replace('</body>', '<script src="part1.js"></script></body>')
        (folder / 'index.html').write_text(html)
        (folder / 'styles.css').write_text((ROOT / 'styles.css').read_text())
        (folder / 'app.js').write_text((ROOT / 'app.js').read_text().replace('\ninitialize();', '\n'))
        (folder / 'part1.js').write_text((ROOT / 'tests' / test_script).read_text())
        (folder / 'legacy-fixtures.json').write_text((ROOT / 'data/recipes.json').read_text())
        (folder / 'reload.html').write_text(html.replace('<script src="part1.js"></script>', '<script>initialize().then(() => { document.body.dataset.favorite = String(recipes[0]?.favorite); });</script>'))
        module.ROOT = folder
        module.DATA_FILE = folder / 'data/recipes.json'
        report_ready = threading.Event()
        reports = []
        class TestHandler(module.RecipeHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                if self.path == '/test-pdf':
                    (folder / 'pdf-test.html').write_bytes(self.rfile.read(int(self.headers['Content-Length'])))
                    self.send_json(200, {'ok': True})
                elif self.path == '/test-export':
                    (folder / 'exported.zip').write_bytes(self.rfile.read(int(self.headers['Content-Length'])))
                    self.send_json(200, {'ok': True})
                elif self.path == '/test-result':
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
            for headers, method in [({'Origin':'https://fremde-seite.invalid'}, 'PUT'), ({'Host':'fremde-seite.invalid'}, 'GET')]:
                request = urllib.request.Request(url+'/api/recipes', data=b'[]' if method=='PUT' else None, method=method, headers=headers)
                try:
                    urllib.request.urlopen(request)
                    raise AssertionError('Fremde lokale Anfrage wurde zugelassen')
                except urllib.error.HTTPError as error:
                    assert error.code == 403
            assert json.loads(module.DATA_FILE.read_text()) == []
            module.DATA_FILE.write_text('')
            try:
                urllib.request.urlopen(url+'/api/recipes')
                raise AssertionError('Leere beschädigte Datei wurde als gültige Sammlung gelesen')
            except urllib.error.HTTPError as error:
                assert error.code == 500
            finally:
                module.DATA_FILE.write_text('[]')
            moved_file = folder / 'data' / 'recipes.saved'
            module.DATA_FILE.rename(moved_file)
            try:
                assert json.load(urllib.request.urlopen(url+'/api/recipes')) == []
            finally:
                moved_file.rename(module.DATA_FILE)
            request = urllib.request.Request(url+'/api/image', data=b'\x89PNG\r\n\x1a\nTEST', headers={'Content-Type':'image/png'})
            result = json.load(urllib.request.urlopen(request))
            assert (folder / result['path']).exists()
            chrome = os.environ.get('CHROME_PATH', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
            browser = subprocess.Popen([chrome, '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', f'--user-data-dir={folder / "chrome-profile"}', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                assert report_ready.wait(60), 'Browser lieferte kein Testergebnis'
                print(reports[0])
                if test_script == 'part2.js':
                    import zipfile, hashlib
                    with zipfile.ZipFile(folder / 'exported.zip') as archive:
                        assert archive.testzip() is None
                        manifest = json.loads(archive.read('manifest.json'))
                        assert manifest['imageCount'] == 2
                        for image in manifest['images']:
                            content = archive.read(image['path'])
                            assert hashlib.sha256(content).hexdigest() == image['sha256']
                    print('PASS: ZIP unabhängig mit Python zipfile und SHA-256 geprüft')
                assert reports[0].startswith('PASS'), 'Browsertest fehlgeschlagen'
                if test_script == 'part3.js':
                    from browser_tools import BrowserTools
                    import base64, time
                    qa = Path('/tmp/kochbuch-qa')
                    qa.mkdir(exist_ok=True)
                    browser_tools = BrowserTools(folder / 'chrome-profile')
                    for width in [320, 375, 768, 1280]:
                        browser_tools.call('Emulation.setDeviceMetricsOverride', width=width, height=900, deviceScaleFactor=1, mobile=width < 600)
                        for layout in ['collection', 'editor', 'editor-ingredients', 'editor-nutrition', 'detail', 'detail-ingredients']:
                            browser_tools.evaluate('prepareLayout(' + json.dumps(layout.split('-')[0]) + ')')
                            time.sleep(.12)  # Let delayed editor autofocus finish before scrolling.
                            target = {'collection':'#collection', 'editor-ingredients':'.ingredient-editor', 'editor-nutrition':'.nutrition-panel', 'detail-ingredients':'.recipe-parts-detail'}.get(layout)
                            if target:
                                browser_tools.evaluate('document.querySelector('+json.dumps(target)+').scrollIntoView({block:"start",behavior:"instant"})')
                            time.sleep(.1)
                            screenshot = browser_tools.call('Page.captureScreenshot', format='png')
                            (qa / f'{width}-{layout}.png').write_bytes(base64.b64decode(screenshot['data']))
                    browser_tools.call('Page.navigate', url=url+'/pdf-test.html')
                    for _ in range(100):
                        if browser_tools.evaluate('document.readyState') == 'complete':
                            break
                        time.sleep(.05)
                    pdf = browser_tools.call('Page.printToPDF', printBackground=True, preferCSSPageSize=True)
                    (qa / 'kochbuch-print-test.pdf').write_bytes(base64.b64decode(pdf['data']))
                    assert (qa / 'kochbuch-print-test.pdf').read_bytes().startswith(b'%PDF-')
                    browser_tools.socket.close()
                    print('PASS: 24 echte Chrome-Screenshots und tatsächliche PDF-Ausgabe unter /tmp/kochbuch-qa')

            finally:
                browser.terminate()
                try:
                    browser.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    browser.kill()
                    browser.wait()
            print('PASS: entfernte Python-Endpunkte, Bild-Upload, lokale Speicherung sowie Origin-/Host-Schutz')
        finally:
            server.shutdown()
            server.server_close()

if __name__ == '__main__':
    main()
