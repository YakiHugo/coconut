"""Opt-in metadata-only diagnosis; unchanged public guard, no media or ASR."""
import json
import re
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scripts.public_video_caption_guard import extract_public_video_captions, source_identity
import subtitle_import

def safe(value):
    text=re.sub(r'https?://\S+','[url]',str(value))
    text=re.sub(r'(?:/[A-Za-z0-9_.-]+){2,}','[path]',text)
    return re.sub(r'[A-Za-z0-9_-]{32,}','[identifier]',text)[:300]

def main():
    if len(sys.argv)!=4 or sys.argv[1]!='--live':
        raise SystemExit('Explicit --live CANONICAL_URL LANGUAGE required')
    url,language=sys.argv[2:]
    provider,identity=source_identity(url)
    report={'check':'public_caption_diagnostic','source_url':url,'provider':provider,
            'media_attempted':False,'asr_attempted':False,'warnings':[]}
    original_logger=subtitle_import.CaptionLogger
    class Logger(original_logger):
        def warning(self,message):
            if len(report['warnings'])<4:report['warnings'].append(safe(message))
            # Preserve the original warning list and therefore its fail-closed gate.
            self.warnings.append(str(message))
    original_select=subtitle_import.select_track
    def select(info,hint=None):
        report['metadata']={'identity_matches':str(info.get('id',''))==identity,
            'type':info.get('_type','video'),'duration':info.get('duration'),
            'format_count':len(info.get('formats') or []),
            'subtitle_track_count':len(info.get('subtitles') or {}),
            'automatic_track_count':len(info.get('automatic_captions') or {})}
        return original_select(info,hint)
    original_fetch=subtitle_import.fetch_subtitle_document
    def fetch(*args,**kwargs):
        try:return original_fetch(*args,**kwargs)
        except Exception as error:
            report['exception']={'type':type(error).__name__,'message':safe(error)}
            raise
    with patch.object(subtitle_import,'CaptionLogger',Logger),patch.object(subtitle_import,'select_track',select),patch.object(subtitle_import,'fetch_subtitle_document',fetch):
        result=extract_public_video_captions(url,language)
    report['outcome']={key:result[key] for key in ('status','diagnostic') if key in result}
    report['caption_ready']='source' in result
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
