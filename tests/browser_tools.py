"""Small dependency-free CDP client used only by isolated Chrome QA."""
import base64
import json
import os
import socket
import struct
import urllib.request
from pathlib import Path
import time

class BrowserTools:
    def __init__(self, profile):
        port_file = Path(profile) / 'DevToolsActivePort'
        for _ in range(100):
            if port_file.exists():
                break
            time.sleep(.05)
        port = int(port_file.read_text().splitlines()[0])
        tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
        target = next(tab for tab in tabs if tab.get('type') == 'page')
        from urllib.parse import urlparse
        url = urlparse(target['webSocketDebuggerUrl'])
        self.socket = socket.create_connection((url.hostname, url.port), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall((f'GET {url.path} HTTP/1.1\r\nHost: {url.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        header = b''
        while not header.endswith(b'\r\n\r\n'):
            header += self.socket.recv(1)
        assert b'101' in header.split(b'\r\n')[0], header
        self.counter = 0

    def read(self, length):
        data = b''
        while len(data) < length:
            chunk = self.socket.recv(length-len(data))
            if not chunk:
                raise RuntimeError('CDP-Verbindung geschlossen')
            data += chunk
        return data

    def send(self, payload, opcode=1):
        mask = os.urandom(4)
        size = len(payload)
        length = bytes([0x80|size]) if size < 126 else b'\xfe'+struct.pack('!H', size) if size < 65536 else b'\xff'+struct.pack('!Q', size)
        self.socket.sendall(bytes([0x80|opcode])+length+mask+bytes(byte^mask[i%4] for i,byte in enumerate(payload)))

    def receive(self):
        result = b''
        while True:
            first, second = self.read(2)
            size = second & 127
            if size == 126:
                size = struct.unpack('!H', self.read(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.read(8))[0]
            mask = self.read(4) if second & 128 else None
            data = self.read(size)
            if mask:
                data = bytes(byte^mask[i%4] for i,byte in enumerate(data))
            if first & 15 == 9:
                self.send(data,10)
                continue
            if first & 15 == 8:
                raise RuntimeError('CDP beendet')
            result += data
            if first & 128:
                return json.loads(result)

    def call(self, method, **params):
        self.counter += 1
        self.send(json.dumps({'id':self.counter,'method':method,'params':params}).encode())
        while True:
            result = self.receive()
            if result.get('id') == self.counter:
                if 'error' in result:
                    raise RuntimeError(result['error'])
                return result.get('result',{})

    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', expression=expression, awaitPromise=True, returnByValue=True)
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result',{}).get('value')
