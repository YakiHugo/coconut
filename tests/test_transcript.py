import unittest
from transcript import make_document, to_markdown, source_link

class TranscriptTests(unittest.TestCase):
    def test_timestamps_and_speaker_survive_export(self):
        d = make_document({'segments':[{'start':61.5,'end':64,'text':' 原话 ','speaker':'SPEAKER_00'}]},'访谈','https://www.youtube.com/watch?v=abc&t=9')
        self.assertEqual(d['segments'][0]['start'],61.5)
        self.assertIn('[01:01](https://www.youtube.com/watch?v=abc&t=61)',to_markdown(d))
        self.assertIn('SPEAKER_00',to_markdown(d))
    def test_invalid_timestamps_do_not_silently_corrupt_links(self):
        for start,end in [(-1,2),(3,2),(float('nan'),4)]:
            with self.assertRaises(ValueError):make_document({'segments':[{'start':start,'end':end,'text':'x'}]},'x','')
    def test_no_script_url(self):
        self.assertEqual(source_link('javascript:alert(1)',2),'')
    def test_bilibili_preserves_part(self):
        self.assertEqual(source_link('https://www.bilibili.com/video/BVabc?p=2',12),'https://www.bilibili.com/video/BVabc?p=2&t=12')

if __name__=='__main__':unittest.main()
