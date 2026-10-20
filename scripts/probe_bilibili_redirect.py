"""Read-only diagnostic for one known Bilibili redirect; never follows it."""
import json
import ssl
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse
import certifi
from scripts.public_video_caption_guard import PublicHTTPSHandler, StopProof, NoRedirect

URL = 'https://www.bilibili.com/video/BV12N4y1M7rh'

def main():
    if sys.argv[1:] != ['--live']:
        raise SystemExit('Explicit --live required')
    report = {'check': 'bilibili_redirect_target', 'followed': False, 'requests': 1}
    class InspectRedirect(NoRedirect):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            target = urlparse(newurl)
            source = urlparse(URL)
            report.update(http_status=code, target_kind='same_video_canonical_slash'
                if target.scheme == 'https' and target.netloc == source.netloc
                and target.path == source.path + '/' and not target.query and not target.fragment
                else 'other_stopped')
            raise StopProof('redirect_stopped')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), InspectRedirect(),
        PublicHTTPSHandler(context=ssl.create_default_context(cafile=certifi.where())))
    request = urllib.request.Request(URL, headers={'User-Agent': 'Coconut-public-captions/1.0', 'Accept-Encoding': 'identity'})
    try:
        with opener.open(request, timeout=15) as response:
            report.update(http_status=response.status, target_kind='no_redirect')
    except StopProof:
        pass
    except urllib.error.HTTPError as error:
        report.update(http_status=error.code, target_kind='http_error')
        error.close()
    except (urllib.error.URLError, OSError):
        report.update(target_kind='transport_unavailable')
    print(json.dumps(report, sort_keys=True))

if __name__ == '__main__':
    main()
