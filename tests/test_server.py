import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from serve import build_server

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.server,self.jobs=build_server(Path(self.temp.name),0)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.jobs.close();self.thread.join();self.temp.cleanup()
    def test_actual_upload_to_readable_document(self):
        request=Request(self.base+'/api/uploads?filename=test.srt', data=b'1\n00:00:01,000 --> 00:00:02,000\nHello Coconut\n',headers={'Content-Type':'application/octet-stream'})
        with urlopen(request) as response: job=json.load(response)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            with urlopen(self.base+'/api/jobs/'+job['id']) as response: current=json.load(response)
            if current['status'] in ('done','failed'):break
            time.sleep(.02)
        self.assertEqual(current['status'],'done')
        with urlopen(self.base+'/api/jobs/'+job['id']+'/result') as response: doc=json.load(response)
        self.assertEqual(doc['segments'][0]['text'],'Hello Coconut')
    def test_cross_origin_and_unscoped_host_rejected(self):
        for headers in [{'Origin':'https://evil.example'},{'Host':'evil.example'}]:
            with self.assertRaises(HTTPError) as error:urlopen(Request(self.base+'/api/jobs',headers=headers))
            self.assertEqual(error.exception.code,403)
    def test_path_traversal_not_served(self):
        with self.assertRaises(HTTPError) as error:urlopen(self.base+'/../serve.py')
        self.assertEqual(error.exception.code,404)
    def test_invalid_source_rejected(self):
        req=Request(self.base+'/api/jobs',data=b'{"url":"http://127.0.0.1/private"}',headers={'Content-Type':'application/json'})
        with self.assertRaises(HTTPError) as error:urlopen(req)
        self.assertEqual(error.exception.code,400)
