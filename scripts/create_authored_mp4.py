"""Generate authored 2-second black H.264 video with a 440 Hz tone, never platform evidence."""
import array
import base64
import io
import json
import math
from pathlib import Path
import wave
import av

rate=16000
samples=array.array('h',(int(2000*math.sin(2*math.pi*440*index/rate)) for index in range(2*rate)))
buffer=io.BytesIO()
with wave.open(buffer,'wb') as wav:
    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(rate);wav.writeframes(samples.tobytes())
buffer.seek(0)
target=Path('tests/fixtures/authored-source-video.mp4')
target.parent.mkdir(parents=True,exist_ok=True)
with av.open(buffer,format='wav') as source,av.open(str(target),'w',format='mp4') as output:
    video=output.add_stream('libx264',rate=10)
    video.width=160;video.height=96;video.pix_fmt='yuv420p'
    audio=output.add_stream('aac',rate=rate);audio.layout='mono'
    for index in range(20):
        frame=av.VideoFrame(160,96,'yuv420p')
        for number,plane in enumerate(frame.planes): plane.update(bytes([16 if number==0 else 128])*plane.buffer_size)
        frame.pts=index
        for packet in video.encode(frame): output.mux(packet)
    for packet in video.encode(None): output.mux(packet)
    resampler=av.AudioResampler(format='fltp',layout='mono',rate=rate)
    for frame in source.decode(audio=0):
        for ready in resampler.resample(frame):
            for packet in audio.encode(ready): output.mux(packet)
    for ready in resampler.resample(None):
        for packet in audio.encode(ready): output.mux(packet)
    for packet in audio.encode(None): output.mux(packet)
body=target.read_bytes()
assert 12<len(body)<128000 and body[4:8]==b'ftyp'
print('COCONUT_AUTHORED_MP4 '+json.dumps({'path':str(target),'bytes':len(body),'data':base64.b64encode(body).decode()}))
