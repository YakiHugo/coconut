import json
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from scripts.bilibili_browser_session import read_session
from scripts import public_video_caption_guard as guard


class BrowserSessionTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp required')
    def test_only_authentication_rows_are_decrypted_and_database_stays_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory, 'Cookies')
            connection = sqlite3.connect(database)
            connection.execute('CREATE TABLE meta (key TEXT,value TEXT)')
            connection.execute("INSERT INTO meta VALUES ('version','24')")
            connection.execute('CREATE TABLE cookies (host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER)')
            rows = [('.bilibili.com', 'SESSDATA', '', b'v10session', '/', 0, 1),
                    ('.bilibili.com', 'bili_jct', '', b'v10csrf', '/', 0, 1),
                    ('.bilibili.com', 'DedeUserID', 'old-user', b'', '/', 1, 1),
                    ('.example.com', 'SESSDATA', '', b'do-not-decrypt', '/', 0, 1),
                    ('.bilibili.com.evil.invalid', 'SESSDATA', '', b'do-not-decrypt', '/', 0, 1),
                    ('.bilibili.com', 'unrelated', '', b'do-not-decrypt', '/', 0, 1),
                    ('.bilibili.com', 'SESSDATA', '', b'do-not-decrypt', '/other', 0, 1)]
            connection.executemany('INSERT INTO cookies VALUES (?,?,?,?,?,?,?)', rows)
            connection.commit();connection.close()
            before = database.read_bytes()
            seen = []
            class Decryptor:
                def decrypt(self, value):
                    seen.append(value)
                    return {'v10session': 'fixture-session', 'v10csrf': 'fixture-csrf'}[value.decode()]
            result = read_session(database, lambda version: Decryptor())
            self.assertEqual(result, {'status': 'ready', 'cookies': {'SESSDATA': 'fixture-session', 'bili_jct': 'fixture-csrf'}})
            self.assertEqual(seen, [b'v10session', b'v10csrf'])
            self.assertEqual(database.read_bytes(), before)

    def test_cookie_injection_is_restricted_to_validated_bilibili_origins(self):
        import io
        transport = guard.VideoTransport('https://www.bilibili.com/video/BV1xx411c7mD', bilibili_cookies={'SESSDATA': 'fixture-session'})
        class Response:
            status = 200
            headers = {}
            def __init__(self): self.body = io.BytesIO(b'{"code":0,"data":{}}')
            def read(self, size): return self.body.read(size)
            def __enter__(self): return self
            def __exit__(self, *args): pass
        urls = ['https://api.bilibili.com/x/player/wbi/v2?aid=1&cid=2',
                'https://aisubtitle.hdslb.com/bfs/subtitle/fixture.json']
        for url in urls:
            with patch.object(transport.opener, 'open', return_value=Response()) as opened:
                transport.send(SimpleNamespace(url=url, method='GET', data=None, headers={}))
                self.assertEqual(opened.call_args.args[0].get_header('Cookie'), 'SESSDATA=fixture-session' if 'api.bilibili.com/' in url else None)
        with self.assertRaises(guard.StopProof):
            transport.send(SimpleNamespace(url=urls[0], method='GET', data=None, headers={'Cookie':'arbitrary=forbidden'}))
        for cookies in ({'SESSDATA':'bad\r\nheader'}, {'SESSDATA':'good','unknown':'bad'}, {'SESSDATA':'bad;other=bad'}):
            with self.assertRaises(guard.StopProof):
                guard.VideoTransport('https://www.bilibili.com/video/BV1xx411c7mD', bilibili_cookies=cookies)
        with self.assertRaises(guard.StopProof):
            guard.VideoTransport('https://www.youtube.com/watch?v=BaW_jenozKc', bilibili_cookies={'SESSDATA':'fixture'})

    @unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp required')
    def test_extractor_can_observe_connected_session_without_exposing_it_in_result(self):
        import yt_dlp
        transport = guard.VideoTransport('https://www.bilibili.com/video/BV1xx411c7mD', bilibili_cookies={'SESSDATA':'fixture-session'})
        with guard.guarded_extractors(transport):
            with yt_dlp.YoutubeDL({'quiet':True}) as downloader:
                extractor = downloader.get_info_extractor('BiliBili')
                self.assertEqual(extractor._get_cookies('https://api.bilibili.com')['SESSDATA'].value, 'fixture-session')
                self.assertNotIn('SESSDATA', extractor._get_cookies('https://aisubtitle.hdslb.com'))


if __name__ == '__main__':
    unittest.main()
