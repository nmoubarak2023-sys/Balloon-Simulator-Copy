import test from 'node:test';
import assert from 'node:assert/strict';
import { frameCount, encodeWebM } from '../src/process-video.js';
test('offline video sampling retains 30 fps regardless of rendering speed', () => {
  assert.equal(frameCount(3000), 90);
  assert.equal(frameCount(600), 18);
  assert.equal(frameCount(1), 1);
});
test('WebM export declares native 4K dimensions and keeps long timeline clusters', async () => {
  const blob = encodeWebM([{time:0,data:new Uint8Array([1,2])},
    {time:31000,data:new Uint8Array([3,4])}],3840,2160,31034);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0,4)], [0x1a,0x45,0xdf,0xa3]);
  const hex = Buffer.from(bytes).toString('hex');
  assert.ok(hex.includes('b0820f00')); // PixelWidth 3840
  assert.ok(hex.includes('ba820870')); // PixelHeight 2160
  assert.equal(hex.split('1f43b675').length-1, 2);
  assert.ok(new TextDecoder().decode(bytes).includes('V_VP8'));
});
