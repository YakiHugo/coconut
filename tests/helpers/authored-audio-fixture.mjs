/** Tone-only PCM WAV, shared by browser acceptance. No recording or model. */
export function authoredAudioFixture(seconds = 180) {
  const rate = 8000, bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const cycle = Buffer.alloc(160);
  for (let i = 0; i < 80; i++) cycle.writeInt16LE(Math.round(500 * Math.sin(2 * Math.PI * i / 80)), i * 2);
  for (let offset = 44; offset < bytes.length; offset += cycle.length) cycle.copy(bytes, offset, 0, Math.min(cycle.length, bytes.length - offset));
  return bytes;
}
