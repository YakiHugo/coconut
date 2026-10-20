"""Generate a two-second authored sine-wave M4A for browser protocol tests only."""
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
target=Path('tests/fixtures/authored-video-audio.m4a')
target.parent.mkdir(parents=True,exist_ok=True)
with av.open(buffer,format='wav') as source,av.open(str(target),'w',format='mp4') as output:
    stream=output.add_stream('aac',rate=rate)
    stream.layout='mono'
    resampler=av.AudioResampler(format='fltp',layout='mono',rate=rate)
    for frame in source.decode(audio=0):
        for ready in resampler.resample(frame):
            for packet in stream.encode(ready): output.mux(packet)
    for ready in resampler.resample(None):
        for packet in stream.encode(ready): output.mux(packet)
    for packet in stream.encode(None): output.mux(packet)
body=target.read_bytes()
assert 12<len(body)<64000 and body[4:8]==b'ftyp'
print('COCONUT_AUTHORED_M4A '+json.dumps({'path':str(target),'bytes':len(body),'data':base64.b64encode(body).decode()}))
