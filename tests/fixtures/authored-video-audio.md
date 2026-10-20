# Authored video-audio fixture

`authored-video-audio.m4a` is a two-second 440 Hz sine wave created for Coconut's browser protocol tests. It contains no platform media or speech. It was generated with `scripts/create_authored_m4a.py` using official PyAV 16.1.0. The committed fixture allows ordinary browser tests to run without installing an audio encoder. It is never counted as evidence of real YouTube, Bilibili, Xiaoyuzhou or ASR success.
