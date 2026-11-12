"""Gesamtregression: ausschließlich isolierte Daten, keine produktiven Schreibzugriffe."""
from pathlib import Path
import subprocess
import sys

if __name__ == '__main__':
    for script in ['test_part1.py', 'test_part2.py', 'test_part3.py', 'test_public_access.py']:
        subprocess.run([sys.executable, str(Path(__file__).with_name(script))], check=True)
    print('Alle Testsuiten erfolgreich abgeschlossen.')
